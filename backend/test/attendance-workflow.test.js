"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  chooseAttendanceAction,
  inferRequestedCallbackAt,
  chiefVoiceTemplateScenario,
} = require("../src/domain/attendance/workflow");

test("attendance retries and follow-ups select the scenario-specific ChiefVoice templates", () => {
  assert.equal(chiefVoiceTemplateScenario({ stage: "check_in", attemptNumber: 1 }), "CHECK_IN");
  assert.equal(chiefVoiceTemplateScenario({ stage: "check_out", attemptNumber: 1 }), "CHECK_OUT");
  assert.equal(chiefVoiceTemplateScenario({ stage: "check_in", attemptNumber: 2, consecutiveNoAnswer: 1 }), "CHECK_IN_RETRY");
  assert.equal(chiefVoiceTemplateScenario({ stage: "check_out", attemptNumber: 2, consecutiveNoAnswer: 1 }), "CHECK_OUT_RETRY");
  assert.equal(chiefVoiceTemplateScenario({ stage: "check_in", attemptNumber: 2, consecutiveNoAnswer: 0 }), "CHECK_IN_FOLLOW_UP");
  assert.equal(chiefVoiceTemplateScenario({ stage: "check_out", attemptNumber: 2, consecutiveNoAnswer: 0 }), "CHECK_OUT_FOLLOW_UP");
  assert.equal(chiefVoiceTemplateScenario({ stage: "check_out", context: { call_purpose: "care_manager_escalation" } }), "CARE_MANAGER_ESCALATION");
});

test("check-in delay requests a follow-up instead of confirming attendance", () => {
  const decision = chooseAttendanceAction("check_in", {
    employeeIntent: "will_arrive_later",
    requestedCallbackAt: "2026-11-17T04:00:00.000Z",
  });
  assert.equal(decision.action, "follow_up");
  assert.equal(decision.runAt, "2026-11-17T04:00:00.000Z");
});

test("check-out while still on duty requests a follow-up instead of completing attendance", () => {
  const decision = chooseAttendanceAction("check_out", {
    employeeIntent: "still_on_duty",
    requestedCallbackAt: "2026-11-17T04:05:00.000Z",
  });
  assert.equal(decision.action, "follow_up");
  assert.equal(decision.runAt, "2026-11-17T04:05:00.000Z");
});

test("callback time can be inferred from an English transcript", () => {
  const reference = new Date("2026-11-17T04:00:00.000Z");
  assert.equal(
    inferRequestedCallbackAt("Please call me in five minutes.", reference),
    "2026-11-17T04:05:00.000Z",
  );
});

test("callback time can be inferred from a Tamil transcript", () => {
  const reference = new Date("2026-11-17T04:00:00.000Z");
  assert.equal(
    inferRequestedCallbackAt("ஐந்து நிமிடங்கள் கழித்து அழைக்கவும்", reference),
    "2026-11-17T04:05:00.000Z",
  );
});

test("an unclear delay is not silently treated as confirmed attendance", () => {
  const decision = chooseAttendanceAction("check_in", {
    employeeIntent: "will_arrive_later",
  });
  assert.equal(decision.action, "follow_up");
  assert.equal(decision.runAt, null);
});

test("outbound attendance request stays within ChiefVoice's combined context limit", async (t) => {
  const envNames = ["CHIEFVOICE_TEMPLATE_CHECK_IN_LIVE_ID", "CHIEFVOICE_TEMPLATE_CHECK_IN_POST_CALL_ID", "APP_TIMEZONE"];
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  t.after(() => envNames.forEach((name) => previous[name] === undefined ? delete process.env[name] : process.env[name] = previous[name]));
  process.env.CHIEFVOICE_TEMPLATE_CHECK_IN_LIVE_ID = "check-in-live";
  process.env.CHIEFVOICE_TEMPLATE_CHECK_IN_POST_CALL_ID = "check-in-post";
  process.env.APP_TIMEZONE = "Asia/Kolkata";

  const session = {
    id: "session-1", organizationId: "athulya", sessionStatus: "scheduled",
    checkInStatus: "scheduled", checkInTask: { id: "task-1" },
    scheduledStartAt: "2026-11-24T09:00:00+05:30", scheduledEndAt: "2026-11-24T17:00:00+05:30",
    language: "ta", fromNumber: "+911234567890",
    employee: { name: "Test Caregiver", phoneNumber: "+919876543210" },
    patient: { name: "Test Patient", address: "12 Example Road, Chennai, Tamil Nadu" },
    assignmentMetadata: { assignmentId: "assignment-1", source: "test" },
    activeContext: { checkIn: {} },
  };
  let serializedContextBytes;
  const chiefvoice = createChiefVoiceClient({
    apiKey: "test-key",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      serializedContextBytes = Buffer.byteLength(JSON.stringify({
        live_agent_context: body.live_agent.context,
        post_call_context: body.post_call.context,
        post_call_workflow_id: null,
        post_call_output_schema: body.post_call.output_schema,
        post_call_tools: body.post_call.tools,
        post_call_time_zone: body.post_call.time_zone,
        post_call_time_format: body.post_call.time_format,
        include_live_agent_context: body.post_call.include_live_agent_context,
        workflow_context: body.post_call.context,
      }));
      return { ok: true, status: 202, text: async () => JSON.stringify({ session_id: "provider-session-1" }) };
    },
  });
  const repository = {
    getAttendanceSession: async () => session,
    createCallAttempt: async () => ({ id: "attempt-1", shouldPlace: true, status: "scheduled" }),
    reserveOutboundCallSlot: async () => true,
    markCallPlacing: async () => true,
    setStageStatus: async () => {},
    getOrganizationCallSettings: async () => ({}),
    attachProviderCallId: async () => {},
  };
  const handlers = createAttendanceHandlers({
    repository,
    queue: { enqueue: async () => {} },
    chiefvoice,
    backend: {},
  });

  await handlers.place_call({ sessionId: session.id, taskId: "task-1", stage: "check_in", attemptNumber: 1 });

  assert.ok(serializedContextBytes < 12_000, `ChiefVoice context payload was ${serializedContextBytes} bytes`);
});
