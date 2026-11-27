"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAttendanceHandlers } = require("../src/domain/attendance/workflow");

function harness({ caregiverStatus = "scheduled", careManagerStatus = "scheduled", managerLimit = 3 } = {}) {
  const session = {
    id: "session-1", organizationId: "org-1", assignmentId: "assignment-1", sessionStatus: "active",
    checkInStatus: caregiverStatus, checkOutStatus: "scheduled",
    checkInTask: { id: "task-in" }, checkOutTask: { id: "task-out" },
    activeContext: { checkIn: {}, checkOut: {} },
    employee: { id: "caregiver-1", name: "Caregiver", phoneNumber: "+919876543210" },
    patient: { id: "patient-1", name: "Patient", address: "Chennai" },
    metadata: { careManagerId: "manager-1" }, language: "ta-IN",
  };
  const jobs = [];
  const changes = [];
  const attempts = new Map();
  const settings = { unansweredCallEscalation: "call_care_manager", callRetry: { maxConsecutiveNoAnswer: managerLimit, initialMinutes: 1, multiplier: 1.2, maxMinutes: 5 } };
  const repository = {
    getAttendanceSession: async () => session,
    getCallAttempt: async (id) => attempts.get(id),
    getOrganizationCallSettings: async () => settings,
    setStageStatus: async (_id, stage, status, patch = {}) => {
      changes.push({ stage, status, patch });
      session[stage === "check_in" ? "checkInStatus" : "checkOutStatus"] = status;
      const key = stage === "check_in" ? "checkIn" : "checkOut";
      session.activeContext[key] = { ...session.activeContext[key], status, ...patch };
    },
    notifyCareManagerForPatient: async () => [{ id: "manager-1", careManagerName: "Manager", careManagerPhone: "+919999999999", notificationCreated: true }],
    nextAttemptNumber: async (_id, stage, role = "employee") => 1 + [...attempts.values()]
      .filter((attempt) => attempt.stage === stage && attempt.callTargetRole === role).length,
    markSessionException: async () => { session.sessionStatus = "exception"; },
    saveCallOutcome: async (_id, outcome) => { attempts.get(_id).outcome = outcome; },
    getTranscriptForCall: async () => null,
  };
  const queue = { enqueue: async (type, payload, options = {}) => { jobs.push({ type, payload, options }); } };
  const handlers = createAttendanceHandlers({ repository, queue, chiefvoice: {}, backend: {}, retry: settings.callRetry });
  return { session, jobs, changes, attempts, repository, handlers, settings };
}

test("caregiver success confirms attendance and queues attendance delivery", async () => {
  const h = harness();
  const now = new Date(Date.now() - 60_000).toISOString();
  h.attempts.set("caregiver-success", {
    id: "caregiver-success", sessionId: h.session.id, organizationId: h.session.organizationId,
    stage: "check_in", callTargetRole: "employee", attemptNumber: 1,
    outcome: { employeeIntent: "arrival_confirmed", employeeNameConfirmed: true, patientNameConfirmed: true,
      addressConfirmed: true, employeeVerified: true, clientVerified: true, reachedPatient: true,
      reportedArrivalTime: now },
  });
  await h.handlers.evaluate_attendance({ sessionId: h.session.id, callAttemptId: "caregiver-success" });
  assert.equal(h.session.checkInStatus, "confirmed");
  assert.equal(h.jobs.some((job) => job.type === "deliver_attendance"), true);
});

test("caregiver retry exhaustion escalates into care-manager attempt one", async () => {
  const h = harness({ caregiverStatus: "retry", managerLimit: 3 });
  h.attempts.set("caregiver-third", {
    id: "caregiver-third", sessionId: h.session.id, organizationId: h.session.organizationId,
    stage: "check_in", callTargetRole: "employee", attemptNumber: 3,
    consecutiveNoAnswerBefore: 2, status: "no-answer",
  });
  await h.handlers.process_call_result({ callAttemptId: "caregiver-third" });
  assert.equal(h.session.checkInStatus, "not_answered");
  await h.handlers.evaluate_session({ sessionId: h.session.id, stage: "check_in" });
  const escalationJob = h.jobs.find((job) => job.type === "place_call" && job.payload.callTargetRole === "care_manager");
  assert.equal(h.session.checkInStatus, "escalated");
  assert.equal(escalationJob.payload.attemptNumber, 1);
  assert.equal(escalationJob.payload.taskId, "task-in");
});

