"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  verifyChiefVoiceSignature,
  normalizeChiefVoiceWebhook,
  mapChiefVoiceAttendanceResult,
} = require("../src/infrastructure/integrations/chiefvoice-webhook");

function signedHeaders(secret, eventId, eventType, rawBody, timestamp) {
  const signed = Buffer.concat([Buffer.from(`${timestamp}.${eventId}.`), rawBody]);
  const signature = crypto.createHmac("sha256", secret).update(signed).digest("hex");
  return {
    "x-chiefvoice-event-id": eventId,
    "x-chiefvoice-event": eventType,
    "x-chiefvoice-timestamp": timestamp,
    "x-chiefvoice-signature": `sha256=${signature}`,
  };
}

test("verifies ChiefVoice timestamp.event_id.raw-body signature", () => {
  const secret = "test-webhook-secret";
  const eventId = "post_call.analysis.completed:session-123";
  const eventType = "call.analysis.completed";
  const rawBody = Buffer.from(JSON.stringify({
    event: eventType,
    event_id: eventId,
    call: { session_id: "session-123" },
    result: { employeeIntent: "arrival_confirmed" },
  }));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = signedHeaders(secret, eventId, eventType, rawBody, timestamp);

  assert.equal(verifyChiefVoiceSignature({
    secret,
    timestamp: headers["x-chiefvoice-timestamp"],
    eventId: headers["x-chiefvoice-event-id"],
    signature: headers["x-chiefvoice-signature"],
    rawBody,
  }), true);
});

test("rejects stale ChiefVoice webhook signatures", () => {
  const secret = "test-webhook-secret";
  const eventId = "evt-123";
  const eventType = "call.analysis.completed";
  const rawBody = Buffer.from("{}");
  const timestamp = String(Math.floor(Date.now() / 1000) - 301);
  const headers = signedHeaders(secret, eventId, eventType, rawBody, timestamp);

  assert.equal(verifyChiefVoiceSignature({
    secret,
    timestamp,
    eventId,
    signature: headers["x-chiefvoice-signature"],
    rawBody,
  }), false);
});

test("normalizes the actual ChiefVoice post-call event envelope", () => {
  const payload = {
    event: "call.analysis.completed",
    event_id: "post_call.analysis.completed:session-123",
    call: {
      session_id: "session-123",
      provider: "vobiz",
      channel: "phone",
      direction: "outbound",
      started_at: "2026-11-17T09:00:00+00:00",
      ended_at: "2026-11-17T09:01:30+00:00",
    },
    post_call: { time_zone: "Asia/Kolkata" },
    result: { employeeIntent: "arrival_confirmed", employeeVerified: true },
  };

  const normalized = normalizeChiefVoiceWebhook(payload, {
    headerEventId: payload.event_id,
    headerEventType: payload.event,
  });

  assert.equal(normalized.providerCallId, "session-123");
  assert.equal(normalized.eventType, "call.analysis.completed");
  assert.equal(normalized.status, "completed");
  assert.equal(normalized.durationSeconds, 90);
  assert.deepEqual(normalized.postCallResult, payload.result);
});

test("rejects mismatched event ID and unsupported event type", () => {
  const payload = {
    event: "call.analysis.completed",
    event_id: "evt-123",
    call: { session_id: "session-123" },
    result: { employeeIntent: "arrival_confirmed" },
  };
  assert.throws(
    () => normalizeChiefVoiceWebhook(payload, { headerEventId: "evt-other", headerEventType: payload.event }),
    /event ID header does not match/,
  );
  assert.throws(
    () => normalizeChiefVoiceWebhook(payload, { headerEventId: payload.event_id, headerEventType: "call.completed" }),
    /Unsupported or inconsistent/,
  );
});

test("maps Athulya arrival extraction only when staff, patient, address and identity match", () => {
  const session = {
    employee: { name: "Jane Doe" },
    patient: { name: "Mary Patient", address: "12 Lake Road, Chennai" },
  };
  const mapped = mapChiefVoiceAttendanceResult({
    arrival_status: "arrived",
    staff_name: "Jane Doe",
    patient_name: "Mary Patient",
    patient_address: "12 Lake Road, Chennai",
    expected_arrival_time: "",
    identity_verified: true,
    follow_up_required: false,
    conversation_summary: "Staff confirmed arrival.",
  }, { stage: "check_in", session });

  assert.equal(mapped.employeeIntent, "arrival_confirmed");
  assert.equal(mapped.employeeNameConfirmed, true);
  assert.equal(mapped.patientNameConfirmed, true);
  assert.equal(mapped.addressConfirmed, true);
  assert.equal(mapped.employeeVerified, true);
  assert.equal(mapped.clientVerified, true);
  assert.equal(mapped.reachedPatient, true);
  assert.equal(mapped.reportedArrivalTimeMentioned, false);
  assert.equal(mapped.summary, "Staff confirmed arrival.");
});

test("does not treat a name alone as verified identity and maps expected arrival for follow-up", () => {
  const mapped = mapChiefVoiceAttendanceResult({
    arrival_status: "not_arrived",
    staff_name: "Jane Doe",
    patient_name: "Mary Patient",
    patient_address: "12 Lake Road, Chennai",
    expected_arrival_time: "in 20 minutes",
    identity_verified: false,
    follow_up_required: true,
    conversation_summary: "Staff expects to arrive shortly.",
  }, {
    stage: "check_in",
    session: {
      employee: { name: "Jane Doe" },
      patient: { name: "Mary Patient", address: "12 Lake Road, Chennai" },
    },
  });

  assert.equal(mapped.employeeIntent, "will_arrive_later");
  assert.equal(mapped.employeeVerified, false);
  assert.equal(mapped.requestedCallbackAt, "in 20 minutes");
});

test("leaves check-out extraction in the existing stage-specific format", () => {
  const result = { employeeIntent: "departure_confirmed", dutyComplete: true };
  assert.deepEqual(mapChiefVoiceAttendanceResult(result, { stage: "check_out", session: {} }), result);
});
