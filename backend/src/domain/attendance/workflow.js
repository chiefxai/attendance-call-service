"use strict";

const { backoffMilliseconds } = require("../../infrastructure/database/postgres-queue");
const { createPostCallTools } = require("../../agents/post-call-tools");
const { createAppointmentBookingTools } = require("../../agents/appointment-booking-tools");
const { localDateTimeToUtc } = require("./local-time");

function classifyCallStatus(status) {
  const value = String(status || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (["completed", "answered", "inprogress"].includes(value)) return "answered";
  if (["noanswer", "busy", "failed", "unanswered", "timeout"].includes(value)) return "not_answered";
  return "unknown";
}

function normalizeCallbackTime(value, referenceDate = new Date()) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;

  const text = String(value).trim();
  const absolute = new Date(text);
  if (Number.isFinite(absolute.getTime()) && /\d{4}-\d{2}-\d{2}/.test(text)) return absolute;

  const relative = text.match(/(?:in\s+)?(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h)\b/i);
  if (!relative) return null;
  const amount = Number(relative[1]);
  const unit = relative[2].toLowerCase();
  const multiplier = unit.startsWith("h") ? 60 * 60_000 : 60_000;
  const runAt = new Date(referenceDate.getTime() + amount * multiplier);
  return Number.isFinite(runAt.getTime()) ? runAt : null;
}

function inferRequestedCallbackAt(transcript, referenceDate = new Date()) {
  const text = String(transcript || "");
  const numberWords = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    "ஒரு": 1, "ஒன்னு": 1, "ரெண்டு": 2, "இரண்டு": 2, "மூணு": 3, "மூன்று": 3, "நாலு": 4,
    "நான்கு": 4, "அஞ்சு": 5, "ஐந்து": 5, "ஆறு": 6, "ஏழு": 7, "எட்டு": 8, "ஒன்பது": 9, "பத்து": 10,
    "டூ": 2, "த்ரீ": 3, "ஃபைவ்": 5, "டென்": 10,
  };
  const number = "(\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|ஒரு|ஒன்னு|ரெண்டு|இரண்டு|மூணு|மூன்று|நாலு|நான்கு|அஞ்சு|ஐந்து|ஆறு|ஏழு|எட்டு|ஒன்பது|பத்து|டூ|த்ரீ|ஃபைவ்|டென்)";
  const match = text.match(new RegExp(`${number}\\s*(?:minutes?|mins?|minute|மினிட\\w*|நிமிஷ\\w*|நிமிட\\w*)`, "iu"));
  if (!match) return null;
  const amount = numberWords[match[1].toLowerCase()] || Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return new Date(referenceDate.getTime() + amount * 60_000).toISOString();
}

function validateReportedTime(value, now = new Date()) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "reported_time_invalid";
  return timestamp > now.getTime() ? "future_reported_time" : null;
}

function chooseAttendanceAction(stage, outcome = {}) {
  if (outcome.exceptionCode || outcome.employeeIntent === "wrong_assignment" || outcome.employeeIntent === "unclear") {
    return { action: "review", reason: outcome.exceptionCode || outcome.employeeIntent || "unclear" };
  }
  if (stage === "check_in") {
    if (outcome.employeeIntent === "arrival_confirmed" && outcome.employeeNameConfirmed === true && outcome.patientNameConfirmed === true && outcome.addressConfirmed === true && outcome.employeeVerified !== false && outcome.clientVerified !== false && outcome.reachedPatient === true && outcome.reportedArrivalTime) {
      return { action: "confirm_stage", reportedAt: outcome.reportedArrivalTime || null };
    }
    if (outcome.employeeIntent === "will_arrive_later" || outcome.requestedCallbackAt) {
      return { action: "follow_up", runAt: outcome.requestedCallbackAt || null };
    }
    return { action: "review", reason: "check_in_not_confirmed" };
  }
  if (stage === "check_out") {
    if (outcome.employeeIntent === "departure_confirmed" && outcome.employeeNameConfirmed === true && outcome.employeeVerified !== false && outcome.dutyComplete === true && outcome.reportedDepartureTime) {
      return { action: "confirm_stage", reportedAt: outcome.reportedDepartureTime || null };
    }
    if (outcome.employeeIntent === "still_on_duty" || outcome.requestedCallbackAt) {
      return { action: "follow_up", runAt: outcome.requestedCallbackAt || null };
    }
    return { action: "review", reason: "check_out_not_confirmed" };
  }
  return { action: "review", reason: "invalid_stage" };
}

