"use strict";

const crypto = require("node:crypto");

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
  if (!queue?.enqueue || !queue?.transaction) throw new Error("A transactional durable job queue is required");

  const router = express.Router();
  router.use(express.json());
  router.use(express.urlencoded({ extended: false }));
  const validateWebhook = verifyWebhook || ((req) => verifyVobizWebhookSignature(req, process.env.VOBIZ_AUTH_TOKEN));
  const validateAdminToken = (req) => {
    const expected = Buffer.from(process.env.API_KEY_ADMIN_TOKEN || "");
    const supplied = Buffer.from(String(req.get("x-api-admin-token") || ""));
    return expected.length > 0 && expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
  };
  router.use(async (req, res, next) => {
    if (req.method === "POST" && ["/answer", "/webhooks/call-status"].includes(req.path)) return next();
    if (req.path === "/api-keys" || req.path.startsWith("/api-keys/")) {
      if (!process.env.API_KEY_ADMIN_TOKEN) return res.status(503).json({ error: "API_KEY_ADMIN_TOKEN is not configured" });
      if (!validateAdminToken(req)) return res.status(401).json({ error: "Valid X-API-Admin-Token is required" });
      req.orgId = process.env.DEFAULT_ORGANIZATION_ID;
      if (!req.orgId) return res.status(503).json({ error: "DEFAULT_ORGANIZATION_ID is not configured" });
      return next();
    }
    const match = /^Bearer\s+(.+)$/i.exec(String(req.get("authorization") || ""));
    if (!match) return res.status(401).json({ error: "A valid API key in Authorization: Bearer <key> is required" });
    const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
    try {
      const organizationId = await repository.resolveApiKey(hash);
      if (!organizationId) return res.status(401).json({ error: "API key is invalid or revoked" });
      req.orgId = organizationId;
      return next();
    } catch (error) { return next(error); }
  });
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
  const envNumber = (name, fallback) => process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : fallback;
  const getEffectiveCallingSettings = async (organizationId) => {
    const stored = await repository.getOrganizationCallSettings(organizationId);
    const storedRetry = stored.callRetry || {};
    return {
      defaultFromNumber: stored.defaultFromNumber ?? process.env.VOBIZ_FROM_NUMBER ?? "",
      retry: {
        maxConsecutiveNoAnswer: storedRetry.maxConsecutiveNoAnswer ?? envNumber("CALL_MAX_CONSECUTIVE_NO_ANSWER", 5),
        initialMinutes: storedRetry.initialMinutes ?? envNumber("CALL_RETRY_INITIAL_MINUTES", 5),
        multiplier: storedRetry.multiplier ?? envNumber("CALL_RETRY_MULTIPLIER", 1.2),
        maxMinutes: storedRetry.maxMinutes ?? envNumber("CALL_RETRY_MAX_MINUTES", 30),
      },
      source: {
        defaultFromNumber: stored.defaultFromNumber ? "settings" : "environment",
        retry: Object.keys(storedRetry).length ? "settings" : "environment",
      },
    };
  };

  router.post("/api-keys", async (req, res) => {
    try {
      const label = String(req.body?.label || "").trim();
      if (!label || label.length > 80) return res.status(400).json({ error: "label must contain 1 to 80 characters" });
      const secret = `athulya_live_${crypto.randomBytes(32).toString("base64url")}`;
      const key = await repository.createApiKey(req.orgId, {
        label,
        prefix: secret.slice(0, 17),
        hash: crypto.createHash("sha256").update(secret).digest("hex"),
      });
      res.status(201).json({ ...key, apiKey: secret });
    } catch (error) { fail(res, error); }
  });

  router.get("/api-keys", async (req, res) => {
    try { res.json(await repository.listApiKeys(req.orgId)); } catch (error) { fail(res, error); }
  });

  router.delete("/api-keys/:id", async (req, res) => {
    try {
      const revoked = await repository.revokeApiKey(req.orgId, req.params.id);
      if (!revoked) return res.status(404).json({ error: "Active API key not found" });
      res.json({ success: true });
    } catch (error) { fail(res, error); }
  });

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

  router.get("/settings/calling", async (req, res) => {
    try { res.set("Cache-Control", "private, no-store").json(await getEffectiveCallingSettings(org(req))); }
    catch (error) { fail(res, error); }
  });

  router.put("/settings/calling", async (req, res) => {
    try {
      const organizationId = org(req);
      const body = req.body || {};
      const defaultFromNumber = body.defaultFromNumber == null || body.defaultFromNumber === "" ? null : String(body.defaultFromNumber).trim();
      if (defaultFromNumber && !/^\\+[1-9]\\d{7,14}$/.test(defaultFromNumber)) {
        return res.status(400).json({ error: "Default caller ID must be in E.164 format, for example +918071580130" });
      }
      const retry = body.retry;
      if (!retry || typeof retry !== "object") return res.status(400).json({ error: "retry settings are required" });
      const maxConsecutiveNoAnswer = Number(retry.maxConsecutiveNoAnswer);
      const initialMinutes = Number(retry.initialMinutes);
      const multiplier = Number(retry.multiplier);
      const maxMinutes = Number(retry.maxMinutes);
      if (!Number.isInteger(maxConsecutiveNoAnswer) || maxConsecutiveNoAnswer < 1 || maxConsecutiveNoAnswer > 20
        || !Number.isInteger(initialMinutes) || initialMinutes < 1 || initialMinutes > 1440
        || !Number.isFinite(multiplier) || multiplier < 1 || multiplier > 5
        || !Number.isInteger(maxMinutes) || maxMinutes < initialMinutes || maxMinutes > 1440) {
        return res.status(400).json({ error: "Retry limit must be 1–20, initial/max intervals 1–1440 minutes with max ≥ initial, and multiplier 1–5" });
      }
      await repository.saveOrganizationCallSettings(organizationId, {
        defaultFromNumber,
        callRetry: { maxConsecutiveNoAnswer, initialMinutes, multiplier, maxMinutes },
      });
      res.json(await getEffectiveCallingSettings(organizationId));
    } catch (error) { fail(res, error); }
  });

  router.post("/settings/calling/reset", async (req, res) => {
    try {
      const organizationId = org(req);
      await repository.saveOrganizationCallSettings(organizationId, { defaultFromNumber: null, callRetry: null });
      res.json(await getEffectiveCallingSettings(organizationId));
    } catch (error) { fail(res, error); }
  });

  router.post("/assignments", async (req, res) => {
    try {
      const organizationId = org(req);
      const body = req.body || {};
      const required = ["assignmentId", "agentId", "language", "scheduledStartAt", "scheduledEndAt"];
      const missing = required.filter((key) => !body[key]);
      const callingSettings = await getEffectiveCallingSettings(organizationId);\n      const fromNumber = body.fromNumber || callingSettings.defaultFromNumber;
      if (missing.length || !fromNumber || !body.employee?.id || !body.employee?.name || !body.employee?.phoneNumber || !body.patient?.id || !body.patient?.name || !body.patient?.address) {
        return res.status(400).json({ error: "Assignment requires assignmentId, agentId, language, scheduledStartAt, scheduledEndAt, employee identity and phone, patient identity and address, and either fromNumber or the default caller ID in Settings/.env" });
      }
      const startAt = new Date(body.scheduledStartAt);
      const endAt = new Date(body.scheduledEndAt);
      if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || endAt <= startAt) {
        return res.status(400).json({ error: "scheduledStartAt and scheduledEndAt must be valid, ordered timestamps" });
      }
      const agent = await repository.getAgent(organizationId, body.agentId);
      if (!agent?.active) return res.status(400).json({ error: "An active agent in this organization is required" });
      const session = await queue.transaction(async (client) => {
        const created = await repository.createAttendanceSession({
          organizationId, assignmentId: body.assignmentId, scheduleVersion: body.scheduleVersion || "1",
          agentId: body.agentId, fromNumber, language: body.language,
          employee: body.employee, patient: body.patient, scheduledStartAt: startAt,
          scheduledEndAt: endAt, metadata: body.metadata || {},
        }, client);
        await queue.enqueue("place_call", { sessionId: created.id, stage: "check_in", attemptNumber: 1 }, {
          idempotencyKey: `call:${created.id}:check_in:1`, runAt: created.scheduledStartAt, client,
        });
        await queue.enqueue("place_call", { sessionId: created.id, stage: "check_out", attemptNumber: 1 }, {
          idempotencyKey: `call:${created.id}:check_out:1`, runAt: created.scheduledEndAt, client,
        });
        return created;
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
        checkIn: {
          status: session.checkInStatus,
          flag: session.checkInStatus === "not_answered" ? "not_answered" : null,
          reportedAt: context.checkIn?.reportedAt || null,
          scheduledAt: session.scheduledStartAt,
          nextCallAt: context.checkIn?.nextCallAt || null,
        },
        checkOut: {
          status: session.checkOutStatus,
          flag: session.checkOutStatus === "not_answered" ? "not_answered" : null,
          reportedAt: context.checkOut?.reportedAt || null,
          scheduledAt: session.scheduledEndAt,
          nextCallAt: context.checkOut?.nextCallAt || null,
        },
        backendDeliveryStatus: session.backendDeliveryStatus,
      });
    } catch (error) { fail(res, error); }
  });

  router.get("/assignments/:id/artifacts", async (req, res) => {
    try {
      const artifacts = await repository.getSessionArtifacts(req.params.id);
      if (!artifacts || artifacts.session.organizationId !== org(req)) return res.status(404).json({ error: "Assignment session not found" });
      const baseUrl = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
      res.set("Cache-Control", "private, no-store");
      res.json({
        session: artifacts.session,
        callAttempts: artifacts.callAttempts.map((attempt) => ({
          id: attempt.id,
          stage: attempt.stage,
          attemptNumber: attempt.attemptNumber,
          status: attempt.status,
          scheduledAt: attempt.scheduledAt,
          answeredAt: attempt.answeredAt,
          endedAt: attempt.endedAt,
          durationSeconds: attempt.durationSeconds,
          outcome: attempt.outcome,
          recordingAvailable: Boolean(attempt.recordingObjectKey),
          recordingUrl: attempt.recordingObjectKey
            ? `${baseUrl}/api/call-service/assignments/${encodeURIComponent(req.params.id)}/recordings/${encodeURIComponent(attempt.id)}`
            : null,
        })),
        transcripts: artifacts.transcripts,
        logs: artifacts.logs,
      });
    } catch (error) { fail(res, error); }
  });

  router.get("/assignments/:id/recordings/:attemptId", async (req, res) => {
    try {
      const session = await repository.getAttendanceSession(req.params.id);
      if (!session || session.organizationId !== org(req)) return res.status(404).json({ error: "Assignment session not found" });
      const attempt = await repository.getCallAttempt(req.params.attemptId);
      if (!attempt || attempt.sessionId !== session.id || !attempt.recordingObjectKey) {
        return res.status(404).json({ error: "Recording is not available for this call attempt" });
      }
      const buffer = await recordings.getObjectBuffer(attempt.recordingObjectKey);
      res.set({
        "Cache-Control": "private, no-store",
        "Content-Type": attempt.recordingContentType || "application/octet-stream",
        "Content-Disposition": `inline; filename="attendance-${attempt.id}.audio"`,
        "Content-Length": String(buffer.length),
      });
      return res.status(200).send(buffer);
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
        if (["completed", "answered"].includes(status)) {
          const session = await repository.getAttendanceSession(result.sessionId);
          const currentStageStatus = result.stage === "check_in" ? session?.checkInStatus : session?.checkOutStatus;
          if (currentStageStatus === "calling") {
            await repository.setStageStatus(result.sessionId, result.stage, "processing", {
              reason: "call_ended_processing",
              callAttemptId: result.id,
            });
          }
        }
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
