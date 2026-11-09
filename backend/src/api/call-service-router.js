"use strict";

const { createVobizClient } = require("../infrastructure/telephony/vobiz-client");
const { assertRepository } = require("../domain/repository-contract");
const { verifyVobizWebhookSignature } = require("../infrastructure/telephony/vobiz-signature");
const { createVobizLiveRuntime } = require("../realtime/vobiz-live-runtime");

const AGENT_DEFAULTS = {
  active: true,
  voice: null,
  language: "en",
  systemPrompt: "",
  runtimeConfig: {},
};

function createCallServiceRouter({ express, repository, queue, vobiz = createVobizClient(), verifyWebhook, getClientForOrg, recordings }) {
  if (!express?.Router) throw new Error("An Express-compatible module is required");
  assertRepository(repository);
  if (!queue?.enqueue) throw new Error("A durable job queue is required");

  const router = express.Router();
  router.use(express.json());
  router.use(express.urlencoded({ extended: false }));
  const validateWebhook = verifyWebhook || ((req) => verifyVobizWebhookSignature(req, process.env.VOBIZ_AUTH_TOKEN));
  const liveRuntime = createVobizLiveRuntime({ repository, vobiz, verifyWebhook: validateWebhook, getClientForOrg, recordings, queue });
  router.post("/answer", liveRuntime.answerHandler);
  router.handleVobizUpgrade = liveRuntime.handleUpgrade;
  router.closeVobizLiveRuntime = liveRuntime.close;

  const org = (req) => {
    if (!req.orgId) {
      const error = new Error("Authenticated organization context is required");
      error.status = 401;
      throw error;
    }
    return req.orgId;
  };
  const fail = (res, error) => res.status(error.status || 500).json({ error: error.message || "Request failed" });

  router.get("/dashboard/summary", async (req, res) => {
    try { res.json(await repository.getOperationsSummary(org(req))); } catch (error) { fail(res, error); }
  });

  router.get("/assignments", async (req, res) => {
    try {
      res.json(await repository.listAttendanceSessions(org(req), {
        search: req.query.search || "", status: req.query.status || "all",
        limit: req.query.limit || 100, offset: req.query.offset || 0,
      }));
    } catch (error) { fail(res, error); }
  });

  router.get("/staff", async (req, res) => {
    try { res.json(await repository.listStaffDirectory(org(req), { search: req.query.search || "", status: req.query.status || "all", limit: req.query.limit || 100 })); }
    catch (error) { fail(res, error); }
  });

  router.get("/patients", async (req, res) => {
    try { res.json(await repository.listPatientDirectory(org(req), { search: req.query.search || "", status: req.query.status || "all", limit: req.query.limit || 100 })); }
    catch (error) { fail(res, error); }
  });

  router.get("/supervision-queue", async (req, res) => {
    try { res.json(await repository.listSupervisionQueue(org(req), { search: req.query.search || "", severity: req.query.severity || "all", limit: req.query.limit || 100 })); }
    catch (error) { fail(res, error); }
  });

  router.get("/attendance/ledger", async (req, res) => {
    try { res.json(await repository.listAttendanceLedger(org(req), { search: req.query.search || "", limit: req.query.limit || 100 })); }
    catch (error) { fail(res, error); }
  });

  router.get("/call-center", async (req, res) => {
    try { res.json(await repository.getCallCenterData(org(req))); } catch (error) { fail(res, error); }
  });

  router.post("/assignments", async (req, res) => {
    try {
      const organizationId = org(req);
      const body = req.body || {};
      const required = ["assignmentId", "agentId", "language", "scheduledStartAt", "scheduledEndAt"];
      const missing = required.filter((key) => !body[key]);
      const fromNumber = body.fromNumber || process.env.VOBIZ_FROM_NUMBER;
      if (missing.length || !fromNumber || !body.employee?.id || !body.employee?.name || !body.employee?.phoneNumber || !body.patient?.id || !body.patient?.name || !body.patient?.address) {
        return res.status(400).json({ error: "Assignment requires assignmentId, agentId, language, scheduledStartAt, scheduledEndAt, employee identity and phone, patient identity and address, and either fromNumber or VOBIZ_FROM_NUMBER in the service environment" });
      }
      const startAt = new Date(body.scheduledStartAt);
      const endAt = new Date(body.scheduledEndAt);
      if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || endAt <= startAt) {
        return res.status(400).json({ error: "scheduledStartAt and scheduledEndAt must be valid, ordered timestamps" });
      }
      const agent = await repository.getAgent(organizationId, body.agentId);
      if (!agent?.active) return res.status(400).json({ error: "An active agent in this organization is required" });
      const session = await repository.createAttendanceSession({
        organizationId, assignmentId: body.assignmentId, scheduleVersion: body.scheduleVersion || "1",
        agentId: body.agentId, fromNumber, language: body.language,
        employee: body.employee, patient: body.patient, scheduledStartAt: startAt,
        scheduledEndAt: endAt, metadata: body.metadata || {},
      });
      await queue.enqueue("place_call", { sessionId: session.id, stage: "check_in", attemptNumber: 1 }, {
        idempotencyKey: `call:${session.id}:check_in:1`, runAt: startAt,
      });
      await queue.enqueue("place_call", { sessionId: session.id, stage: "check_out", attemptNumber: 1 }, {
        idempotencyKey: `call:${session.id}:check_out:1`, runAt: endAt,
      });
      res.status(202).json({ sessionId: session.id, status: session.sessionStatus, queued: ["check_in", "check_out"] });
    } catch (error) { fail(res, error); }
  });

  router.get("/assignments/:id/status", async (req, res) => {
    try {
      const organizationId = org(req);
      const session = await repository.getAttendanceSession(req.params.id);
      if (!session || session.organizationId !== organizationId) return res.status(404).json({ error: "Assignment session not found" });
      const context = session.activeContext || {};
      res.json({
        sessionId: session.id,
        assignmentId: session.assignmentId,
        sessionStatus: session.sessionStatus,
        checkIn: { status: session.checkInStatus, flag: session.checkInStatus === "not_answered" ? "not_answered" : null, reportedAt: context.checkIn?.reportedAt || null },
        checkOut: { status: session.checkOutStatus, flag: session.checkOutStatus === "not_answered" ? "not_answered" : null, reportedAt: context.checkOut?.reportedAt || null },
        backendDeliveryStatus: session.backendDeliveryStatus,
      });
    } catch (error) { fail(res, error); }
  });

  router.get("/agents", async (req, res) => {
    try { res.json(await repository.listAgents(org(req))); } catch (error) { fail(res, error); }
  });

  router.post("/agents", async (req, res) => {
    try {
      const organizationId = org(req);
      const body = req.body || {};
      if (!body.name?.trim()) return res.status(400).json({ error: "name is required" });
      const agent = await repository.createAgent(organizationId, {
        ...AGENT_DEFAULTS,
        ...body,
        name: body.name.trim(),
      });
      res.status(201).json(agent);
    } catch (error) { fail(res, error); }
  });

  router.get("/agents/:id", async (req, res) => {
    try {
      const agent = await repository.getAgent(org(req), req.params.id);
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      res.json(agent);
    } catch (error) { fail(res, error); }
  });

  router.patch("/agents/:id", async (req, res) => {
    try {
      const agent = await repository.updateAgent(org(req), req.params.id, req.body || {});
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      res.json(agent);
    } catch (error) { fail(res, error); }
  });

  router.delete("/agents/:id", async (req, res) => {
    try {
      const removed = await repository.deleteAgent(org(req), req.params.id);
      if (!removed) return res.status(404).json({ error: "Agent not found" });
      res.json({ success: true });
    } catch (error) { fail(res, error); }
  });

  router.get("/campaigns", async (req, res) => {
    try { res.json(await repository.listCampaigns(org(req))); } catch (error) { fail(res, error); }
  });

  router.post("/campaigns", async (req, res) => {
    try {
      const organizationId = org(req);
      const { name, agentId, fromNumber } = req.body || {};
      if (!name?.trim() || !agentId || !fromNumber) {
        return res.status(400).json({ error: "name, agentId and fromNumber are required" });
      }
      const agent = await repository.getAgent(organizationId, agentId);
      if (!agent || !agent.active) return res.status(400).json({ error: "An active agent in this organization is required" });
      const campaign = await repository.createCampaign(organizationId, {
        name: name.trim(), agentId, fromNumber, status: "draft",
      });
      res.status(201).json(campaign);
    } catch (error) { fail(res, error); }
  });

  router.get("/campaigns/:id", async (req, res) => {
    try {
      const campaign = await repository.getCampaign(org(req), req.params.id);
      if (!campaign) return res.status(404).json({ error: "Campaign not found" });
      res.json(campaign);
    } catch (error) { fail(res, error); }
  });

  // Vobiz posts call lifecycle fields here. Treat call IDs as provider data and
  // resolve them through the repository before updating tenant-owned records.
  router.post("/webhooks/call-status", async (req, res) => {
    try {
      if (!await validateWebhook(req)) return res.status(401).json({ error: "Invalid Vobiz webhook signature" });
      const providerCallId = req.body?.CallUUID || req.body?.call_uuid || req.body?.RequestUUID;
      const providerStatus = req.body?.CallStatus || req.body?.status;
      if (!providerCallId || !providerStatus) return res.status(400).json({ error: "Call ID and call status are required" });
      const result = await repository.updateCallByProviderId({
        provider: "vobiz",
        providerCallId,
        status: providerStatus,
        durationSeconds: req.body?.DialDuration || req.body?.duration || null,
        endedAt: req.body?.EndTime || new Date().toISOString(),
        rawEvent: req.body || {},
      });
      const status = String(req.body?.CallStatus || req.body?.status || "").toLowerCase().replace(/[\s_-]+/g, "");
      const terminal = Boolean(req.body?.EndTime || ["completed", "noanswer", "busy", "failed", "canceled", "cancelled"].includes(status));
      if (result?.sessionId && terminal) {
        await queue.enqueue("process_call_result", { callAttemptId: result.id }, { idempotencyKey: `call-result:${result.id}` });
        if (result.recordingUrl || result.recordingObjectKey) {
          await queue.enqueue("transcribe_call", { callAttemptId: result.id }, { idempotencyKey: `transcribe:${result.id}` });
        }
      }
      res.status(result ? 200 : 404).json({ received: Boolean(result) });
    } catch (error) { fail(res, error); }
  });

  return router;
}

module.exports = { createCallServiceRouter };
