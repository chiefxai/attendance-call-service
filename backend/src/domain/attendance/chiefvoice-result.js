"use strict";

const { mapChiefVoiceAttendanceResult } = require("../../infrastructure/integrations/chiefvoice-webhook");
const { isNoAnswerFailureCode } = require("./call-failure");

async function processChiefVoiceResult({ event, repository, queue }) {
  return queue.transaction(async (client) => {
    const firstDelivery = await repository.claimChiefVoiceWebhookEvent({
      eventId: event.eventId,
      providerCallId: event.providerCallId,
      eventType: event.eventType,
      client,
    });
    if (!firstDelivery) return { duplicate: true };

    const attempt = await repository.updateCallByProviderId({
      provider: "chiefvoice", providerCallId: event.providerCallId, status: event.status,
      durationSeconds: event.durationSeconds, endedAt: event.endedAt,
      rawEvent: { event: event.eventType, status: event.status, EndTime: event.endedAt },
    });
    if (!attempt) throw Object.assign(new Error("Call attempt not found"), { status: 404, safeCode: "call_not_found" });

    if (attempt.sessionId) {
      if (attempt.callTargetRole === "care_manager") {
        await queue.enqueue("process_call_result", { callAttemptId: attempt.id }, {
          idempotencyKey: `call-result:${attempt.id}`, client,
        });
        return { duplicate: false, careManagerAttempt: true };
      }
      const session = await repository.getAttendanceSession(attempt.sessionId);
      if (event.transcript) {
        await repository.saveTranscript({
          organizationId: attempt.organizationId,
          sessionId: attempt.sessionId,
          callAttemptId: attempt.id,
          language: event.transcriptLanguage || session?.language || "",
          text: event.transcript,
        });
      }
      const result = event.postCallResult;
      const outcome = {
        ...result,
        employeeIntent: result.employeeIntent ?? result.employee_intent,
        employeeNameConfirmed: result.employeeNameConfirmed ?? result.employee_name_confirmed,
        patientNameConfirmed: result.patientNameConfirmed ?? result.patient_name_confirmed,
        addressConfirmed: result.addressConfirmed ?? result.address_confirmed,
        employeeVerified: result.employeeVerified ?? result.employee_verified,
        clientVerified: result.clientVerified ?? result.client_verified,
        reachedPatient: result.reachedPatient ?? result.reached_patient,
        dutyComplete: result.dutyComplete ?? result.duty_complete,
        reportedArrivalTime: result.reportedArrivalTime ?? result.reported_arrival_time,
        reportedDepartureTime: result.reportedDepartureTime ?? result.reported_departure_time,
        reportedArrivalTimeMentioned: result.reportedArrivalTimeMentioned ?? result.reported_arrival_time_mentioned,
        reportedDepartureTimeMentioned: result.reportedDepartureTimeMentioned ?? result.reported_departure_time_mentioned,
        requestedCallbackAt: result.requestedCallbackAt ?? result.requested_callback_at,
        exceptionCode: result.exceptionCode ?? result.exception_code,
        ...mapChiefVoiceAttendanceResult(result, { stage: attempt.stage, session }),
      };
      await repository.saveCallOutcome(attempt.id, outcome);
      const currentStatus = attempt.stage === "check_in" ? session?.checkInStatus : session?.checkOutStatus;
      if (currentStatus === "calling") {
        await repository.setStageStatus(attempt.sessionId, attempt.stage, "processing", {
          reason: "chiefvoice_post_call_completed", callAttemptId: attempt.id,
        });
      }
      await queue.enqueue("extract_intent", { callAttemptId: attempt.id }, {
        idempotencyKey: `extract:${attempt.id}`, client,
      });
      await queue.enqueue("sync_chiefvoice_artifacts", { callAttemptId: attempt.id, pollCount: 0 }, {
        idempotencyKey: `chiefvoice-artifacts:${attempt.id}:0`, client,
        runAt: new Date(Date.now() + 10_000),
      });
    }
    return { duplicate: false };
  });
}

async function processChiefVoiceFailure({ event, repository, queue }) {
  return queue.transaction(async (client) => {
    const firstDelivery = await repository.claimChiefVoiceWebhookEvent({
      eventId: event.eventId,
      providerCallId: event.providerCallId,
      eventType: event.eventType,
      client,
    });
    if (!firstDelivery) return { duplicate: true };

    const attempt = await repository.updateCallByProviderId({
      provider: "chiefvoice",
      providerCallId: event.providerCallId,
      status: event.status,
      durationSeconds: event.durationSeconds,
      endedAt: event.endedAt,
      failure: event.failure,
      rawEvent: { event: event.eventType, status: event.status, EndTime: event.endedAt },
    });
    if (!attempt) throw Object.assign(new Error("Call attempt not found"), { status: 404, safeCode: "call_not_found" });

    const noAnswer = isNoAnswerFailureCode(event.failure.code)
      || (event.eventType === "call.post_call.failed" && !attempt.answeredAt);
    if (attempt.callTargetRole === "care_manager" && attempt.sessionId) {
      await queue.enqueue("process_call_result", { callAttemptId: attempt.id }, {
        idempotencyKey: `call-result:${attempt.id}`, client,
      });
      return { duplicate: false, careManagerAttempt: true };
    }
    if (attempt.sessionId && (noAnswer || (event.eventType === "call.failed" && event.failure.retryable))) {
      // Some unanswered calls are reported as a post-call analysis failure
      // because there is no transcript to analyze. Keep them on the no-answer
      // retry path instead of making the stage terminal in Review.
      if (event.eventType === "call.post_call.failed" && noAnswer) {
        await repository.updateCallByProviderId({
          provider: "chiefvoice",
          providerCallId: event.providerCallId,
          status: "no-answer",
          durationSeconds: event.durationSeconds,
          endedAt: event.endedAt,
          failure: event.failure,
          rawEvent: { EndTime: event.endedAt || null },
        });
      }
      await queue.enqueue("process_call_result", { callAttemptId: attempt.id }, {
        idempotencyKey: `call-result:${attempt.id}`,
        client,
      });
    } else if (attempt.sessionId) {
      await repository.setStageStatus(attempt.sessionId, attempt.stage, "review", {
        reason: event.eventType === "call.post_call.failed" ? "chiefvoice_post_call_failed" : "chiefvoice_call_failed",
        failureCode: event.failure.code,
        failureRetryable: event.failure.retryable,
        failureAttempts: event.failure.attempts,
        callAttemptId: attempt.id,
      });
      await queue.enqueue("evaluate_session", { sessionId: attempt.sessionId, stage: attempt.stage }, {
        idempotencyKey: `evaluate:${attempt.sessionId}:chiefvoice-failed:${attempt.id}`,
        client,
      });
    }
    return { duplicate: false };
  });
}

module.exports = { processChiefVoiceResult, processChiefVoiceFailure };

