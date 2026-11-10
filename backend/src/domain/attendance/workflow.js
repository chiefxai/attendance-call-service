"use strict";

const { backoffMilliseconds } = require("../../infrastructure/database/postgres-queue");
const { createPostCallTools } = require("../../agents/post-call-tools");
const { createAppointmentBookingTools } = require("../../agents/appointment-booking-tools");

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

function createAttendanceHandlers({ repository, queue, vobiz, recordings, transcriber, postCallAgent, backend, activeSessionCache, retry = {}, capacity = {} }) {
  const required = { repository, queue, vobiz, recordings, transcriber, postCallAgent, backend };
  const missing = Object.entries(required).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`Attendance workflow dependencies required: ${missing.join(", ")}`);

  async function settleCheckoutIfCheckInFailed(sessionId) {
    let current = await repository.getAttendanceSession(sessionId);
    if (!current || !["missed", "not_answered", "review"].includes(current.checkInStatus)) return false;
    if (current.checkOutStatus === "scheduled") {
      await repository.setStageStatus(sessionId, "check_out", "missed", {
        reason: "check_in_not_confirmed",
        checkInStatus: current.checkInStatus,
      });
      current = await repository.getAttendanceSession(sessionId);
    }
    const terminal = new Set(["confirmed", "missed", "not_answered", "review"]);
    if (terminal.has(current.checkInStatus) && terminal.has(current.checkOutStatus)
        && (current.checkInStatus !== "confirmed" || current.checkOutStatus !== "confirmed")) {
      await repository.markSessionException(sessionId);
    }
    return true;
  }

  async function placeCall({ sessionId, stage, attemptNumber, capacityWaitCount = 0, consecutiveNoAnswer = 0 }) {
    const session = await repository.getAttendanceSession(sessionId);
    // A terminal result for one stage must not suppress the other scheduled
    // stage. The session becomes an exception only after both stages settle.
    if (!session || session.sessionStatus === "completed") return;
    if (stage === "check_out" && session.checkInStatus !== "confirmed") {
      await settleCheckoutIfCheckInFailed(sessionId);
      return;
    }
    const stageStatus = stage === "check_in" ? session.checkInStatus : session.checkOutStatus;
    if (["confirmed", "missed", "not_answered", "review"].includes(stageStatus)) return;
    const agent = await repository.getAgent(session.organizationId, session.agentId);
    if (!agent?.active) {
      await repository.setStageStatus(sessionId, stage, "review", { reason: "agent_missing_or_inactive" });
      if (stage === "check_in") await settleCheckoutIfCheckInFailed(sessionId);
      throw new Error("The assigned calling agent is missing or inactive");
    }
    const attempt = await repository.createCallAttempt({
      organizationId: session.organizationId, sessionId, stage, attemptNumber,
      callTargetRole: "employee", scheduledAt: new Date(), consecutiveNoAnswer,
    });
    if (!attempt.shouldPlace || attempt.providerCallId || attempt.status !== "scheduled") {
      if (attempt.status === "placing" && !attempt.providerCallId) {
        await repository.setStageStatus(sessionId, stage, "review", { reason: "call_placement_reconciliation_required", callAttemptId: attempt.id });
        if (stage === "check_in") await settleCheckoutIfCheckInFailed(sessionId);
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
      await queue.enqueue("place_call", { sessionId, stage, attemptNumber, capacityWaitCount: nextWait }, {
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
      if (stage === "check_in") await settleCheckoutIfCheckInFailed(sessionId);
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
      const initialMinutes = retrySettings.initialMinutes ?? retry.initialMinutes ?? 5;
      const multiplier = retrySettings.multiplier ?? retry.multiplier ?? 1.2;
      const maxMinutes = retrySettings.maxMinutes ?? retry.maxMinutes ?? 30;
      const maxConsecutiveNoAnswer = retrySettings.maxConsecutiveNoAnswer ?? retry.maxConsecutiveNoAnswer ?? 5;
      const config = { initialMs: initialMinutes * 60_000, multiplier, maxMs: maxMinutes * 60_000 };
      if (noAnswerCount >= maxConsecutiveNoAnswer) {
        await repository.setStageStatus(attempt.sessionId, attempt.stage, "not_answered", {
          reason: "consecutive_no_answer_limit_reached", consecutiveNoAnswer: noAnswerCount,
        });
        await queue.enqueue("evaluate_session", { sessionId: attempt.sessionId }, { idempotencyKey: `evaluate:${attempt.sessionId}:not-answered:${attempt.stage}` });
        return;
      }
      const runAt = new Date(Date.now() + backoffMilliseconds(attempt.attemptNumber, config));
      await repository.setStageStatus(attempt.sessionId, attempt.stage, "follow_up", { reason: "not_answered", nextCallAt: runAt.toISOString() });
      await queue.enqueue("place_call", { sessionId: attempt.sessionId, stage: attempt.stage, attemptNumber: attempt.attemptNumber + 1, consecutiveNoAnswer: noAnswerCount }, {
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
      await queue.enqueue("evaluate_session", { sessionId: attempt.sessionId }, { idempotencyKey: `evaluate:${attempt.sessionId}:recording-unavailable:${attempt.id}` });
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
    const requestedStartText = String(analysis.requestedStartAt || "");
    const requestedStart = requestedStartText ? new Date(requestedStartText) : null;
    const hasExplicitZone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(requestedStartText);
    const callStartedAt = new Date(call.startedAt || Date.now()).getTime();
    const hasValidStart = Boolean(hasExplicitZone && requestedStart && Number.isFinite(requestedStart.getTime())
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
        requestedStartAt: hasValidStart ? requestedStart.toISOString() : null,
        requestedEndAt: requestedEndAt?.toISOString() || null,
        needsSummary: String(analysis.needsSummary || "").slice(0, 2000), requiresHumanFollowUp: true,
        uncertain: Boolean(analysis.uncertain),
        missingDetails: [!activity ? "activity" : null, !hasValidStart ? "start_time" : null, !hasPatientDistrict ? "patient_district" : null].filter(Boolean),
      },
      staffSuggestions,
    });
    if (!needsDetails && staffSuggestions.length) {
      await repository.setEnquiryBookingStatus(inboundCallId, call.organizationId, "calling");
      await queue.enqueue("call_next_appointment_staff", { inboundCallId, organizationId: call.organizationId, candidateIndex: 0 }, {
        idempotencyKey: `appointment:${inboundCallId}:candidate:0`,
      });
    } else if (!needsDetails) {
      await repository.setEnquiryBookingStatus(inboundCallId, call.organizationId, "no_staff_available");
    }
    console.info(`[attendance-worker] inbound transcript saved call=${inboundCallId} characters=${transcript.text.length} language=${transcript.language || call.language}`);
  }

  async function callNextAppointmentStaff({ inboundCallId, organizationId, candidateIndex = 0 }) {
    const call = await repository.getInboundCall(inboundCallId, organizationId || process.env.DEFAULT_ORGANIZATION_ID);
    if (!call || call.bookingScheduleSessionId || call.bookingStatus === "scheduled") return;
    const candidates = call.staffSuggestions || [];
    if (candidateIndex >= candidates.length) {
      await repository.setEnquiryBookingStatus(inboundCallId, call.organizationId, "not_answered");
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
    if (outcome.outcome === "unavailable") {
      await queue.enqueue("call_next_appointment_staff", { inboundCallId: appointment.inboundCallId, organizationId: appointment.organizationId, candidateIndex: appointment.candidateIndex + 1 }, {
        idempotencyKey: `appointment:${appointment.inboundCallId}:candidate:${appointment.candidateIndex + 1}`,
      });
      return;
    }
    if (outcome.outcome !== "available_confirmed" || !outcome.confirmedByStaff || !outcome.confirmedActivity || !outcome.confirmedStartTime) {
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
    await queue.enqueue("place_call", { sessionId: session.id, stage: "check_in", attemptNumber: 1 }, {
      idempotencyKey: `call:${session.id}:check_in:1`, runAt: new Date(session.scheduledStartAt),
    });
    await queue.enqueue("place_call", { sessionId: session.id, stage: "check_out", attemptNumber: 1 }, {
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
    const outcome = await postCallAgent.extractCallOutcome({
      orgId: session.organizationId,
      sessionContext,
      transcript: transcript.text,
    });
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
        await repository.setStageStatus(sessionId, attempt.stage, "confirmed", { reportedAt: decision.reportedAt, callAttemptId });
        if (attempt.stage === "check_in") {
          const updatedSession = await repository.getAttendanceSession(sessionId);
          const scheduledCheckOut = new Date(updatedSession.scheduledEndAt).getTime();
          if (updatedSession.checkOutStatus === "scheduled" && Number.isFinite(scheduledCheckOut)) {
            // Re-enqueue after check-in confirmation. The original end-time job
            // is also protected by the gate below; a unique DB attempt prevents
            // duplicate calls if both jobs become runnable together.
            const runAt = new Date(Math.max(Date.now(), scheduledCheckOut));
            await queue.enqueue("place_call", { sessionId, stage: "check_out", attemptNumber: 1 }, {
              idempotencyKey: `call:${sessionId}:check_out:after-check-in`, runAt,
            });
          }
        }
      } else if (decision.action === "follow_up") {
        if (!decision.runAt) {
          await repository.setStageStatus(sessionId, attempt.stage, "review", { reason: "callback_time_unclear", callAttemptId });
        } else {
          const runAt = normalizeCallbackTime(decision.runAt);
          if (!runAt) {
            await repository.setStageStatus(sessionId, attempt.stage, "review", { reason: "callback_time_invalid", callAttemptId });
          } else {
            const nextNumber = await repository.nextAttemptNumber(sessionId, attempt.stage);
            await repository.setStageStatus(sessionId, attempt.stage, "follow_up", { reason: "employee_requested_callback", nextCallAt: runAt.toISOString(), callAttemptId });
            await queue.enqueue("place_call", { sessionId, stage: attempt.stage, attemptNumber: nextNumber, consecutiveNoAnswer: 0 }, {
              idempotencyKey: `call:${sessionId}:${attempt.stage}:${nextNumber}`, runAt,
            });
          }
        }
      } else {
        await repository.setStageStatus(sessionId, attempt.stage, "review", { reason: decision.reason, callAttemptId });
      }
    }

    await settleCheckoutIfCheckInFailed(sessionId);
    const current = await repository.getAttendanceSession(sessionId);
    if (current.checkInStatus === "confirmed" && current.checkOutStatus === "confirmed") {
      const eligibleForCompletion = await repository.markSessionCompleted(sessionId);
      if (eligibleForCompletion) {
        await queue.enqueue("deliver_attendance", { sessionId }, { idempotencyKey: `deliver:${sessionId}` });
      }
    } else {
      const terminal = new Set(["confirmed", "missed", "not_answered", "review"]);
      const bothStagesSettled = terminal.has(current.checkInStatus) && terminal.has(current.checkOutStatus);
      if (bothStagesSettled) await repository.markSessionException(sessionId);
    }

  }

  async function deliverAttendance({ sessionId, callAttemptId }) {
    const session = await repository.getAttendanceSession(sessionId);
    // Only send a session after both attendance stages are confirmed. This
    // protects against stale queue jobs and prevents incomplete records being
    // delivered if another path enqueues this job prematurely.
    if (!session || session.sessionStatus !== "completed"
        || session.checkInStatus !== "confirmed" || session.checkOutStatus !== "confirmed") return;
    const result = await backend.sendAttendance(await repository.buildBackendAttendancePayload(sessionId), {
      idempotencyKey: `attendance-session:${sessionId}:${callAttemptId || "snapshot"}`,
    });
    await repository.markBackendDelivered(sessionId, result);
    if (activeSessionCache?.delete) await activeSessionCache.delete(sessionId);
  }

  async function evaluateSession({ sessionId }) {
    await settleCheckoutIfCheckInFailed(sessionId);
    const session = await repository.getAttendanceSession(sessionId);
    if (!session) return;
    const terminal = new Set(["confirmed", "missed", "not_answered", "review"]);
    const bothStagesSettled = terminal.has(session.checkInStatus) && terminal.has(session.checkOutStatus);
    if (bothStagesSettled && (session.checkInStatus !== "confirmed" || session.checkOutStatus !== "confirmed")) {
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
  return postCallToolHandlers;
}

module.exports = { createAttendanceHandlers, classifyCallStatus, chooseAttendanceAction, normalizeCallbackTime, inferRequestedCallbackAt };
