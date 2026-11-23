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