function createAttendanceHandlers({ repository, queue, vobiz, recordings, transcriber, postCallAgent, backend, athulyaAttendanceClient = null, retry = {}, capacity = {}, additionalHandlers = {} }) {
  const required = { repository, queue, vobiz, recordings, transcriber, postCallAgent, backend };
  const missing = Object.entries(required).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`Attendance workflow dependencies required: ${missing.join(", ")}`);
  const taskFor = (session, stage) => stage === "check_in" ? session?.checkInTask : session?.checkOutTask;

  async function placeCall({ sessionId, taskId, stage, attemptNumber, capacityWaitCount = 0, consecutiveNoAnswer = 0 }) {
    const session = await repository.getAttendanceSession(sessionId);
    // Check-in and check-out are independent tasks. Exhausting check-in retries
    // must not close the shared assignment; only an explicit cancellation or a
    // fully completed session can suppress the later check-out call.
    if (!session || ["completed", "cancelled"].includes(session.sessionStatus)) return;
    const task = stage === "check_in" ? session.checkInTask : session.checkOutTask;
    if (!task || (taskId && task.id !== taskId)) return;
    const stageStatus = stage === "check_in" ? session.checkInStatus : session.checkOutStatus;
    if (["confirmed", "missed", "not_answered", "review"].includes(stageStatus)) return;
    const agent = await repository.getAgent(session.organizationId, session.agentId);
    if (!agent?.active) {
      await repository.setStageStatus(sessionId, stage, "review", { reason: "agent_missing_or_inactive" });
      throw new Error("The assigned calling agent is missing or inactive");
    }
    const attempt = await repository.createCallAttempt({
      organizationId: session.organizationId, sessionId, stage, attemptNumber,
      callTargetRole: "employee", scheduledAt: new Date(), consecutiveNoAnswer,
    });
    if (!attempt.shouldPlace || attempt.providerCallId || attempt.status !== "scheduled") {
      if (attempt.status === "placing" && !attempt.providerCallId) {
        await repository.setStageStatus(sessionId, stage, "review", { reason: "call_placement_reconciliation_required", callAttemptId: attempt.id });
      }
      return;
    }
    const reserved = await repository.reserveOutboundCallSlot({
      callAttemptId: attempt.id, organizationId: session.organizationId,
      maxConcurrentCalls: capacity.maxConcurrentCalls || 20,
      ttlMinutes: capacity.slotTtlMinutes || 180,
    });
    if (!reserved) {
      const nextWait = capacityWaitCount + 1;
      await queue.enqueue("place_call", { sessionId, taskId: task.id, stage, attemptNumber, capacityWaitCount: nextWait }, {
        idempotencyKey: `capacity:${sessionId}:${stage}:${attemptNumber}:${nextWait}`,
        runAt: new Date(Date.now() + (capacity.capacityPollMs || 2_000)),
      });
      return;
    }
    if (!await repository.markCallPlacing(attempt.id)) return;
    await repository.setStageStatus(sessionId, stage, "calling", { currentCallAttemptId: attempt.id, attemptNumber });
    const person = session.employee || {};
    try {
      const call = await vobiz.createCall({
        to: person.phoneNumber,
        from: agent.fromNumber || session.fromNumber,
        agentId: agent.id,
        sessionId,
        stage,
        callAttemptId: attempt.id,
      });
      const providerCallId = call.call_uuid || call.request_uuid;
      if (!providerCallId) throw new Error("Vobiz response did not include a call ID; reconcile before retrying");
      await repository.attachProviderCallId(attempt.id, providerCallId, call);
    } catch (error) {
      // A timeout may mean Vobiz accepted the request but its response was
      // lost. Do not blindly redial; mark the placement for reconciliation.
      await repository.markCallPlacementFailed(attempt.id, error.message);
      await repository.setStageStatus(sessionId, stage, "review", { reason: "call_placement_unknown", callAttemptId: attempt.id });
      throw error;
    }
  }

  async function processCallResult({ callAttemptId }) {
    const attempt = await repository.getCallAttempt(callAttemptId);
    if (!attempt) return;
    if (classifyCallStatus(attempt.status) === "not_answered") {
      const noAnswerCount = (attempt.consecutiveNoAnswerBefore || 0) + 1;
      const organizationSettings = repository.getOrganizationCallSettings
        ? await repository.getOrganizationCallSettings(attempt.organizationId)
        : {};
      const retrySettings = organizationSettings.callRetry || {};
      const initialMinutes = retrySettings.initialMinutes ?? retry.initialMinutes ?? 3;
      const multiplier = retrySettings.multiplier ?? retry.multiplier ?? 1.2;
      const maxMinutes = retrySettings.maxMinutes ?? retry.maxMinutes ?? 30;
      const maxConsecutiveNoAnswer = retrySettings.maxConsecutiveNoAnswer ?? retry.maxConsecutiveNoAnswer ?? 3;
      const config = { initialMs: initialMinutes * 60_000, multiplier, maxMs: maxMinutes * 60_000 };
      if (noAnswerCount >= maxConsecutiveNoAnswer) {
        await repository.setStageStatus(attempt.sessionId, attempt.stage, "not_answered", {
          reason: "consecutive_no_answer_limit_reached", consecutiveNoAnswer: noAnswerCount,
        });
        await queue.enqueue("evaluate_session", { sessionId: attempt.sessionId, stage: attempt.stage }, { idempotencyKey: `evaluate:${attempt.sessionId}:not-answered:${attempt.stage}` });
        return;
      }
      const runAt = new Date(Date.now() + backoffMilliseconds(attempt.attemptNumber, config));
      await repository.setStageStatus(attempt.sessionId, attempt.stage, "follow_up", { reason: "not_answered", nextCallAt: runAt.toISOString() });
      const session = await repository.getAttendanceSession(attempt.sessionId);
      await queue.enqueue("place_call", { sessionId: attempt.sessionId, taskId: taskFor(session, attempt.stage)?.id, stage: attempt.stage, attemptNumber: attempt.attemptNumber + 1, consecutiveNoAnswer: noAnswerCount }, {
        idempotencyKey: `call:${attempt.sessionId}:${attempt.stage}:${attempt.attemptNumber + 1}`, runAt,
      });
      return;
    }
    if (classifyCallStatus(attempt.status) !== "answered") return;
    if (!attempt.recordingUrl && !attempt.recordingObjectKey) {
      await queue.enqueue("wait_for_recording", { callAttemptId, pollNumber: 1 }, {
        idempotencyKey: `recording-wait:${callAttemptId}:1`,
        runAt: new Date(Date.now() + (retry.recordingWaitMs || 15_000)),
      });
      return;
    }
    await queue.enqueue("transcribe_call", { callAttemptId }, { idempotencyKey: `transcribe:${callAttemptId}` });
  }

  async function waitForRecording({ callAttemptId, pollNumber }) {
    const attempt = await repository.getCallAttempt(callAttemptId);
    if (!attempt) return;
    if (attempt.recordingUrl || attempt.recordingObjectKey) {
      await queue.enqueue("transcribe_call", { callAttemptId }, { idempotencyKey: `transcribe:${callAttemptId}` });
      return;
    }
    if (pollNumber >= (retry.recordingWaitMaxAttempts || 4)) {
      await repository.setStageStatus(attempt.sessionId, attempt.stage, "review", { reason: "recording_unavailable", callAttemptId });
        await queue.enqueue("evaluate_session", { sessionId: attempt.sessionId, stage: attempt.stage }, { idempotencyKey: `evaluate:${attempt.sessionId}:recording-unavailable:${attempt.id}` });
      return;
    }
    const nextPoll = pollNumber + 1;
    await queue.enqueue("wait_for_recording", { callAttemptId, pollNumber: nextPoll }, {
      idempotencyKey: `recording-wait:${callAttemptId}:${nextPoll}`,
      runAt: new Date(Date.now() + (retry.recordingWaitMs || 15_000)),
    });
  }

  async function transcribeCall({ callAttemptId }) {
    const attempt = await repository.getCallAttempt(callAttemptId);
    if (!attempt) return;
    const session = await repository.getAttendanceSession(attempt.sessionId);
    const object = attempt.recordingObjectKey
      ? { key: attempt.recordingObjectKey, contentType: attempt.recordingContentType }
      : await recordings.importProviderRecording(attempt.recordingUrl, { organizationId: session.organizationId, sessionId: session.id, callAttemptId });
    if (object?.key && !attempt.recordingObjectKey) await repository.setRecordingObjectKey(callAttemptId, object.key, object.contentType);
    const transcript = await transcriber.transcribe(object, { language: session.language, organizationId: session.organizationId });
    await repository.saveTranscript({
      organizationId: session.organizationId, sessionId: session.id, callAttemptId,
      language: transcript.language || session.language, text: transcript.text,
    });
    console.info(`[attendance-worker] transcript saved callAttempt=${callAttemptId} characters=${transcript.text.length} language=${transcript.language || session.language}`);
    await queue.enqueue("extract_intent", { callAttemptId }, { idempotencyKey: `extract:${callAttemptId}` });
  }

  async function transcribeInboundCall({ inboundCallId, organizationId }) {
    const call = await repository.getInboundCall(inboundCallId, organizationId || process.env.DEFAULT_ORGANIZATION_ID);
    if (!call?.recordingObjectKey) throw new Error("Inbound call recording is not available");
    const transcript = await transcriber.transcribe(
      { key: call.recordingObjectKey, contentType: call.recordingContentType || "audio/wav" },
      { organizationId: call.organizationId, language: call.language, speakerLabels: "caller and AI agent" },
    );
    await repository.saveInboundCallTranscript(inboundCallId, {
      text: transcript.text, language: transcript.language || call.language,
    }, call.organizationId);
    const activities = await repository.listCareActivities(call.organizationId);
    const analysis = await postCallAgent.extractPatientEnquiry({
      patientContext: call.patient || {}, transcript: transcript.text, activities,
      referenceTime: call.startedAt, timezone: process.env.APP_TIMEZONE || "Asia/Kolkata",
    });
    const activity = activities.find((candidate) => candidate.id === analysis.activityId);
    const timeZone = process.env.APP_TIMEZONE || "Asia/Kolkata";
    const requestedStart = localDateTimeToUtc(analysis.requestedLocalDate, analysis.requestedLocalTime, timeZone);
    const callStartedAt = new Date(call.startedAt || Date.now()).getTime();
    const hasValidStart = Boolean(requestedStart && Number.isFinite(requestedStart.getTime())
      && requestedStart.getTime() >= callStartedAt - 60_000);
    const patientAddressParts = String(call.patient?.address || "").split(" | ");
    const hasPatientDistrict = patientAddressParts.length === 4 && Boolean(patientAddressParts[1].trim());
    const needsDetails = Boolean(analysis.uncertain) || !activity || !hasValidStart || !hasPatientDistrict;
    let staffSuggestions = [];
    let requestedEndAt = null;
    if (activity && hasValidStart) {
      requestedEndAt = new Date(requestedStart.getTime() + activity.durationMinutes * 60_000);
    }
    if (!needsDetails) {
      staffSuggestions = await repository.findAvailableStaffForEnquiry({
        organizationId: call.organizationId,
        startAt: requestedStart.toISOString(), endAt: requestedEndAt.toISOString(),
        patientAddress: call.patient?.address || "", limit: 10,
      });
    }
    const enquiryStatus = needsDetails ? "need_review" : (staffSuggestions.length ? "suggestion" : "shortage");
    await repository.saveInboundEnquiryAnalysis(inboundCallId, {
      organizationId: call.organizationId,
      status: enquiryStatus,
      analysis: {
        activityId: activity?.id || null, activityName: activity?.name || analysis.requestedActivity || null,
        durationMinutes: activity?.durationMinutes || null,
        requestedLocalDate: analysis.requestedLocalDate || null,
        requestedLocalTime: analysis.requestedLocalTime || null,
        timeZone,
        requestedStartAt: hasValidStart ? requestedStart.toISOString() : null,
        requestedEndAt: requestedEndAt?.toISOString() || null,
        needsSummary: String(analysis.needsSummary || "").slice(0, 2000), requiresHumanFollowUp: true,
        uncertain: Boolean(analysis.uncertain),
        missingDetails: [!activity ? "activity" : null, !hasValidStart ? "start_time" : null, !hasPatientDistrict ? "patient_district" : null].filter(Boolean),
      },
      staffSuggestions,
    });
    if (!needsDetails && staffSuggestions.length) {
      const callingSettings = await repository.getOrganizationCallSettings(call.organizationId);
      if (callingSettings.requireHumanVerificationForStaffBooking === true) {
        await repository.setEnquiryBookingStatus(inboundCallId, call.organizationId, "needs_review");
      } else {
        await repository.setEnquiryBookingStatus(inboundCallId, call.organizationId, "calling");
        await queue.enqueue("call_next_appointment_staff", { inboundCallId, organizationId: call.organizationId, candidateIndex: 0 }, {
          idempotencyKey: `appointment:${inboundCallId}:candidate:0`,
        });
      }
    } else if (!needsDetails) {
      await repository.setEnquiryBookingStatus(inboundCallId, call.organizationId, "no_staff_available");
    }
    console.info(`[attendance-worker] inbound transcript saved call=${inboundCallId} characters=${transcript.text.length} language=${transcript.language || call.language}`);
  }

  async function callNextAppointmentStaff({ inboundCallId, organizationId, candidateIndex = 0 }) {
    const call = await repository.getInboundCall(inboundCallId, organizationId || process.env.DEFAULT_ORGANIZATION_ID);
    if (!call || call.bookingScheduleSessionId || call.bookingStatus === "scheduled") return;
    const bookingSettings = await repository.getOrganizationCallSettings(call.organizationId);
    if (bookingSettings.requireHumanVerificationForStaffBooking === true) {
      await repository.setEnquiryBookingStatus(inboundCallId, call.organizationId, "needs_review");
      return;
    }
    const candidates = call.staffSuggestions || [];
    const maxAttempts = bookingSettings.callRetry?.maxConsecutiveNoAnswer ?? retry.maxConsecutiveNoAnswer ?? 3;
    if (candidateIndex >= candidates.length || candidateIndex >= maxAttempts) {
      const attempts = await repository.listAppointmentCallAttempts(inboundCallId, call.organizationId);
      const unanswered = attempts.filter((item) => ["noanswer", "no_answer", "busy", "failed", "timeout"].includes(String(item.status || "").toLowerCase().replace(/[\s-]+/g, "_"))).length;
      const exhaustedNoAnswer = unanswered >= maxAttempts;
      await repository.setEnquiryBookingStatus(inboundCallId, call.organizationId, exhaustedNoAnswer ? "not_answered" : "no_staff_available");
      if (exhaustedNoAnswer) {
        const patientId = call.patient?.id || call.patientId;
        const escalation = bookingSettings.unansweredCallEscalation || "platform_notification";
        const recipients = await repository.notifyCareManagerForPatient({
          organizationId: call.organizationId, patientId, patientUhid: call.patient?.patientUhid || call.patient?.uhid,
          title: "Staff availability calls unanswered",
          message: `No suggested staff member answered ${unanswered} calls for ${call.patient?.name || "this patient"}. Please contact the patient to arrange care.`,
          referenceType: "incoming_enquiry", referenceId: inboundCallId,
          type: escalation === "call_care_manager" ? "care_manager_call_log" : "unanswered_call",
        });
        if (recipients.length && escalation === "call_care_manager") {
          const from = bookingSettings.defaultFromNumber || process.env.VOBIZ_FROM_NUMBER;
          if (from) {
            const answer = new URL("/api/call-service/care-manager-alert/answer", process.env.PUBLIC_BASE_URL || "https://localhost");
            answer.searchParams.set("message", `Athulya care alert. No suggested staff member answered repeated availability calls for ${call.patient?.name || "a patient"}. Please contact operations.`);
            for (const manager of recipients) {
              if (!manager.careManagerPhone) continue;
              try { await vobiz.createCall({ to: manager.careManagerPhone, from, answerUrl: answer.toString() }); }
              catch (error) { console.error(`[appointment-booking] care-manager call failed enquiry=${inboundCallId}: ${error.message}`); }
            }
          } else console.error(`[appointment-booking] care-manager call skipped: no caller ID enquiry=${inboundCallId}`);
        }
        if (recipients.length) console.info(`[appointment-booking] care-manager escalation created enquiry=${inboundCallId} mode=${escalation}`);
      }
      return;
    }
    const staff = candidates[candidateIndex];
    const agents = await repository.listAgents(call.organizationId);
    const language = staff.language || call.language || "en";
    const agent = agents.find((item) => item.active && String(item.language).toLowerCase().startsWith(String(language).slice(0, 2).toLowerCase()))
      || agents.find((item) => item.active);
    if (!staff?.phoneNumber || !agent) {
      await repository.setEnquiryBookingStatus(inboundCallId, call.organizationId, "needs_review");
      return;
    }
    const settings = await repository.getOrganizationCallSettings(call.organizationId);
    const from = settings.defaultFromNumber || process.env.VOBIZ_FROM_NUMBER;
    if (!from) {
      await repository.setEnquiryBookingStatus(inboundCallId, call.organizationId, "needs_review", { staff });
      return;
    }
    const attempt = await repository.createAppointmentCallAttempt({
      inboundCallId, organizationId: call.organizationId, candidateIndex, staff, agentId: agent.id,
    });
    if (!attempt || attempt.providerCallId) return;
    await repository.setEnquiryBookingStatus(inboundCallId, call.organizationId, "calling", { staff });
    try {
      const result = await vobiz.createCall({ to: staff.phoneNumber, from, agentId: agent.id, appointmentCallId: attempt.id });
      const providerCallId = result.call_uuid || result.request_uuid;
      if (!providerCallId) throw new Error("Vobiz did not return a call ID for the appointment call");
      await repository.attachAppointmentProviderCallId(attempt.id, providerCallId);
      console.info(`[appointment-booking] placed call enquiry=${inboundCallId} candidate=${candidateIndex} attempt=${attempt.id}`);
    } catch (error) {
      await repository.markAppointmentCallFailed(attempt.id, error.message);
      await queue.enqueue("process_appointment_call", { appointmentCallId: attempt.id }, { idempotencyKey: `appointment-result:${attempt.id}` });
      throw error;
    }
  }

  async function processAppointmentCall({ appointmentCallId }) {
    const appointment = await repository.getAppointmentCallContext(appointmentCallId);
    if (!appointment || appointment.status === "scheduled") return;
    const call = await repository.getInboundCall(appointment.inboundCallId, appointment.organizationId);
    if (!call || call.bookingScheduleSessionId) return;
    const normalized = String(appointment.status || "").toLowerCase().replace(/[\s_-]+/g, "");
    if (["noanswer", "failed", "busy", "timeout", "canceled", "cancelled"].includes(normalized)) {
      await queue.enqueue("call_next_appointment_staff", { inboundCallId: appointment.inboundCallId, organizationId: appointment.organizationId, candidateIndex: appointment.candidateIndex + 1 }, {
        idempotencyKey: `appointment:${appointment.inboundCallId}:candidate:${appointment.candidateIndex + 1}`,
      });
      return;
    }
    if (!appointment.recordingObjectKey) throw new Error("Staff call recording is not available yet");
    const transcript = await transcriber.transcribe(
      { key: appointment.recordingObjectKey, contentType: appointment.recordingContentType || "audio/wav" },
      { organizationId: appointment.organizationId, language: appointment.language, speakerLabels: "calling agent and staff member" },
    );
    const analysis = call.enquiryAnalysis || {};
    const activity = (await repository.listCareActivities(appointment.organizationId)).find((item) => item.id === analysis.activityId);
    const outcome = await postCallAgent.extractStaffAvailability({
      staff: appointment.staff, activity: { id: analysis.activityId, name: analysis.activityName || activity?.name, description: activity?.description },
      requestedStartAt: analysis.requestedStartAt, transcript: transcript.text,
    });
    await repository.saveAppointmentCallTranscript(appointmentCallId, transcript.text, outcome);
    const bookingSettings = await repository.getOrganizationCallSettings(appointment.organizationId);
    if (bookingSettings.requireHumanVerificationForStaffBooking === true) {
      await repository.setEnquiryBookingStatus(appointment.inboundCallId, appointment.organizationId, "needs_review", { staff: appointment.staff });
      return;
    }
    if (outcome.outcome === "unavailable") {
      await queue.enqueue("call_next_appointment_staff", { inboundCallId: appointment.inboundCallId, organizationId: appointment.organizationId, candidateIndex: appointment.candidateIndex + 1 }, {
        idempotencyKey: `appointment:${appointment.inboundCallId}:candidate:${appointment.candidateIndex + 1}`,
      });
      return;
    }
    // Activity and start time come from the authoritative enquiry context and
    // are spoken back by the live agent before asking for confirmation. Require
    // the staff member's clear acceptance, but do not require them to repeat
    // those details verbatim in the recording/transcript.
    if (outcome.outcome !== "available_confirmed" || !outcome.confirmedByStaff) {
      await repository.setEnquiryBookingStatus(appointment.inboundCallId, appointment.organizationId, "needs_review", { staff: appointment.staff });
      return;
    }
    const agents = await repository.listAgents(appointment.organizationId);
    const attendanceAgent = agents.find((item) => item.active && String(item.language).toLowerCase().startsWith(String(appointment.language).slice(0, 2).toLowerCase()))
      || agents.find((item) => item.active);
    if (!attendanceAgent) {
      await repository.setEnquiryBookingStatus(appointment.inboundCallId, appointment.organizationId, "needs_review", { staff: appointment.staff });
      return;
    }
    const settings = await repository.getOrganizationCallSettings(appointment.organizationId);
    let session;
    try {
      session = await appointmentTools.createAttendanceSchedule.invoke({
        inboundCallId: appointment.inboundCallId, organizationId: appointment.organizationId,
        staff: { ...appointment.staff, phoneNumber: appointment.staff.phoneNumber, language: appointment.staff.language || appointment.language },
        attendanceAgentId: attendanceAgent.id, fromNumber: settings.defaultFromNumber || process.env.VOBIZ_FROM_NUMBER,
      }).then((value) => JSON.parse(value));
    } catch (error) {
      await repository.setEnquiryBookingStatus(appointment.inboundCallId, appointment.organizationId, "needs_review", { staff: appointment.staff });
      console.warn(`[appointment-booking] confirmed staff needs schedule review enquiry=${appointment.inboundCallId} message=${String(error.message || error).slice(0, 200)}`);
      return;
    }
    if (!session) throw new Error("Could not create attendance schedule from confirmed staff acceptance");
    await queue.enqueue("place_call", { sessionId: session.id, taskId: session.checkInTask?.id, stage: "check_in", attemptNumber: 1 }, {
      idempotencyKey: `call:${session.id}:check_in:1`, runAt: new Date(session.scheduledStartAt),
    });
    await queue.enqueue("place_call", { sessionId: session.id, taskId: session.checkOutTask?.id, stage: "check_out", attemptNumber: 1 }, {
      idempotencyKey: `call:${session.id}:check_out:1`, runAt: new Date(session.scheduledEndAt),
    });
  }

  const appointmentTools = createAppointmentBookingTools({ repository });

  async function extractIntent({ callAttemptId }) {
    const attempt = await repository.getCallAttempt(callAttemptId);
    if (!attempt) return;
    const [session, sessionContext, transcript] = await Promise.all([
      repository.getAttendanceSession(attempt.sessionId),
      repository.getAgentSessionContext(attempt.sessionId, attempt.stage),
      repository.getTranscriptForCall(callAttemptId),
    ]);
    const endedAt = new Date(attempt.endedAt || attempt.updatedAt || Date.now());
    const callEndedAt = Number.isFinite(endedAt.getTime()) ? endedAt.toISOString() : new Date().toISOString();
    sessionContext.systemTimeAtCallEnd = callEndedAt;
    const outcome = await postCallAgent.extractCallOutcome({
      orgId: session.organizationId,
      sessionContext,
      transcript: transcript.text,
    });
    const now = new Date(callEndedAt);
    const stageTimeField = attempt.stage === "check_in" ? "reportedArrivalTime" : "reportedDepartureTime";
    const stageTimeMentionedField = attempt.stage === "check_in" ? "reportedArrivalTimeMentioned" : "reportedDepartureTimeMentioned";
    const scheduledStageTime = attempt.stage === "check_in" ? session.scheduledStartAt : session.scheduledEndAt;

    // A clearly future arrival/departure cannot be recorded as attendance.
    // The live prompt asks the employee to correct it; if it remains wrong in
    // the transcript, route it to human review rather than silently adjusting it.
    const reportedTimeError = validateReportedTime(outcome[stageTimeField], now);
    if (reportedTimeError) {
      outcome.exceptionCode = reportedTimeError;
      outcome.employeeIntent = "unclear";
      outcome.summary = `${outcome.summary || ""} ${reportedTimeError === "future_reported_time" ? "Reported attendance time is later than call completion." : "Reported attendance time could not be parsed."}`.trim();
    } else if (
      outcome.employeeIntent === (attempt.stage === "check_in" ? "arrival_confirmed" : "departure_confirmed") &&
      outcome[stageTimeMentionedField] === false
    ) {
      // When the employee confirms attendance but does not state a clock time,
      // use the imported schedule time for this stage as requested.
      const scheduledDate = scheduledStageTime ? new Date(scheduledStageTime) : null;
      outcome[stageTimeField] = scheduledDate && Number.isFinite(scheduledDate.getTime()) ? scheduledDate.toISOString() : null;
      outcome[`${stageTimeField}Source`] = "scheduled_time_fallback";
      const fallbackTimeError = validateReportedTime(outcome[stageTimeField], now);
      if (fallbackTimeError) {
        outcome.exceptionCode = fallbackTimeError === "future_reported_time" ? "scheduled_time_in_future" : fallbackTimeError;
        outcome.employeeIntent = "unclear";
      }
    }
    if (["will_arrive_later", "still_on_duty"].includes(outcome.employeeIntent)) {
      const inferredCallbackAt = inferRequestedCallbackAt(transcript.text, attempt.updatedAt ? new Date(attempt.updatedAt) : new Date());
      if (inferredCallbackAt) outcome.requestedCallbackAt = inferredCallbackAt;
    }
    await repository.saveCallOutcome(callAttemptId, outcome);
    console.info(`[attendance-worker] intent extracted callAttempt=${callAttemptId} stage=${attempt.stage} intent=${outcome.employeeIntent || "unknown"}`);
    await queue.enqueue("evaluate_attendance", { sessionId: session.id, callAttemptId }, {
      idempotencyKey: `decision:${callAttemptId}`,
    });
  }

  async function evaluateAttendance({ sessionId, callAttemptId }) {
    const session = await repository.getAttendanceSession(sessionId);
    if (!session || session.sessionStatus === "completed") return;
    if (callAttemptId) {
      const attempt = await repository.getCallAttempt(callAttemptId);
      const decision = chooseAttendanceAction(attempt.stage, attempt.outcome || {});
      if (decision.action === "confirm_stage") {
        await repository.setStageStatus(sessionId, attempt.stage, "confirmed", { reportedAt: decision.reportedAt, nextCallAt: null, callAttemptId });
        await queue.enqueue("deliver_attendance", { sessionId, stage: attempt.stage, callAttemptId }, {
          idempotencyKey: `deliver:${sessionId}:${attempt.stage}:${callAttemptId}`,
        });
      } else if (decision.action === "follow_up") {
        if (!decision.runAt) {
          await repository.setStageStatus(sessionId, attempt.stage, "review", { reason: "callback_time_unclear", callAttemptId });
        } else {
          const runAt = normalizeCallbackTime(decision.runAt);
          if (!runAt) {
            await repository.setStageStatus(sessionId, attempt.stage, "review", { reason: "callback_time_invalid", callAttemptId });
          } else {
            const nextNumber = await repository.nextAttemptNumber(sessionId, attempt.stage);
            let callbackAt = runAt;
            if (attempt.stage === "check_in" && session.scheduledEndAt) {
              const checkoutAt = new Date(session.scheduledEndAt);
              if (Number.isFinite(checkoutAt.getTime())) {
                const latestCheckInAt = new Date(checkoutAt.getTime() - 60_000);
                if (callbackAt >= latestCheckInAt) callbackAt = latestCheckInAt > new Date() ? latestCheckInAt : new Date(Date.now() + 1_000);
              }
            }
            await repository.setStageStatus(sessionId, attempt.stage, "follow_up", { reason: "employee_requested_callback", nextCallAt: callbackAt.toISOString(), callAttemptId });
            await queue.enqueue("place_call", { sessionId, taskId: taskFor(session, attempt.stage)?.id, stage: attempt.stage, attemptNumber: nextNumber, consecutiveNoAnswer: 0 }, {
              idempotencyKey: `call:${sessionId}:${attempt.stage}:${nextNumber}`, runAt: callbackAt,
            });
          }
        }
      } else {
        await repository.setStageStatus(sessionId, attempt.stage, "review", { reason: decision.reason, callAttemptId });
      }
    }

    const current = await repository.getAttendanceSession(sessionId);
    if (current.checkInStatus === "confirmed" && current.checkOutStatus === "confirmed") {
      await repository.markSessionCompleted(sessionId);
    } else {
      const terminal = new Set(["confirmed", "missed", "not_answered", "review"]);
      const bothStagesSettled = terminal.has(current.checkInStatus) && terminal.has(current.checkOutStatus);
      if (bothStagesSettled) await repository.markSessionException(sessionId);
    }

  }

  async function deliverAttendance({ sessionId, stage, callAttemptId }, { job } = {}) {
    const session = await repository.getAttendanceSession(sessionId);
    if (!session || !["check_in", "check_out"].includes(stage) || !callAttemptId) return;
    const submission = await repository.getAthulyaAttendanceSubmissionForEvent(sessionId, stage);
    if (submission && submission.status !== "synced") {
      if (!athulyaAttendanceClient) throw new Error("Athulya attendance client is not configured");
      const claimed = await repository.startAthulyaAttendanceSubmission(submission.id);
      if (!claimed) throw new Error("Athulya attendance submission is already being processed");
      if (claimed) {
        try {
          const result = await athulyaAttendanceClient.sendAttendance({
            organizationId: submission.organizationId,
            scheduleId: submission.scheduleId,
            type: submission.eventType,
            timing: submission.eventAt,
            idempotencyKey: submission.idempotencyKey,
          });
          await repository.finishAthulyaAttendanceSubmission(submission.id, {
            statusCode: result.status,
            responseBody: result.body,
            externalReference: result.body?.schedule_id,
          });
        } catch (error) {
          await repository.failAthulyaAttendanceSubmission(submission.id, {
            statusCode: error.statusCode || null,
            errorMessage: error.message,
            terminal: Boolean(job && job.attempts >= job.max_attempts),
          });
          throw error;
        }
      }
    }
    const payload = await repository.buildBackendAttendancePayload(sessionId, stage, callAttemptId);
    if (!payload) return;
    const result = await backend.sendAttendance(payload, {
      idempotencyKey: `attendance:${sessionId}:${stage}:${callAttemptId}`,
    });
    await repository.markBackendDelivered(sessionId, stage, result);
  }

  async function evaluateSession({ sessionId, stage }) {
    const session = await repository.getAttendanceSession(sessionId);
    if (!session) return;
    const stageStatus = stage === "check_out" ? session.checkOutStatus : session.checkInStatus;
    if (stageStatus === "not_answered") {
      const settings = await repository.getOrganizationCallSettings(session.organizationId);
      const escalation = settings.unansweredCallEscalation || "call_care_manager";
      const maxNoAnswer = settings.callRetry?.maxConsecutiveNoAnswer ?? retry.maxConsecutiveNoAnswer ?? 3;
      const patient = session.patient || {};
      const stageLabel = stage === "check_out" ? "check-out" : "check-in";
      const notifications = await repository.notifyCareManagerForPatient({
        organizationId: session.organizationId,
        patientId: patient.id,
        patientUhid: patient.patientUhid || patient.uhid,
        title: `Unanswered ${stageLabel} calls`,
        message: `${session.employee?.name || "Assigned staff"} did not answer ${maxNoAnswer} ${stageLabel} calls for ${patient.name || "the assigned patient"}. Please follow up.`,
        referenceType: "attendance_stage",
        referenceId: `${session.id}:${stage}`,
        type: escalation === "call_care_manager" ? "care_manager_call_log" : "unanswered_call",
      });
      if (notifications.length && escalation === "call_care_manager") {
        const from = settings.defaultFromNumber || process.env.VOBIZ_FROM_NUMBER;
        if (!from) {
          console.error(`[attendance-worker] care-manager escalation call skipped: no caller ID session=${session.id} stage=${stage}`);
        } else {
          const answer = new URL("/api/call-service/care-manager-alert/answer", process.env.PUBLIC_BASE_URL || "https://localhost");
          const spokenMessage = `Athulya attendance alert. ${session.employee?.name || "Assigned staff"} did not answer repeated ${stageLabel} calls for ${patient.name || "the assigned patient"}. Please contact operations.`;
          answer.searchParams.set("message", spokenMessage);
          for (const manager of notifications) {
            if (!manager.careManagerPhone) continue;
            try {
              await vobiz.createCall({ to: manager.careManagerPhone, from, answerUrl: answer.toString() });
              console.info(`[attendance-worker] care-manager escalation call placed session=${session.id} stage=${stage}`);
            } catch (error) {
              console.error(`[attendance-worker] care-manager escalation call failed session=${session.id} stage=${stage}: ${error.message}`);
            }
          }
        }
      } else if (notifications.length) {
        console.info(`[attendance-worker] care-manager platform notification created session=${session.id} stage=${stage} recipients=${notifications.length}`);
      }
      await repository.setStageStatus(sessionId, stage, "not_answered", {
        reason: "consecutive_no_answer_limit_reached",
        consecutiveNoAnswer: maxNoAnswer,
        careManagerNotified: notifications.length > 0,
      });
      if (escalation === "call_care_manager" && notifications.length === 0) {
        console.info(`[attendance-worker] no care manager found; keeping stage not_answered session=${session.id} stage=${stage}`);
      }
    }
    const terminal = new Set(["confirmed", "missed", "not_answered", "review"]);
    if (terminal.has(session.checkInStatus) && terminal.has(session.checkOutStatus)
      && (session.checkInStatus !== "confirmed" || session.checkOutStatus !== "confirmed")) {
      await repository.markSessionException(sessionId);
    }
  }

  const { handlers: postCallToolHandlers } = createPostCallTools({
    place_call: placeCall,
    process_call_result: processCallResult,
    wait_for_recording: waitForRecording,
    transcribe_call: transcribeCall,
    transcribe_inbound_call: transcribeInboundCall,
    call_next_appointment_staff: callNextAppointmentStaff,
    process_appointment_call: processAppointmentCall,
    extract_intent: extractIntent,
    evaluate_attendance: evaluateAttendance,
    evaluate_session: evaluateSession,
    deliver_attendance: deliverAttendance,
  });

  // The async job queue dispatches these LangChain tools in its fixed,
  // deterministic order. The model only extracts transcript facts; it does
  // not receive authority to schedule, complete, or deliver sessions.
  return { ...postCallToolHandlers, ...additionalHandlers };
}

module.exports = { createAttendanceHandlers, classifyCallStatus, chooseAttendanceAction, normalizeCallbackTime, inferRequestedCallbackAt };
