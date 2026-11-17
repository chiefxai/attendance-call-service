"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createChiefVoiceClient } = require("../src/infrastructure/integrations/chiefvoice-client");
const { createAttendanceHandlers } = require("../src/domain/attendance/workflow");

test("local Chiefvoice sandbox completes outbound, status polling and result acceptance", async (t) => {
  const requests = [];
  const result = { arrival_status: "arrived", staff_name: "Test Staff", patient_name: "Test Patient", patient_address: "Test Address", expected_arrival_time: "", identity_verified: true, follow_up_required: false, conversation_summary: "Sandbox result" };
  const names = ["CHIEFVOICE_LIVE_TEMPLATE_ID", "CHIEFVOICE_POST_CALL_TEMPLATE_ID", "APP_TIMEZONE"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.CHIEFVOICE_LIVE_TEMPLATE_ID = "sandbox-live-template";
  process.env.CHIEFVOICE_POST_CALL_TEMPLATE_ID = "sandbox-post-template";
  process.env.APP_TIMEZONE = "Asia/Kolkata";
  t.after(() => names.forEach((name) => previous[name] === undefined ? delete process.env[name] : process.env[name] = previous[name]));

  const client = createChiefVoiceClient({ baseUrl: "https://chiefvoice.sandbox.invalid", apiKey: "sandbox-only-key", fetchImpl: async (url, options) => {
    const parsed = new URL(url);
    requests.push({ method: options.method, url: parsed.pathname, authorization: options.headers.Authorization, idempotencyKey: options.headers["Idempotency-Key"], body: options.body ? JSON.parse(options.body) : null });
    const data = parsed.pathname === "/v1/calls/outbound"
      ? { session_id: "sandbox-session-123", status: "starting", channel: "phone", direction: "outbound" }
      : parsed.pathname === "/v1/calls/sandbox-session-123"
        ? { session_id: "sandbox-session-123", status: "completed", started_at: "2026-11-17T10:00:00Z", ended_at: "2026-11-17T10:00:30Z" }
        : { session_id: "sandbox-session-123", status: "completed", result, ended_at: "2026-11-17T10:00:30Z" };
    return { ok: true, status: parsed.pathname.endsWith("outbound") ? 202 : 200, text: async () => JSON.stringify(data) };
  } });
  const accepted = await client.createOutboundCall({ to: "+910000000001", from: "+910000000002", sessionId: "attendance-sandbox", stage: "check_in", callAttemptId: "attempt-sandbox", context: { language: "en" } });
  assert.equal(accepted.status, "starting");
  const callStatus = await client.getCallStatus(accepted.session_id);
  assert.equal(callStatus.status, "completed");
  const postCall = await client.getPostCallResult(accepted.session_id);
  assert.equal(postCall.status, "completed");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].authorization, "Bearer sandbox-only-key");
  assert.equal(requests[0].idempotencyKey, "attendance-attempt-sandbox");
  assert.equal(requests[0].body.destination, "+910000000001");
  assert.equal(requests[0].body.live_agent.template_id, "sandbox-live-template");
  assert.equal(requests[0].body.post_call.template_id, "sandbox-post-template");
  assert.equal(requests[0].body.recording_allowed, false);
  assert.deepEqual(requests.slice(1).map((request) => request.url), ["/v1/calls/sandbox-session-123", "/v1/calls/sandbox-session-123/post-call"]);

  let acceptedEvent = false;
  let saved;
  const repository = {
    getCallAttempt: async () => ({ id: "attempt-sandbox", sessionId: "attendance-sandbox", stage: "check_in", provider: "chiefvoice", providerCallId: accepted.session_id, outcome: null }),
    claimChiefVoiceWebhookEvent: async () => { if (acceptedEvent) return false; acceptedEvent = true; return true; },
    updateCallByProviderId: async () => ({ id: "attempt-sandbox", sessionId: "attendance-sandbox", stage: "check_in" }),
    getAttendanceSession: async () => ({ checkInStatus: "calling", employee: { name: "Test Staff" }, patient: { name: "Test Patient", address: "Test Address" } }),
    saveCallOutcome: async (_id, outcome) => { saved = outcome; },
    setStageStatus: async () => {},
  };
  const queue = { transaction: (operation) => operation({}), enqueue: async () => {} };
  const handlers = createAttendanceHandlers({ repository, queue, chiefvoice: client, backend: {} });
  await handlers.poll_chiefvoice_call({ callAttemptId: "attempt-sandbox", pollCount: 0 });
  assert.equal(acceptedEvent, true);
  assert.equal(saved.employeeIntent, "arrival_confirmed");
  assert.equal(saved.employeeVerified, true);
});
