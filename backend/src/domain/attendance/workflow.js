"use strict";

const { backoffMilliseconds } = require("../../infrastructure/database/postgres-queue");

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
    if (outcome.employeeIntent === "arrival_confirmed" && outcome.employeeVerified === true && outcome.clientVerified === true && outcome.reachedPatient === true && outcome.reportedArrivalTime) {
      return { action: "confirm_stage", reportedAt: outcome.reportedArrivalTime || null };
    }
    if (outcome.employeeIntent === "will_arrive_later" || outcome.requestedCallbackAt) {
      return { action: "follow_up", runAt: outcome.requestedCallbackAt || null };
    }
    return { action: "review", reason: "check_in_not_confirmed" };
  }
  if (stage === "check_out") {
    if (outcome.employeeIntent === "departure_confirmed" && outcome.employeeVerified === true && outcome.clientVerified === true && outcome.dutyComplete === true && outcome.reportedDepartureTime) {
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

  async function placeCall({ sessionId, stage, attemptNumber, capacityWaitCount = 0, consecutiveNoAnswer = 0 }) {
    const session = await repository.getAttendanceSession(sessionId);
    // A terminal result for one stage must not suppress the other scheduled
    // stage. The session becomes an exception only after both stages settle.
    if (!session || session.sessionStatus === "completed") return;
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
      throw error;
    }
  }

  async function processCallResult({ callAttemptId }) {
    const attempt = await repository.getCallAttempt(callAttemptId);
    if (!attempt) return;
    if (classifyCallStatus(attempt.status) === "not_answered") {
      const noAnswerCount = (attempt.consecutiveNoAnswerBefore || 0) + 1;
      const config = { initialMs: (retry.initialMinutes || 5) * 60_000, multiplier: retry.multiplier || 1.2, maxMs: (retry.maxMinutes || 30) * 60_000 };
      if (noAnswerCount >= (retry.maxConsecutiveNoAnswer || 5)) {
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
      const inferredCallbackAt = inferRequestedCallbackAt(transcript.text, attempt.endedAt ? new Date(attempt.endedAt) : new Date());
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

    const current = await repository.getAttendanceSession(sessionId);
    if (current.checkInStatus === "confirmed" && current.checkOutStatus === "confirmed") {
      await repository.markSessionCompleted(sessionId);
      await queue.enqueue("deliver_attendance", { sessionId }, { idempotencyKey: `deliver:${sessionId}` });
    } else {
      const terminal = new Set(["confirmed", "missed", "not_answered", "review"]);
      const bothStagesSettled = terminal.has(current.checkInStatus) && terminal.has(current.checkOutStatus);
      if (bothStagesSettled) await repository.markSessionException(sessionId);
    }
  }

  async function deliverAttendance({ sessionId }) {
    const session = await repository.getAttendanceSession(sessionId);
    if (!session || session.checkInStatus !== "confirmed" || session.checkOutStatus !== "confirmed") return;
    const result = await backend.sendAttendance(await repository.buildBackendAttendancePayload(sessionId), {
      idempotencyKey: `attendance-session:${sessionId}`,
    });
    await repository.markBackendDelivered(sessionId, result);
    if (activeSessionCache?.delete) await activeSessionCache.delete(sessionId);
  }

  async function evaluateSession({ sessionId }) {
    const session = await repository.getAttendanceSession(sessionId);
    if (!session) return;
    const terminal = new Set(["confirmed", "missed", "not_answered", "review"]);
    const bothStagesSettled = terminal.has(session.checkInStatus) && terminal.has(session.checkOutStatus);
    if (bothStagesSettled && (session.checkInStatus !== "confirmed" || session.checkOutStatus !== "confirmed")) {
      await repository.markSessionException(sessionId);
    }
  }

  return {
    place_call: placeCall,
    process_call_result: processCallResult,
    wait_for_recording: waitForRecording,
    transcribe_call: transcribeCall,
    extract_intent: extractIntent,
    evaluate_attendance: evaluateAttendance,
    evaluate_session: evaluateSession,
    deliver_attendance: deliverAttendance,
  };
}

module.exports = { createAttendanceHandlers, classifyCallStatus, chooseAttendanceAction, normalizeCallbackTime, inferRequestedCallbackAt };
