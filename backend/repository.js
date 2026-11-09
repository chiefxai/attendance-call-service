"use strict";

// Implement these methods with the host platform's existing DB repository.
// Every lookup and write must include organizationId except provider webhook
// lookup, which must resolve providerCallId to exactly one tenant-owned call.
const repositoryMethods = Object.freeze([
  "listAgents(organizationId)",
  "getAgent(organizationId, agentId)",
  "createAgent(organizationId, agent)",
  "updateAgent(organizationId, agentId, patch)",
  "deleteAgent(organizationId, agentId)",
  "listCampaigns(organizationId)",
  "getCampaign(organizationId, campaignId)",
  "createCampaign(organizationId, campaign)",
  "createCall(organizationId, call)",
  "updateCallByProviderId(event)",
  "createAttendanceSession(assignment)",
  "getAttendanceSession(sessionId)",
  "listAttendanceSessions(organizationId, filters)",
  "getOperationsSummary(organizationId)",
  "listStaffDirectory(organizationId, filters)",
  "listPatientDirectory(organizationId, filters)",
  "listSupervisionQueue(organizationId, filters)",
  "listAttendanceLedger(organizationId, filters)",
  "getCallCenterData(organizationId)",
  "getAgentSessionContext(sessionId, stage)",
  "createCallAttempt(attempt)",
  "getCallAttempt(callAttemptId)",
  "markCallPlacing(callAttemptId)",
  "attachProviderCallId(callAttemptId, providerCallId, response)",
  "markCallPlacementFailed(callAttemptId, reason)",
  "claimCallStream(callAttemptId)",
  "endCallStream(callAttemptId)",
  "setStageStatus(sessionId, stage, status, context)",
  "setRecordingObjectKey(callAttemptId, objectKey, contentType)",
  "saveTranscript(transcript)",
  "getTranscriptForCall(callAttemptId)",
  "saveCallOutcome(callAttemptId, outcome)",
  "nextAttemptNumber(sessionId, stage)",
  "markSessionCompleted(sessionId)",
  "markSessionException(sessionId)",
  "buildBackendAttendancePayload(sessionId)",
  "markBackendDelivered(sessionId, response)",
]);

function assertRepository(repository) {
  const missing = repositoryMethods.filter((signature) => {
    const method = signature.slice(0, signature.indexOf("("));
    return typeof repository?.[method] !== "function";
  });
  if (missing.length) throw new Error(`Call-service repository is missing: ${missing.join(", ")}`);
  return repository;
}

module.exports = { repositoryMethods, assertRepository };