test("answered but unconfirmed care-manager call schedules a retry with a brief status check", async () => {
  const h = harness({ caregiverStatus: "escalated", managerLimit: 3 });
  h.attempts.set("manager-answered-unconfirmed", {
    id: "manager-answered-unconfirmed", sessionId: h.session.id, organizationId: h.session.organizationId,
    stage: "check_in", callTargetRole: "care_manager", attemptNumber: 1,
    status: "completed", answeredAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    outcome: { careManagerAttendanceConfirmed: false, outcome: "notified", summary: "Manager will check the attendance issue." },
  });
  await h.handlers.process_call_result({ callAttemptId: "manager-answered-unconfirmed" });
  const retry = h.jobs.find((job) => job.type === "place_call" && job.payload.callTargetRole === "care_manager");
  assert.equal(h.session.checkInStatus, "escalated");
  assert.equal(retry.payload.attemptNumber, 2);
  assert.equal(retry.payload.callTargetRole, "care_manager");
  assert.equal(h.changes.at(-1).patch.reason, "care_manager_retry_after_unconfirmed_response");
});

test("care-manager retry uses its own attempt sequence and remains escalated", async () => {
  const h = harness({ caregiverStatus: "escalated", managerLimit: 3 });
  h.attempts.set("manager-first", {
    id: "manager-first", sessionId: h.session.id, organizationId: h.session.organizationId,
    stage: "check_in", callTargetRole: "care_manager", attemptNumber: 1, status: "no-answer",
  });
  await h.handlers.process_call_result({ callAttemptId: "manager-first" });
  const retry = h.jobs.find((job) => job.type === "place_call" && job.payload.callTargetRole === "care_manager");
  assert.equal(h.session.checkInStatus, "escalated");
  assert.equal(retry.payload.attemptNumber, 2);
  assert.equal(retry.payload.callTargetRole, "care_manager");
  assert.equal(h.changes.at(-1).patch.reason, "care_manager_retry");
});

test("repeated care-manager callback requests stay scheduled beyond the unanswered retry limit", async () => {
  const h = harness({ caregiverStatus: "escalated", managerLimit: 3 });
  h.session.activeContext.checkIn = { reason: "care_manager_requested_callback" };
  const callbackAt = new Date(Date.now() + 10 * 60_000).toISOString();
  h.attempts.set("manager-later-callback", {
    id: "manager-later-callback", sessionId: h.session.id, organizationId: h.session.organizationId,
    stage: "check_in", callTargetRole: "care_manager", attemptNumber: 8,
    consecutiveNoAnswerBefore: 0, status: "completed", answeredAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    outcome: { careManagerAttendanceConfirmed: false, careManagerCallbackAt: callbackAt, summary: "Manager requested another callback." },
  });
  await h.handlers.process_call_result({ callAttemptId: "manager-later-callback" });
  const callback = h.jobs.find((job) => job.type === "place_call" && job.payload.callTargetRole === "care_manager");
  assert.equal(h.session.checkInStatus, "escalated");
  assert.equal(h.changes.at(-1).patch.reason, "care_manager_requested_callback");
  assert.equal(callback.options.runAt.toISOString(), new Date(callbackAt).toISOString());
  assert.equal(callback.payload.consecutiveNoAnswer, 0);
});

test("care-manager retry exhaustion marks the attendance case unresolved", async () => {
  const h = harness({ caregiverStatus: "escalated", managerLimit: 3 });
  h.attempts.set("manager-third", {
    id: "manager-third", sessionId: h.session.id, organizationId: h.session.organizationId,
    stage: "check_in", callTargetRole: "care_manager", attemptNumber: 3,
    consecutiveNoAnswerBefore: 2, status: "no-answer",
  });
  await h.handlers.process_call_result({ callAttemptId: "manager-third" });
  assert.equal(h.session.checkInStatus, "unresolved");
  assert.equal(h.changes.at(-1).patch.reason, "care_manager_retry_limit_reached");
  assert.equal(h.jobs.some((job) => job.type === "place_call" && job.payload.callTargetRole === "care_manager"), false);
});
