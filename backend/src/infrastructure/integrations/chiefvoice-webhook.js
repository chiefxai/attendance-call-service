"use strict";

const crypto = require("node:crypto");

const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 300;

/**
 * ChiefVoice signs: timestamp + "." + event_id + "." + exact raw request body.
 * X-Chiefvoice-Signature is "sha256=<hex HMAC-SHA256>".
 */
function verifyChiefVoiceSignature({
  secret,
  timestamp,
  eventId,
  signature,
  rawBody,
  now = Date.now(),
  toleranceSeconds = DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
}) {
  if (!secret || !Buffer.isBuffer(rawBody) || rawBody.length === 0) return false;
  if (!/^\d{10}$/.test(String(timestamp || ""))) return false;
  if (!eventId || String(eventId).length > 200) return false;

  const timestampSeconds = Number(timestamp);
  const nowSeconds = now instanceof Date ? Math.floor(now.getTime() / 1000) : Math.floor(Number(now) / 1000);
  if (!Number.isSafeInteger(timestampSeconds) || !Number.isFinite(nowSeconds)) return false;
  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) return false;

  const suppliedHex = String(signature || "").replace(/^sha256=/i, "");
  if (!/^[a-f0-9]{64}$/i.test(suppliedHex)) return false;

  const signedPayload = Buffer.concat([
    Buffer.from(`${timestamp}.${eventId}.`, "utf8"),
    rawBody,
  ]);
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest();
  const supplied = Buffer.from(suppliedHex, "hex");
  return supplied.length === expected.length && crypto.timingSafeEqual(expected, supplied);
}

/**
 * Normalize ChiefVoice's call.analysis.completed envelope.
 * ChiefVoice sends call.session_id and the structured extraction at top-level result;
 * it does not include the transcript in this webhook.
 */
function normalizeChiefVoiceWebhook(payload, { headerEventId, headerEventType } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("ChiefVoice webhook body must be a JSON object");
  }

  const eventId = String(headerEventId || payload.event_id || "").trim();
  const bodyEventId = String(payload.event_id || "").trim();
  const eventType = String(headerEventType || payload.event || "").trim();
  const bodyEventType = String(payload.event || "").trim();

  if (!eventId || !bodyEventId || eventId !== bodyEventId) {
    throw new Error("ChiefVoice event ID header does not match the payload");
  }
  if (eventType !== "call.analysis.completed" || bodyEventType !== eventType) {
    throw new Error("Unsupported or inconsistent ChiefVoice event type");
  }

  const call = payload.call;
  if (!call || typeof call !== "object" || Array.isArray(call)) {
    throw new Error("ChiefVoice webhook is missing call metadata");
  }
  const providerCallId = String(call.session_id || "").trim();
  if (!providerCallId) throw new Error("ChiefVoice webhook is missing call.session_id");

  const postCallResult = payload.result;
  if (!postCallResult || typeof postCallResult !== "object" || Array.isArray(postCallResult)) {
    throw new Error("ChiefVoice webhook is missing the structured result object");
  }

  let durationSeconds = null;
  if (call.started_at && call.ended_at) {
    const started = new Date(call.started_at).getTime();
    const ended = new Date(call.ended_at).getTime();
    if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) {
      durationSeconds = Math.round((ended - started) / 1000);
    }
  }

  return {
    eventId,
    eventType,
    providerCallId,
    status: "completed",
    durationSeconds,
    endedAt: call.ended_at || null,
    postCallResult,
  };
}


function comparableText(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, "");
}

/**
 * Convert the requested check-in extraction contract into the attendance
 * workflow's deterministic internal decision fields. Identity is not inferred
 * from a name alone: the agent's explicit identity_verified flag and exact
 * directory matches are all required before check-in can be confirmed.
 */
function mapChiefVoiceAttendanceResult(result, { stage, session } = {}) {
  const outcome = { ...result };
  if (stage !== "check_in" || !Object.prototype.hasOwnProperty.call(result, "arrival_status")) {
    return outcome;
  }

  const employee = session?.employee || {};
  const patient = session?.patient || {};
  const staffName = comparableText(result.staff_name);
  const patientName = comparableText(result.patient_name);
  const patientAddress = comparableText(result.patient_address);
  const expectedEmployeeName = comparableText(employee.name || employee.fullName);
  const expectedPatientName = comparableText(patient.name);
  const expectedPatientAddress = comparableText(patient.address);

  const employeeNameConfirmed = Boolean(staffName && expectedEmployeeName && staffName === expectedEmployeeName);
  const patientNameConfirmed = Boolean(patientName && expectedPatientName && patientName === expectedPatientName);
  const addressConfirmed = Boolean(patientAddress && expectedPatientAddress && patientAddress === expectedPatientAddress);
  const arrived = result.arrival_status === "arrived";
  const notArrived = result.arrival_status === "not_arrived";
  const expectedArrivalTime = String(result.expected_arrival_time || "").trim();

  return {
    ...outcome,
    employeeIntent: arrived ? "arrival_confirmed" : notArrived && expectedArrivalTime ? "will_arrive_later" : "unclear",
    employeeNameConfirmed,
    patientNameConfirmed,
    addressConfirmed,
    employeeVerified: result.identity_verified === true,
    clientVerified: patientNameConfirmed && addressConfirmed,
    reachedPatient: arrived,
    reportedArrivalTime: null,
    // When the staff member did not state an actual arrival timestamp, the
    // workflow uses the scheduled check-in time rather than inventing one.
    reportedArrivalTimeMentioned: false,
    requestedCallbackAt: notArrived && expectedArrivalTime ? expectedArrivalTime : null,
    exceptionCode: null,
    summary: result.conversation_summary || result.summary || "",
  };
}

module.exports = {
  DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
  verifyChiefVoiceSignature,
  normalizeChiefVoiceWebhook,
  mapChiefVoiceAttendanceResult,
};
