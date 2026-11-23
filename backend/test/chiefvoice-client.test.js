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
      now: () => new Date("2026-11-18T04:30:00.000Z"),
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
    assert.equal(captured.payload.live_agent.context.current_time_utc, "2026-11-18T04:30:00.000Z");
    assert.equal(captured.payload.live_agent.context.current_local_time, "2026-11-18 10:00:00");
    assert.equal(captured.payload.live_agent.context.time_zone, "Asia/Kolkata");
    assert.equal(captured.payload.post_call.template_id, "post-call-template");
    assert.equal(captured.payload.post_call.context.current_time_utc, "2026-11-18T04:30:00.000Z");
    assert.equal(captured.payload.post_call.time_zone, "Asia/Kolkata");
    assert.equal(captured.payload.post_call.time_format, "%Y-%m-%dT%H:%M:%S%z");
    assert.equal(captured.payload.post_call.output_schema.additionalProperties, false);
    assert.deepEqual(captured.payload.post_call.output_schema.required, [
      "schema_version", "stage", "outcome", "identity", "reported_at", "callback_at", "exception_code", "summary", "transcript_summary",
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

test("care-manager escalation requests include a post-call output schema", async () => {
  const names = [
    "CHIEFVOICE_TEMPLATE_CARE_MANAGER_ESCALATION_LIVE_ID",
    "CHIEFVOICE_TEMPLATE_CARE_MANAGER_ESCALATION_POST_CALL_ID",
    "CHIEFVOICE_USE_EXPLICIT_TEMPLATE_IDS",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.CHIEFVOICE_TEMPLATE_CARE_MANAGER_ESCALATION_LIVE_ID = "manager-live-template";
  process.env.CHIEFVOICE_TEMPLATE_CARE_MANAGER_ESCALATION_POST_CALL_ID = "manager-post-template";
  process.env.CHIEFVOICE_USE_EXPLICIT_TEMPLATE_IDS = "true";
  let payload;
  try {
    const client = createChiefVoiceClient({
      baseUrl: "https://chiefvoice.example.test",
      apiKey: "test-key",
      fetchImpl: async (_url, options) => {
        payload = JSON.parse(options.body);
        return { ok: true, status: 202, text: async () => JSON.stringify({ session_id: "manager-session" }) };
      },
    });
    await client.createOutboundCall({
      to: "+919876543210",
      from: "+911234567890",
      sessionId: "attendance-1",
      stage: "check_in",
      callAttemptId: "manager-attempt-1",
      context: { call_purpose: "care_manager_escalation" },
      templateScenario: "CARE_MANAGER_ESCALATION",
    });

    assert.equal(payload.post_call.template_id, "manager-post-template");
    assert.deepEqual(payload.post_call.output_schema.required, [
      "schema_version", "stage", "outcome", "escalation_message_delivered", "summary", "transcript_summary",
    ]);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});


test("outbound calls use each use-case live and post-call template pair", async (t) => {
  const cases = [
    ["CHECK_IN", "check_in"],
    ["CHECK_IN_RETRY", "check_in"],
    ["CHECK_IN_FOLLOW_UP", "check_in"],
    ["CHECK_OUT", "check_out"],
    ["CHECK_OUT_RETRY", "check_out"],
    ["CHECK_OUT_FOLLOW_UP", "check_out"],
    ["CARE_MANAGER_ESCALATION", "check_in"],
  ];
  const names = ["CHIEFVOICE_LIVE_TEMPLATE_ID", "CHIEFVOICE_POST_CALL_TEMPLATE_ID", ...cases.flatMap(([s]) => [
    `CHIEFVOICE_TEMPLATE_${s}_LIVE_ID`, `CHIEFVOICE_TEMPLATE_${s}_POST_CALL_ID`,
  ])];
  const old = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  t.after(() => names.forEach((n) => old[n] === undefined ? delete process.env[n] : process.env[n] = old[n]));
  process.env.CHIEFVOICE_LIVE_TEMPLATE_ID = "global-live-not-used";
  process.env.CHIEFVOICE_POST_CALL_TEMPLATE_ID = "global-post-not-used";
  for (const [s] of cases) {
    process.env[`CHIEFVOICE_TEMPLATE_${s}_LIVE_ID`] = `${s.toLowerCase()}-live`;
    process.env[`CHIEFVOICE_TEMPLATE_${s}_POST_CALL_ID`] = `${s.toLowerCase()}-post`;
  }
  for (const [scenario, stage] of cases) {
    let captured;
    const client = createChiefVoiceClient({
      baseUrl: "https://core.elvoryx.in", apiKey: "test-key",
      fetchImpl: async (url, options) => {
        captured = { url, options, body: JSON.parse(options.body) };
        return { ok: true, status: 202, text: async () => JSON.stringify({ session_id: "accepted" }) };
      },
    });
    await client.createOutboundCall({
      to: "+919876543210", from: "+911234567890", sessionId: "attendance-1",
      stage, callAttemptId: scenario, context: { language: "ta" }, templateScenario: scenario,
    });
    assert.equal(captured.url, "https://core.elvoryx.in/v1/calls/outbound");
    assert.equal(captured.body.live_agent.template_id, `${scenario.toLowerCase()}-live`);
    assert.equal(captured.body.post_call.template_id, `${scenario.toLowerCase()}-post`);
    assert.notEqual(captured.body.live_agent.template_id, captured.body.post_call.template_id);
    assert.equal(captured.options.headers["Idempotency-Key"], `attendance-${scenario}`);
  }
});

test("missing per-use-case template IDs fail before the provider request", async (t) => {
  const names = ["CHIEFVOICE_TEMPLATE_CHECK_IN_LIVE_ID", "CHIEFVOICE_TEMPLATE_CHECK_IN_POST_CALL_ID"];
  const old = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  t.after(() => names.forEach((n) => old[n] === undefined ? delete process.env[n] : process.env[n] = old[n]));
  delete process.env.CHIEFVOICE_TEMPLATE_CHECK_IN_LIVE_ID;
  delete process.env.CHIEFVOICE_TEMPLATE_CHECK_IN_POST_CALL_ID;
  let requests = 0;
  const client = createChiefVoiceClient({ baseUrl: "https://core.elvoryx.in", apiKey: "test-key", fetchImpl: async () => { requests += 1; } });
  await assert.rejects(client.createOutboundCall({
    to: "+919876543210", from: "+911234567890", sessionId: "attendance-1", stage: "check_in",
    callAttemptId: "missing", context: {}, templateScenario: "CHECK_IN",
  }), (error) => {
    assert.match(error.message, /CHIEFVOICE_TEMPLATE_CHECK_IN_LIVE_ID and CHIEFVOICE_TEMPLATE_CHECK_IN_POST_CALL_ID must be configured/);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(requests, 0);
});

test("template validation failures retain status and a sanitized non-retryable reason", async () => {
  const names = ["CHIEFVOICE_TEMPLATE_CHECK_IN_LIVE_ID", "CHIEFVOICE_TEMPLATE_CHECK_IN_POST_CALL_ID"];
  const old = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  process.env.CHIEFVOICE_TEMPLATE_CHECK_IN_LIVE_ID = "configured-live";
  process.env.CHIEFVOICE_TEMPLATE_CHECK_IN_POST_CALL_ID = "configured-post";
  try {
    for (const [status, reason] of [
      [403, "selected template is not assigned to this API key, or the caller ID is not assigned"],
      [404, "selected template was not found or is disabled"],
      [422, "outbound request was rejected; verify template kind, enabled state, and API-key assignment"],
    ]) {
      const client = createChiefVoiceClient({
        baseUrl: "https://core.elvoryx.in", apiKey: "must-never-appear",
        fetchImpl: async () => ({ ok: false, status, text: async () => JSON.stringify({ detail: "wrong tenant secret=do-not-leak must-never-appear" }) }),
      });
      await assert.rejects(client.createOutboundCall({
        to: "+919876543210", from: "+911234567890", sessionId: "attendance-1", stage: "check_in",
        callAttemptId: "invalid", context: {}, templateScenario: "CHECK_IN",
      }), (error) => {
        assert.equal(error.status, status);
        assert.equal(error.retryable, false);
        assert.ok(error.message.includes(reason));
        assert.equal(error.message.includes("do-not-leak"), false);
        assert.equal(error.message.includes("must-never-appear"), false);
        return true;
      });
    }
  } finally {
    names.forEach((n) => old[n] === undefined ? delete process.env[n] : process.env[n] = old[n]);
  }
});
