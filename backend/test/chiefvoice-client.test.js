"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createChiefVoiceClient } = require("../src/infrastructure/integrations/chiefvoice-client");

test("ChiefVoice outbound call uses live and post-call templates with structured attendance schema", async () => {
  const names = ["CHIEFVOICE_LIVE_TEMPLATE_ID", "CHIEFVOICE_POST_CALL_TEMPLATE_ID", "APP_TIMEZONE"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.CHIEFVOICE_LIVE_TEMPLATE_ID = "live-template";
  process.env.CHIEFVOICE_POST_CALL_TEMPLATE_ID = "post-call-template";
  process.env.APP_TIMEZONE = "Asia/Kolkata";
  let captured;
  try {
    const client = createChiefVoiceClient({
      baseUrl: "https://chiefvoice.example.test",
      apiKey: "test-key",
      fetchImpl: async (url, options) => {
        captured = { url, options, payload: JSON.parse(options.body) };
        return { ok: true, status: 202, text: async () => JSON.stringify({ session_id: "session-123", status: "starting" }) };
      },
    });
    const response = await client.createOutboundCall({
      to: "+919876543210",
      from: "+911234567890",
      sessionId: "attendance-1",
      stage: "check_in",
      callAttemptId: "attempt-1",
      context: { employee: { name: "Test Employee" }, language: "ta" },
    });

    assert.equal(response.session_id, "session-123");
    assert.equal(captured.url, "https://chiefvoice.example.test/v1/calls/outbound");
    assert.equal(captured.options.method, "POST");
    assert.equal(captured.options.headers.Authorization, "Bearer test-key");
    assert.equal(captured.options.headers["Idempotency-Key"], "attendance-attempt-1");
    assert.equal(captured.payload.channel, "phone");
    assert.equal(captured.payload.destination, "+919876543210");
    assert.equal(captured.payload.recording_allowed, false);
    assert.equal(captured.payload.caller_id, "+911234567890");
    assert.equal(captured.payload.live_agent.template_id, "live-template");
    assert.equal(captured.payload.live_agent.context.attendance_stage, "check_in");
    assert.equal(captured.payload.post_call.template_id, "post-call-template");
    assert.equal(captured.payload.post_call.time_zone, "Asia/Kolkata");
    assert.equal(captured.payload.post_call.time_format, "%Y-%m-%dT%H:%M:%S%z");
    assert.equal(captured.payload.post_call.output_schema.additionalProperties, false);
    assert.deepEqual(captured.payload.post_call.output_schema.required, [
      "schema_version", "stage", "outcome", "identity", "reported_at", "callback_at", "exception_code", "summary",
    ]);
    assert.equal(captured.payload.post_call.output_schema.properties.schema_version.enum[0], "1.0");
    assert.deepEqual(captured.payload.post_call.output_schema.properties.identity.required, [
      "caregiver_name_matches", "patient_name_matches", "patient_address_matches",
    ]);
    assert.equal(captured.payload.post_call.output_schema.properties.identity.properties.caregiver_name_matches.type, "boolean");
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("ChiefVoice API error details are not exposed to logs or persisted error messages", async () => {
  const client = createChiefVoiceClient({
    baseUrl: "https://chiefvoice.example.test",
    apiKey: "secret-test-key",
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ message: "destination +910000000001 rejected for key secret-test-key" }) }),
  });
  await assert.rejects(client.getCallStatus("sandbox-session"), (error) => {
    assert.equal(error.message, "ChiefVoice API returned HTTP 403");
    assert.equal(error.response, undefined);
    assert.equal(error.message.includes("secret-test-key"), false);
    assert.equal(error.message.includes("+910000000001"), false);
    return true;
  });
});
