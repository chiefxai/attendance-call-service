"use strict";

const crypto = require("node:crypto");

const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 300;
const RESULT_ENUMS = {
  employeeIntent: new Set(["arrival_confirmed", "departure_confirmed", "will_arrive_later", "still_on_duty", "missed", "wrong_assignment", "unclear"]),
  employee_intent: new Set(["arrival_confirmed", "departure_confirmed", "will_arrive_later", "still_on_duty", "missed", "wrong_assignment", "unclear"]),
  arrival_status: new Set(["arrived", "not_arrived", "unclear"]),
};
const RESULT_TYPES = {
  employeeNameConfirmed: "boolean", employee_name_confirmed: "boolean",
  patientNameConfirmed: "boolean", patient_name_confirmed: "boolean",
  addressConfirmed: "boolean", address_confirmed: "boolean",
  employeeVerified: "boolean", employee_verified: "boolean",
  clientVerified: "boolean", client_verified: "boolean",
  reachedPatient: "boolean", reached_patient: "boolean",
  dutyComplete: "boolean", duty_complete: "boolean",
  reportedArrivalTime: "nullable-string", reported_arrival_time: "nullable-string",
  reportedDepartureTime: "nullable-string", reported_departure_time: "nullable-string",
  reportedArrivalTimeMentioned: "boolean", reported_arrival_time_mentioned: "boolean",
  reportedDepartureTimeMentioned: "boolean", reported_departure_time_mentioned: "boolean",
  requestedCallbackAt: "nullable-string", requested_callback_at: "nullable-string",
  exceptionCode: "nullable-string", exception_code: "nullable-string",
  summary: "string", arrival_status: "enum",
  staff_name: "string", patient_name: "string", patient_address: "string",
  expected_arrival_time: "string", identity_verified: "boolean",
  follow_up_required: "boolean", conversation_summary: "string",
};

function validatePostCallResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("ChiefVoice webhook is missing the structured result object");
  }
  if (result.schema_version === "1.0") {
    const requiredCommon = ["schema_version", "stage", "outcome", "reported_at", "callback_at", "exception_code", "summary"];
    const identityFields = ["caregiver_name_matches", "patient_name_matches", "patient_address_matches"];
    const expectedKeys = result.stage === "check_in"
      ? [...requiredCommon, "identity"]
      : requiredCommon;
    if (!["check_in", "check_out"].includes(result.stage)) {
      throw new Error("ChiefVoice result stage is unsupported");
    }
    if (Object.keys(result).some((field) => !expectedKeys.includes(field))
      || requiredCommon.some((field) => !Object.prototype.hasOwnProperty.call(result, field))) {
      throw new Error("ChiefVoice result does not match schema version 1.0");
    }
    const validOutcomes = result.stage === "check_in"
      ? new Set(["arrived", "not_arrived", "unclear", "wrong_assignment"])
      : new Set(["checked_out", "still_on_duty", "unclear", "wrong_assignment"]);
    if (!validOutcomes.has(result.outcome)) throw new Error("ChiefVoice result outcome is unsupported for this stage");
    if (typeof result.summary !== "string") throw new Error("ChiefVoice result summary must be a string");
    for (const field of ["reported_at", "callback_at", "exception_code"]) {
      const value = result[field];
      if (value !== null && typeof value !== "string") throw new Error(`ChiefVoice result field ${field} must be a string or null`);
    }
    for (const field of ["reported_at", "callback_at"]) {
      if (result[field] !== null && !Number.isFinite(Date.parse(result[field]))) {
        throw new Error(`ChiefVoice result field ${field} must be an ISO timestamp or null`);
      }
    }
    if (result.stage === "check_in") {
      if (!result.identity || typeof result.identity !== "object" || Array.isArray(result.identity)
        || Object.keys(result.identity).some((field) => !identityFields.includes(field))
        || identityFields.some((field) => typeof result.identity[field] !== "boolean")) {
        throw new Error("ChiefVoice check-in identity must contain the three boolean match fields");
      }
    }
    return;
  }
  for (const [field, value] of Object.entries(result)) {
    const allowed = RESULT_ENUMS[field];
    if (allowed && !allowed.has(value)) throw new Error(`ChiefVoice result field ${field} has an unsupported value`);
    const type = RESULT_TYPES[field];
    if (!type || type === "enum") continue;
    if (type === "boolean" && typeof value !== "boolean") throw new Error(`ChiefVoice result field ${field} must be a boolean`);
    if (type === "string" && typeof value !== "string") throw new Error(`ChiefVoice result field ${field} must be a string`);
    if (type === "nullable-string" && value !== null && typeof value !== "string") throw new Error(`ChiefVoice result field ${field} must be a string or null`);
  }
}

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
 * ChiefVoice sends call.session_id and may wrap the structured extraction in
 * result.structured_output alongside summary/disposition metadata. Older or
 * simpler integrations can send the extraction directly in result.
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

  const postCallResult = payload.result && typeof payload.result === "object" &&
    !Array.isArray(payload.result) && payload.result.structured_output &&
    typeof payload.result.structured_output === "object" &&
    !Array.isArray(payload.result.structured_output)
    ? payload.result.structured_output
    : payload.result;
  validatePostCallResult(postCallResult);

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
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Convert the requested check-in extraction contract into the attendance
 * workflow's deterministic internal decision fields. Identity is not inferred
 * from a name alone: the agent's explicit identity_verified flag and exact
 * directory matches are all required before check-in can be confirmed.
 */
