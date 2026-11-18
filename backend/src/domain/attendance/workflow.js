"use strict";

const { backoffMilliseconds } = require("../../infrastructure/database/postgres-queue");
const { normalizeChiefVoiceWebhook, extractChiefVoiceTranscript } = require("../../infrastructure/integrations/chiefvoice-webhook");
const { normalizeIndianMobile } = require("./phone-number");
const { processChiefVoiceResult } = require("./chiefvoice-result");
const { isNoAnswerFailureCode } = require("./call-failure");

function classifyCallStatus(status) {
  const value = String(status || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (["completed", "answered", "inprogress"].includes(value)) return "answered";
  if (["noanswer", "notanswered", "unanswered", "busy", "failed", "timeout"].includes(value)) return "not_answered";
  if (["canceled", "cancelled"].includes(value)) return "cancelled";
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

function hasCallerSpeechTranscript(transcript) {
  const text = String(transcript || "").trim();
  if (!text) return false;
  const labelledLines = text.split(/\r?\n/).map((line) => {
    const match = line.trim().match(/^([^:]{1,40}):\s*(.*)$/);
    return match ? { speaker: match[1].trim().toLowerCase(), utterance: match[2].trim() } : null;
  }).filter(Boolean);
  if (!labelledLines.length) return true;
  const callerLabels = /^(customer|caller|user|caregiver|employee|human|patient|contact|callee)$/i;
  return labelledLines.some(({ speaker, utterance }) => callerLabels.test(speaker) && utterance.length > 0);
}

function validateReportedTime(value, now = new Date()) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "reported_time_invalid";
  return timestamp > now.getTime() ? "future_reported_time" : null;
}

function chiefVoiceTemplateScenario({ stage, attemptNumber = 1, consecutiveNoAnswer = 0, context = {}, technicalFailureRetry = false }) {
  if (context.call_purpose === "care_manager_escalation") return "CARE_MANAGER_ESCALATION";
  const stageKey = stage === "check_out" ? "CHECK_OUT" : "CHECK_IN";
  if (technicalFailureRetry) return `${stageKey}_RETRY`;
  if (Number(attemptNumber) > 1) {
    return Number(consecutiveNoAnswer) > 0 ? `${stageKey}_RETRY` : `${stageKey}_FOLLOW_UP`;
  }
  return stageKey;
}

function chooseAttendanceAction(stage, outcome = {}) {
  if (outcome.employeeIntent === "no_human_answer") return { action: "retry_no_answer" };
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
    // The check-out prompt confirms completion on the assigned caregiver phone
    // and intentionally does not ask for a name. Requiring employeeVerified
    // here would force an extra identity question and contradict that flow.
    if (outcome.employeeIntent === "departure_confirmed" && outcome.dutyComplete === true && outcome.reportedDepartureTime) {
      return { action: "confirm_stage", reportedAt: outcome.reportedDepartureTime || null };
    }
    if (outcome.employeeIntent === "still_on_duty" || outcome.requestedCallbackAt) {
      return { action: "follow_up", runAt: outcome.requestedCallbackAt || null };
    }
    return { action: "review", reason: "check_out_not_confirmed" };
  }
  return { action: "review", reason: "invalid_stage" };
}