function mapChiefVoiceAttendanceResult(result, { stage, session } = {}) {
  const outcome = { ...result };
  if (result.schema_version === "1.0") {
    if (result.stage !== stage) throw new Error("ChiefVoice result stage does not match the call stage");
    const exceptionCode = result.exception_code;
    if (stage === "check_in") {
      const identity = result.identity;
      const arrived = result.outcome === "arrived";
      const notArrived = result.outcome === "not_arrived";
      return {
        ...outcome,
        employeeIntent: arrived ? "arrival_confirmed"
          : notArrived && result.callback_at ? "will_arrive_later"
            : result.outcome === "wrong_assignment" ? "wrong_assignment" : "unclear",
        employeeNameConfirmed: identity.caregiver_name_matches,
        patientNameConfirmed: identity.patient_name_matches,
        addressConfirmed: identity.patient_address_matches,
        employeeVerified: identity.caregiver_name_matches,
        clientVerified: identity.patient_name_matches && identity.patient_address_matches,
        reachedPatient: arrived,
        reportedArrivalTime: result.reported_at,
        reportedArrivalTimeMentioned: result.reported_at !== null,
        requestedCallbackAt: result.callback_at,
        exceptionCode,
        summary: result.summary,
      };
    }
    if (stage === "check_out") {
      return {
        ...outcome,
        employeeIntent: result.outcome === "checked_out" ? "departure_confirmed"
          : result.outcome === "still_on_duty" ? "still_on_duty"
            : result.outcome === "wrong_assignment" ? "wrong_assignment" : "unclear",
        dutyComplete: result.outcome === "checked_out",
        reportedDepartureTime: result.reported_at,
        reportedDepartureTimeMentioned: result.reported_at !== null,
        requestedCallbackAt: result.callback_at,
        exceptionCode,
        summary: result.summary,
      };
    }
    return outcome;
  }
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
  const callbackAt = String(result.requestedCallbackAt || result.requested_callback_at || "").trim()
    || (/^\\d{4}-\\d{2}-\\d{2}T/.test(expectedArrivalTime) ? expectedArrivalTime : "");

  return {
    ...outcome,
    employeeIntent: arrived ? "arrival_confirmed" : notArrived && result.follow_up_required === true ? "will_arrive_later" : "unclear",
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
    requestedCallbackAt: notArrived && result.follow_up_required === true ? callbackAt || null : null,
    exceptionCode: null,
    summary: result.conversation_summary || result.summary || "",
  };
}

module.exports = {
  DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
  verifyChiefVoiceSignature,
  validatePostCallResult,
  normalizeChiefVoiceWebhook,
  mapChiefVoiceAttendanceResult,
};