function createAttendanceHandlers({ repository, queue, chiefvoice, recordings = null, backend, athulyaAttendanceClient = null, retry = {}, capacity = {}, additionalHandlers = {} }) {
  const required = { repository, queue, chiefvoice, backend };
  const missing = Object.entries(required).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`Attendance workflow dependencies required: ${missing.join(", ")}`);
  const taskFor = (session, stage) => stage === "check_in" ? session?.checkInTask : session?.checkOutTask;

  async function placeCall({ sessionId, taskId, stage, attemptNumber, capacityWaitCount = 0, consecutiveNoAnswer = 0, technicalFailureRetry = false }) {
    const session = await repository.getAttendanceSession(sessionId);
    // Check-in and check-out are independent tasks. Exhausting check-in retries
    // must not close the shared assignment; only an explicit cancellation or a
    // fully completed session can suppress the later check-out call.
    if (!session || ["completed", "cancelled"].includes(session.sessionStatus)) return;
    const task = stage === "check_in" ? session.checkInTask : session.checkOutTask;
    if (!task || (taskId && task.id !== taskId)) return;
    const stageStatus = stage === "check_in" ? session.checkInStatus : session.checkOutStatus;
    if (["confirmed", "missed", "not_answered", "review"].includes(stageStatus)) return;
    const attempt = await repository.createCallAttempt({
      organizationId: session.organizationId, sessionId, stage, attemptNumber,
      callTargetRole: "employee", scheduledAt: new Date(), consecutiveNoAnswer,
    });
    if (attempt.providerCallId && attempt.provider === "chiefvoice" && !attempt.outcome) {
      await queue.enqueue("poll_chiefvoice_call", { callAttemptId: attempt.id, pollCount: 0 }, {
        idempotencyKey: `chiefvoice-poll:${attempt.id}:0`,
        runAt: new Date(Date.now() + (Number(process.env.CHIEFVOICE_POLL_INITIAL_MS) || 15_000)),
      });
      return;
    }
    if (!attempt.shouldPlace || attempt.status !== "scheduled") {
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
      await queue.enqueue("place_call", { sessionId, taskId: task.id, stage, attemptNumber, capacityWaitCount: nextWait, consecutiveNoAnswer, technicalFailureRetry }, {
        idempotencyKey: `capacity:${sessionId}:${stage}:${attemptNumber}:${nextWait}`,
        runAt: new Date(Date.now() + (capacity.capacityPollMs || 2_000)),
      });
      return;
    }
    if (!await repository.markCallPlacing(attempt.id)) return;
    await repository.setStageStatus(sessionId, stage, "calling", { currentCallAttemptId: attempt.id, attemptNumber });
    const person = session.employee || {};
    try {
      const stageContext = session.activeContext?.[stage === "check_in" ? "checkIn" : "checkOut"] || {};
      const callContext = {
        schedule: { start_at: session.scheduledStartAt, end_at: session.scheduledEndAt },
        language: session.language,
        scheduled_check_in_at: session.scheduledStartAt || "",
        scheduled_check_out_at: session.scheduledEndAt || "",
        attempt_number: String(attemptNumber || 1),
        consecutive_no_answer: String(consecutiveNoAnswer || 0),
        callback_requested_at: stageContext.lastCallbackAt
          || (stageContext.reason === "employee_requested_callback" ? stageContext.nextCallAt : "")
          || "",
      };
      const postCallContext = {
        ...callContext,
        assignment: session.assignmentMetadata || {},
        organization_id: session.organizationId,
        expected_staff_name: person.name || person.fullName || "",
        expected_patient_name: session.patient?.name || "",
        expected_patient_address: session.patient?.address || "",
        employee: { name: person.name || person.fullName || "" },
        patient: { name: session.patient?.name || "", address: session.patient?.address || "" },
      };
      const templateScenario = chiefVoiceTemplateScenario({ stage, attemptNumber, consecutiveNoAnswer, technicalFailureRetry });
      const call = await chiefvoice.createOutboundCall({
        to: person.phoneNumber,
        from: session.fromNumber || process.env.CHIEFVOICE_CALLER_ID,
        sessionId,
        stage,
        callAttemptId: attempt.id,
        context: callContext,
        postCallContext,
        templateScenario,
      });
      const providerCallId = call.session_id || call.call_id || call.id;
      if (!providerCallId) throw new Error("ChiefVoice response did not include session_id; reconcile before retrying");
      await repository.attachProviderCallId(attempt.id, providerCallId, call, "chiefvoice");
    } catch (error) {
      // A timeout may mean ChiefVoice accepted the request but its response was
      // lost. Do not blindly redial; mark the placement for reconciliation.
      await repository.markCallPlacementFailed(attempt.id, error.message);
      await repository.setStageStatus(sessionId, stage, "review", { reason: "call_placement_unknown", callAttemptId: attempt.id });
      throw error;
    }
    await queue.enqueue("poll_chiefvoice_call", { callAttemptId: attempt.id, pollCount: 0 }, {
      idempotencyKey: `chiefvoice-poll:${attempt.id}:0`,
      runAt: new Date(Date.now() + (Number(process.env.CHIEFVOICE_POLL_INITIAL_MS) || 15_000)),
    });
  }

  async function pollChiefVoiceCall({ callAttemptId, pollCount = 0 }) {
    const attempt = await repository.getCallAttempt(callAttemptId);
    if (!attempt?.providerCallId || attempt.provider !== "chiefvoice" || attempt.outcome) return;
    const maxPolls = Number(process.env.CHIEFVOICE_POLL_MAX_ATTEMPTS) || 60;
    if (pollCount >= maxPolls) {
      await repository.setStageStatus(attempt.sessionId, attempt.stage, "review", {
        reason: "chiefvoice_poll_limit_reached", callAttemptId,
      });
      return;
    }
    const scheduleNext = async () => {
      const delay = Math.min(60_000, (Number(process.env.CHIEFVOICE_POLL_INTERVAL_MS) || 15_000) * Math.max(1, Math.ceil((pollCount + 1) / 4)));
      await queue.enqueue("poll_chiefvoice_call", { callAttemptId, pollCount: pollCount + 1 }, {
        idempotencyKey: `chiefvoice-poll:${callAttemptId}:${pollCount + 1}`,
        runAt: new Date(Date.now() + delay),
      });
    };

    let callStatus;
    try {
      callStatus = await chiefvoice.getCallStatus(attempt.providerCallId);
    } catch (error) {
      if (error.status === 404 || error.status >= 500 || !error.status) return scheduleNext();
      throw error;
    }
    const callDisposition = classifyCallStatus(callStatus.status);
    if (callDisposition === "not_answered" || callDisposition === "cancelled") {
      await repository.updateCallByProviderId({
        provider: "chiefvoice", providerCallId: attempt.providerCallId, status: callStatus.status,
        endedAt: callStatus.ended_at || new Date().toISOString(),
        rawEvent: { EndTime: callStatus.ended_at || null },
      });
      await queue.enqueue("process_call_result", { callAttemptId }, { idempotencyKey: `call-result:${callAttemptId}` });
      return;
    }
    try {
      const postCall = await chiefvoice.getPostCallResult(attempt.providerCallId);
      if (postCall.status === "completed" && postCall.result) {
        const eventId = `poll:${attempt.providerCallId}:analysis-completed`;
        const event = normalizeChiefVoiceWebhook({
          event_id: eventId,
          event: "call.analysis.completed",
          call: { session_id: attempt.providerCallId, started_at: callStatus.started_at, ended_at: postCall.ended_at || callStatus.ended_at || new Date().toISOString() },
          result: postCall.result,
        }, { headerEventId: eventId, headerEventType: "call.analysis.completed" });
        await processChiefVoiceResult({ event, repository, queue });
        return;
      }
      if (postCall.status === "failed") {
        const failure = postCall.failure && typeof postCall.failure === "object" ? postCall.failure : {};
        if (isNoAnswerFailureCode(failure.code || postCall.failure_code)) {
          await repository.updateCallByProviderId({
            provider: "chiefvoice",
            providerCallId: attempt.providerCallId,
            status: "no-answer",
            durationSeconds: callStatus.duration_seconds || callStatus.durationSeconds || null,
            endedAt: callStatus.ended_at || new Date().toISOString(),
            failure: {
              stage: "post_call",
              code: String(failure.code || postCall.failure_code),
              retryable: failure.retryable === true,
              attempts: Number.isSafeInteger(failure.attempts) ? failure.attempts : null,
            },
            rawEvent: {
              AnswerTime: callStatus.answered_at || callStatus.answer_time || callStatus.AnswerTime || null,
              EndTime: callStatus.ended_at || null,
            },
          });
          await queue.enqueue("process_call_result", { callAttemptId }, {
            idempotencyKey: `call-result:${callAttemptId}`,
          });
          return;
        }
        await repository.setStageStatus(attempt.sessionId, attempt.stage, "review", {
          reason: "chiefvoice_post_call_failed", callAttemptId,
        });
        return;
      }
    } catch (error) {
      if (error.status !== 404 && error.status < 500) throw error;
    }
    await scheduleNext();
  }

  async function syncChiefVoiceArtifacts({ callAttemptId, pollCount = 0 }) {
    const attempt = await repository.getCallAttempt(callAttemptId);
    if (!attempt?.providerCallId || attempt.provider !== "chiefvoice" || !attempt.sessionId) return;
    const retryLater = async () => {
      const maxPolls = Number(process.env.CHIEFVOICE_ARTIFACT_POLL_MAX_ATTEMPTS) || 12;
      if (pollCount >= maxPolls) {
        console.warn(`[attendance-worker] ChiefVoice artifacts remain unavailable attempt=${callAttemptId}`);
        return;
      }
      const nextPoll = pollCount + 1;
      const delayMs = Number(process.env.CHIEFVOICE_ARTIFACT_POLL_INTERVAL_MS) || 30_000;
      await queue.enqueue("sync_chiefvoice_artifacts", { callAttemptId, pollCount: nextPoll }, {
        idempotencyKey: `chiefvoice-artifacts:${callAttemptId}:${nextPoll}`,
        runAt: new Date(Date.now() + delayMs),
      });
    };

    const [statusResult, postCallResult, transcriptResult] = await Promise.allSettled([
      chiefvoice.getCallStatus(attempt.providerCallId),
      chiefvoice.getPostCallResult(attempt.providerCallId),
      chiefvoice.getTranscript(attempt.providerCallId),
    ]);
    for (const result of [statusResult, postCallResult, transcriptResult]) {
      if (result.status === "rejected" && result.reason?.status !== 404) throw result.reason;
    }
    const sources = [
      statusResult.status === "fulfilled" ? statusResult.value : null,
      postCallResult.status === "fulfilled" ? postCallResult.value : null,
      postCallResult.status === "fulfilled" ? postCallResult.value?.result : null,
      postCallResult.status === "fulfilled" ? postCallResult.value?.call : null,
      transcriptResult.status === "fulfilled" ? transcriptResult.value : null,
    ];
    const transcript = extractChiefVoiceTranscript(...sources);
    let transcriptSaved = Boolean(await repository.getTranscriptForCall(callAttemptId));
    if (transcript && !transcriptSaved) {
      const session = await repository.getAttendanceSession(attempt.sessionId);
      const language = sources.map((source) => source?.transcript_language || source?.transcriptLanguage || source?.language)
        .find((value) => typeof value === "string" && value.trim()) || session?.language || "";
      await repository.saveTranscript({
        organizationId: attempt.organizationId,
        sessionId: attempt.sessionId,
        callAttemptId,
        language,
        text: transcript,
      });
      transcriptSaved = true;
    }

    const recordingExpected = process.env.CHIEFVOICE_RECORDING_ALLOWED === "true";
    let recordingSaved = Boolean(attempt.recordingObjectKey);
    let recordingPending = false;
    if (recordingExpected && !recordingSaved) {
      if (!recordings?.storeProviderRecordingBuffer) throw new Error("ChiefVoice recording storage is unavailable");
      try {
        const recording = await chiefvoice.getRecording(attempt.providerCallId);
        const stored = await recordings.storeProviderRecordingBuffer(recording.buffer, {
          organizationId: attempt.organizationId,
          sessionId: attempt.sessionId,
          callAttemptId,
          contentType: recording.contentType,
        });
        await repository.setRecordingObjectKey(callAttemptId, stored.key, stored.contentType);
        recordingSaved = true;
      } catch (error) {
        if (error.status === 404) recordingPending = true;
        else throw error;
      }
    }
    if ((!transcriptSaved || (recordingExpected && !recordingSaved)) && (recordingPending || postCallResult.status === "rejected" || !transcriptSaved)) {
      await retryLater();
    }
  }

  async function processCallResult({ callAttemptId }) {
    const attempt = await repository.getCallAttempt(callAttemptId);
    if (!attempt) return;
    const callDisposition = classifyCallStatus(attempt.status);
    if (callDisposition === "cancelled") {
      await repository.setStageStatus(attempt.sessionId, attempt.stage, "review", {
        reason: "chiefvoice_call_cancelled", callAttemptId,
      });
      return;
    }
    if (callDisposition === "not_answered") {
      if (attempt.failure?.stage !== "post_call" && attempt.failure && !isNoAnswerFailureCode(attempt.failure.code)) {
        const maxTechnicalAttempts = Math.max(1, Number(process.env.CHIEFVOICE_CALL_FAILURE_MAX_ATTEMPTS) || 2);
        if (!attempt.failure.retryable || attempt.attemptNumber >= maxTechnicalAttempts) {
          await repository.setStageStatus(attempt.sessionId, attempt.stage, "review", {
            reason: "chiefvoice_call_failed", failureCode: attempt.failure.code,
            failureRetryable: attempt.failure.retryable, failureAttempts: attempt.failure.attempts, callAttemptId,
          });
          await queue.enqueue("evaluate_session", { sessionId: attempt.sessionId, stage: attempt.stage }, {
            idempotencyKey: `evaluate:${attempt.sessionId}:call-failed:${callAttemptId}`,
          });
          return;
        }
        const settings = repository.getOrganizationCallSettings
          ? await repository.getOrganizationCallSettings(attempt.organizationId) : {};
        const delayMinutes = settings.callRetry?.initialMinutes ?? retry.initialMinutes ?? 3;
        const runAt = new Date(Date.now() + Math.max(1, Number(delayMinutes)) * 60_000);
        const session = await repository.getAttendanceSession(attempt.sessionId);
        await repository.setStageStatus(attempt.sessionId, attempt.stage, "follow_up", {
          reason: "chiefvoice_call_failed_retry", failureCode: attempt.failure.code, nextCallAt: runAt.toISOString(),
        });
        await queue.enqueue("place_call", {
          sessionId: attempt.sessionId, taskId: taskFor(session, attempt.stage)?.id, stage: attempt.stage,
          attemptNumber: attempt.attemptNumber + 1, consecutiveNoAnswer: attempt.consecutiveNoAnswerBefore || 0,
          technicalFailureRetry: true,
        }, { idempotencyKey: `call:${attempt.sessionId}:${attempt.stage}:${attempt.attemptNumber + 1}`, runAt });
        return;
      }
      const noAnswerCount = (attempt.consecutiveNoAnswerBefore || 0) + 1;
      const organizationSettings = repository.getOrganizationCallSettings ? await repository.getOrganizationCallSettings(attempt.organizationId) : {};
      const retrySettings = organizationSettings.callRetry || {};
      const initialMinutes = retrySettings.initialMinutes ?? retry.initialMinutes ?? 3;
      const multiplier = retrySettings.multiplier ?? retry.multiplier ?? 1.2;
      const maxMinutes = retrySettings.maxMinutes ?? retry.maxMinutes ?? 30;
      const maxConsecutiveNoAnswer = retrySettings.maxConsecutiveNoAnswer ?? retry.maxConsecutiveNoAnswer ?? 3;
      const config = { initialMs: initialMinutes * 60_000, multiplier, maxMs: maxMinutes * 60_000 };
      if (noAnswerCount >= maxConsecutiveNoAnswer) {
        await repository.setStageStatus(attempt.sessionId, attempt.stage, "not_answered", { reason: "consecutive_no_answer_limit_reached", consecutiveNoAnswer: noAnswerCount });
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
    if (callDisposition !== "answered") return;
    if (!attempt.outcome) {
      // The call-completed event can arrive before ChiefVoice finishes its
      // separate post-call analysis. The placement workflow already polls for
      // that result; don't expose a premature Review while that poll is active.
      if (attempt.provider === "chiefvoice" && attempt.providerCallId) return;
      await repository.setStageStatus(attempt.sessionId, attempt.stage, "review", { reason: "chiefvoice_post_call_result_missing", callAttemptId });
      await queue.enqueue("evaluate_session", { sessionId: attempt.sessionId, stage: attempt.stage }, { idempotencyKey: `evaluate:${attempt.sessionId}:missing-result:${callAttemptId}` });
      return;
    }
    await queue.enqueue("evaluate_attendance", { sessionId: attempt.sessionId, callAttemptId }, { idempotencyKey: `decision:${callAttemptId}` });
  }

  async function extractIntent({ callAttemptId, transcriptPollCount = 0 }) {
    const attempt = await repository.getCallAttempt(callAttemptId);
    if (!attempt) return;
    const session = await repository.getAttendanceSession(attempt.sessionId);
    if (!session || !attempt.outcome) {
      await repository.setStageStatus(attempt.sessionId, attempt.stage, "review", { reason: "chiefvoice_post_call_result_missing", callAttemptId });
      return;
    }
    const outcome = { ...attempt.outcome };
    let transcriptRecord = await repository.getTranscriptForCall(callAttemptId);
    let transcriptText = String(transcriptRecord?.text || "").trim();
    if (!transcriptText && attempt.provider === "chiefvoice" && attempt.providerCallId) {
      try {
        const transcriptResult = await chiefvoice.getTranscript(attempt.providerCallId);
        transcriptText = extractChiefVoiceTranscript(transcriptResult) || "";
        if (transcriptText) {
          await repository.saveTranscript({
            organizationId: attempt.organizationId,
            sessionId: attempt.sessionId,
            callAttemptId,
            language: transcriptResult?.transcript_language || transcriptResult?.language || session.language || "",
            text: transcriptText,
          });
        }
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    if (!transcriptText) {
      const maxTranscriptPolls = Math.max(0, Number(process.env.CHIEFVOICE_TRANSCRIPT_POLL_MAX_ATTEMPTS) || 3);
      if (transcriptPollCount < maxTranscriptPolls) {
        const pollIntervalMs = Math.max(1_000, Number(process.env.CHIEFVOICE_TRANSCRIPT_POLL_INTERVAL_MS) || 15_000);
        await queue.enqueue("extract_intent", { callAttemptId, transcriptPollCount: transcriptPollCount + 1 }, {
          idempotencyKey: `extract:${callAttemptId}:transcript:${transcriptPollCount + 1}`,
          runAt: new Date(Date.now() + pollIntervalMs),
        });
        return;
      }
    }
    const noCallerSpeech = attempt.provider === "chiefvoice" && !hasCallerSpeechTranscript(transcriptText);
    if (noCallerSpeech) {
      // A completed/answered call with only the agent's greeting (or with no
      // saved transcript after bounded polling) is operationally a no-answer.
      outcome.employeeIntent = "no_human_answer";
      outcome.requestedCallbackAt = null;
      outcome.exceptionCode = null;
    }
    const endedAt = new Date(attempt.endedAt || attempt.updatedAt || Date.now());
    const callEndedAt = Number.isFinite(endedAt.getTime()) ? endedAt.toISOString() : new Date().toISOString();
    const now = new Date(callEndedAt);
    const stageTimeField = attempt.stage === "check_in" ? "reportedArrivalTime" : "reportedDepartureTime";
    const stageTimeMentionedField = attempt.stage === "check_in" ? "reportedArrivalTimeMentioned" : "reportedDepartureTimeMentioned";
    const scheduledStageTime = attempt.stage === "check_in" ? session.scheduledStartAt : session.scheduledEndAt;
    const reportedTimeError = noCallerSpeech ? null : validateReportedTime(outcome[stageTimeField], now);
    if (reportedTimeError === "reported_time_invalid") {
      // A malformed optional extraction should not invalidate an otherwise
      // confirmed call. Treat it as absent and use a safe backend timestamp.
      outcome[stageTimeField] = null;
      outcome[stageTimeMentionedField] = false;
      outcome[`${stageTimeField}Source`] = "invalid_reported_time_fallback";
    } else if (reportedTimeError) {
      outcome.exceptionCode = reportedTimeError;
      outcome.employeeIntent = "unclear";
      outcome.summary = `${outcome.summary || ""} ${reportedTimeError === "future_reported_time" ? "Reported attendance time is later than call completion." : "Reported attendance time could not be parsed."}`.trim();
    }
    if (!reportedTimeError || reportedTimeError === "reported_time_invalid") {
      if (outcome.employeeIntent === (attempt.stage === "check_in" ? "arrival_confirmed" : "departure_confirmed") && outcome[stageTimeMentionedField] === false) {
        const scheduledDate = scheduledStageTime ? new Date(scheduledStageTime) : null;
        const safeScheduledDate = scheduledDate && Number.isFinite(scheduledDate.getTime()) && scheduledDate <= now ? scheduledDate : null;
        outcome[stageTimeField] = safeScheduledDate ? safeScheduledDate.toISOString() : callEndedAt;
        outcome[`${stageTimeField}Source`] = safeScheduledDate ? "scheduled_time_fallback" : "call_time_fallback";
        const fallbackTimeError = validateReportedTime(outcome[stageTimeField], now);
        if (fallbackTimeError) {
          outcome.exceptionCode = fallbackTimeError === "future_reported_time" ? "scheduled_time_in_future" : fallbackTimeError;
          outcome.employeeIntent = "unclear";
        }
      }
    }
    if (noCallerSpeech) {
      outcome[stageTimeField] = null;
      outcome[stageTimeMentionedField] = false;
    }
    await repository.saveCallOutcome(callAttemptId, outcome);
    await queue.enqueue("evaluate_attendance", { sessionId: session.id, callAttemptId }, { idempotencyKey: `decision:${callAttemptId}` });
  }

  async function evaluateAttendance({ sessionId, callAttemptId }) {
    const session = await repository.getAttendanceSession(sessionId);
    if (!session || session.sessionStatus === "completed") return;
    if (callAttemptId) {
      const attempt = await repository.getCallAttempt(callAttemptId);
      if (!attempt) return;
      const outcome = { ...(attempt.outcome || {}) };
      if (!outcome.requestedCallbackAt && ["will_arrive_later", "still_on_duty"].includes(outcome.employeeIntent)) {
        const transcript = await repository.getTranscriptForCall(callAttemptId);
        const referenceDate = new Date(attempt.endedAt || Date.now());
        outcome.requestedCallbackAt = inferRequestedCallbackAt(transcript?.text, referenceDate);
        if (outcome.requestedCallbackAt) {
          await repository.saveCallOutcome(callAttemptId, outcome);
        }
      }
      const decision = chooseAttendanceAction(attempt.stage, outcome);
      if (decision.action === "retry_no_answer") {
        const noAnswerCount = (attempt.consecutiveNoAnswerBefore || 0) + 1;
        const settings = repository.getOrganizationCallSettings ? await repository.getOrganizationCallSettings(session.organizationId) : {};
        const retrySettings = settings.callRetry || {};
        const maxConsecutiveNoAnswer = retrySettings.maxConsecutiveNoAnswer ?? retry.maxConsecutiveNoAnswer ?? 3;
        if (noAnswerCount >= maxConsecutiveNoAnswer) {
          await repository.setStageStatus(sessionId, attempt.stage, "not_answered", {
            reason: "automated_answer_no_human_retry_limit_reached", consecutiveNoAnswer: noAnswerCount, callAttemptId,
          });
          await queue.enqueue("evaluate_session", { sessionId, stage: attempt.stage }, {
            idempotencyKey: `evaluate:automated-answer-limit:${sessionId}:${attempt.stage}`,
          });
        } else {
          const initialMinutes = retrySettings.initialMinutes ?? retry.initialMinutes ?? 3;
          const multiplier = retrySettings.multiplier ?? retry.multiplier ?? 1.2;
          const maxMinutes = retrySettings.maxMinutes ?? retry.maxMinutes ?? 30;
          const runAt = new Date(Date.now() + backoffMilliseconds(attempt.attemptNumber, {
            initialMs: initialMinutes * 60_000, multiplier, maxMs: maxMinutes * 60_000,
          }));
          const nextNumber = await repository.nextAttemptNumber(sessionId, attempt.stage);
          await repository.setStageStatus(sessionId, attempt.stage, "follow_up", {
            reason: "automated_answer_no_human_retry", nextCallAt: runAt.toISOString(), consecutiveNoAnswer: noAnswerCount, callAttemptId,
          });
          await queue.enqueue("place_call", {
            sessionId, taskId: taskFor(session, attempt.stage)?.id, stage: attempt.stage,
            attemptNumber: nextNumber, consecutiveNoAnswer: noAnswerCount,
          }, { idempotencyKey: `call:${sessionId}:${attempt.stage}:${nextNumber}`, runAt });
        }
      } else if (decision.action === "confirm_stage") {
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
            // Honor the explicit absolute callback time returned by ChiefVoice.
            // Capping a check-in callback at the scheduled check-out time
            // silently changed the caregiver's requested delay.
            const callbackAt = runAt;
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
        assignmentId: session.assignmentId,
        patientId: patient.id,
        patientUhid: patient.patientUhid || patient.uhid,
        careManagerExternalId: session.metadata?.careManagerId,
        title: `Unanswered ${stageLabel} calls`,
        message: `${session.employee?.name || "Assigned staff"} did not answer ${maxNoAnswer} ${stageLabel} calls for ${patient.name || "the assigned patient"}. Please follow up.`,
        referenceType: "attendance_stage",
        referenceId: `${session.id}:${stage}`,
        type: escalation === "call_care_manager" ? "care_manager_call_log" : "unanswered_call",
      });
      let careManagerNotified = notifications.some((manager) => manager.notificationCreated === true);
      if (escalation === "call_care_manager") {
        careManagerNotified = false;
        const managers = [...notifications];
        const sessionManagerPhone = normalizeIndianMobile(session.metadata?.careManagerPhone);
        if (sessionManagerPhone && !managers.some((manager) => normalizeIndianMobile(manager.careManagerPhone) === sessionManagerPhone)) {
          managers.push({
            id: session.metadata?.careManagerId || session.assignmentId,
            careManagerName: session.metadata?.careManagerName || "Assigned care manager",
            careManagerPhone: sessionManagerPhone,
          });
        }
        let escalationError = null;
        for (const manager of managers) {
          const managerPhone = normalizeIndianMobile(manager.careManagerPhone);
          if (!managerPhone) {
            if (manager.careManagerPhone) console.warn(`[attendance-worker] invalid care-manager phone; cannot place escalation session=${session.id} manager=${manager.id}`);
            continue;
          }
          const escalationAttemptId = `escalation-${session.id}-${stage}-${manager.id}`;
          try {
            await chiefvoice.createOutboundCall({
              to: managerPhone, from: session.fromNumber || process.env.CHIEFVOICE_CALLER_ID,
              sessionId: session.id, stage, callAttemptId: escalationAttemptId,
              templateScenario: "CARE_MANAGER_ESCALATION",
              context: {
                call_purpose: "care_manager_escalation",
                message: `Athulya attendance alert. ${session.employee?.name || "Assigned staff"} did not answer repeated ${stageLabel} calls for ${patient.name || "the assigned patient"}. Please contact operations.`,
                care_manager_name: manager.careManagerName || manager.displayName || manager.name || "", organization_id: session.organizationId,
                expected_staff_name: session.employee?.name || session.employee?.fullName || "",
                expected_patient_name: patient.name || "",
                expected_patient_address: session.patient?.address || "",
                escalation_message: `Repeated ${stageLabel} calls were unanswered. Please contact operations.`,
                language: session.language || "ta-IN",
              },
            });
            careManagerNotified = true;
          } catch (error) {
            console.error(`[attendance-worker] ChiefVoice care-manager escalation failed session=${session.id} stage=${stage}: ${error.message}`);
            escalationError ||= error;
          }
        }
        if (escalationError) {
          // Let the durable worker retry this stage-level escalation. The
          // provider idempotency key prevents duplicate calls if ChiefVoice
          // accepted a request but the response was lost.
          throw escalationError;
        }
      } else if (careManagerNotified) {
        const recipients = notifications.filter((manager) => manager.notificationCreated === true).length;
        console.info(`[attendance-worker] care-manager platform notification created session=${session.id} stage=${stage} recipients=${recipients}`);
      }
      await repository.setStageStatus(sessionId, stage, "not_answered", {
        reason: "consecutive_no_answer_limit_reached",
        consecutiveNoAnswer: maxNoAnswer,
        careManagerNotified,
      });
      if (escalation === "call_care_manager" && !careManagerNotified) {
        console.info(`[attendance-worker] no reachable care manager found; keeping stage not_answered session=${session.id} stage=${stage}`);
      }
    }
    const terminal = new Set(["confirmed", "missed", "not_answered", "review"]);
    if (terminal.has(session.checkInStatus) && terminal.has(session.checkOutStatus)
      && (session.checkInStatus !== "confirmed" || session.checkOutStatus !== "confirmed")) {
      await repository.markSessionException(sessionId);
    }
  }

  // ChiefVoice owns live conversation and structured post-call extraction.
  // This worker retains deterministic attendance policy, retries and delivery.
  return {
    place_call: placeCall,
    poll_chiefvoice_call: pollChiefVoiceCall,
    sync_chiefvoice_artifacts: syncChiefVoiceArtifacts,
    process_call_result: processCallResult,
    extract_intent: extractIntent,
    evaluate_attendance: evaluateAttendance,
    evaluate_session: evaluateSession,
    deliver_attendance: deliverAttendance,
    ...additionalHandlers,
  };
}

module.exports = { createAttendanceHandlers, classifyCallStatus, chooseAttendanceAction, normalizeCallbackTime, inferRequestedCallbackAt };
