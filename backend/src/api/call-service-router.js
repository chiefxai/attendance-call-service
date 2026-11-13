"use strict";

const crypto = require("node:crypto");

const { createVobizClient } = require("../infrastructure/telephony/vobiz-client");
const { normalizeIndianMobile } = require("../domain/attendance/phone-number");
const { assertRepository } = require("../domain/repository-contract");
const { verifyVobizWebhookSignature } = require("../infrastructure/telephony/vobiz-signature");
const { createVobizLiveRuntime } = require("../realtime/vobiz-live-runtime");
const { DEFAULT_BASE_URL, encryptSecret, decryptSecret, validateBaseUrl, fetchAthulyaSchedules, localDateInTimeZone } = require("../infrastructure/integrations/athulya-platform");

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
    if (req.method === "POST" && ["/answer", "/incoming/answer", "/care-manager-alert/answer", "/webhooks/call-status"].includes(req.path)) return next();

    try {
      const cookieHeader = String(req.headers.cookie || "");
      const cookiePair = cookieHeader.split(";").map((item) => item.trim()).find((item) => item.startsWith("attendance_session="));
      const sessionToken = cookiePair ? decodeURIComponent(cookiePair.slice("attendance_session=".length)) : "";
      if (sessionToken) {
        const user = await repository.resolveWebSession(crypto.createHash("sha256").update(sessionToken).digest("hex"));
        if (user) {
          if (user.mustChangePassword) return res.status(403).json({ error: "Change your temporary password before using the application." });
          req.orgId = user.organizationId;
          req.webUser = { id: user.id, email: user.email, displayName: user.displayName, role: user.role || "admin", careManagerExternalId: user.careManagerExternalId || null, mustChangePassword: false };
          return next();
        }
      }

      if (req.path === "/api-keys" || req.path.startsWith("/api-keys/")) {
        if (!process.env.API_KEY_ADMIN_TOKEN) return res.status(503).json({ error: "API_KEY_ADMIN_TOKEN is not configured" });
        if (!validateAdminToken(req)) return res.status(401).json({ error: "A web session or valid X-API-Admin-Token is required" });
        req.orgId = process.env.DEFAULT_ORGANIZATION_ID;
        req.webUser = { role: "admin", id: null };
        if (!req.orgId) return res.status(503).json({ error: "DEFAULT_ORGANIZATION_ID is not configured" });
        return next();
      }

      const match = /^Bearer\s+(.+)$/i.exec(String(req.get("authorization") || ""));
      if (!match) return res.status(401).json({ error: "Sign in or provide a service API key." });
      const keyHash = crypto.createHash("sha256").update(match[1]).digest("hex");
      const organizationId = await repository.resolveApiKey(keyHash);
      if (!organizationId) return res.status(401).json({ error: "API key is invalid or revoked" });
      req.orgId = organizationId;
      return next();
    } catch (error) { return next(error); }
  });
  const liveRuntime = createVobizLiveRuntime({ repository, vobiz, verifyWebhook: validateWebhook, getClientForOrg, recordings, queue });
  router.post("/answer", liveRuntime.answerHandler);
  router.post("/incoming/answer", liveRuntime.incomingAnswerHandler);
  router.post("/care-manager-alert/answer", async (req, res) => {
    if (!await validateWebhook(req)) return res.status(401).send("Invalid Vobiz signature");
    const message = String(req.query.message || "").trim().slice(0, 500);
    if (!message) return res.status(400).send("Missing alert message");
    const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
    res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Speak>${xml(message)}</Speak><Hangup/></Response>`);
  });
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
  const requireAdmin = (req, res) => {
    if (req.webUser?.role === "admin") return true;
    res.status(403).json({ error: "Admin access is required for this action." });
    return false;
  };
  const careManagerScope = (req) => req.webUser?.role === "care_manager"
    ? (req.webUser.careManagerExternalId || "__unlinked_care_manager__")
    : null;
  const assertSessionVisible = async (req, sessionId, res) => {
    const managerId = careManagerScope(req);
    if (!managerId) return true;
    const visible = await repository.isAttendanceSessionVisibleToCareManager(org(req), sessionId, managerId);
    if (!visible) res.status(404).json({ error: "Assignment session not found" });
    return visible;
  };
  const assertInboundVisible = async (req, callId, res) => {
    const managerId = careManagerScope(req);
    if (!managerId) return true;
    const visible = await repository.isInboundCallVisibleToCareManager(org(req), callId, managerId);
    if (!visible) res.status(404).json({ error: "Incoming call not found" });
    return visible;
  };
  const fail = (res, error) => res.status(error.status || 500).json({ error: error.message || "Request failed" });
  const envNumber = (name, fallback) => process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : fallback;
  const getEffectiveCallingSettings = async (organizationId) => {
    const stored = await repository.getOrganizationCallSettings(organizationId);
    const storedRetry = stored.callRetry || {};
    return {
      defaultFromNumber: stored.defaultFromNumber ?? process.env.VOBIZ_FROM_NUMBER ?? "",
      allowInboundCalls: stored.allowInboundCalls ?? true,
      allowNonPatientInboundCalls: stored.allowNonPatientInboundCalls ?? false,
      requireHumanVerificationForStaffBooking: stored.requireHumanVerificationForStaffBooking ?? false,
      unansweredCallEscalation: stored.unansweredCallEscalation ?? "platform_notification",
      retry: {
        maxConsecutiveNoAnswer: storedRetry.maxConsecutiveNoAnswer ?? envNumber("CALL_MAX_CONSECUTIVE_NO_ANSWER", 3),
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
    if (!requireAdmin(req, res)) return;
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

  router.get("/care-manager/notifications", async (req, res) => {
    try {
      const userId = req.webUser?.id;
      if (!userId) return res.status(403).json({ error: "Care manager sign-in is required." });
      res.set("Cache-Control", "private, no-store").json(await repository.listCareManagerNotifications(org(req), userId));
    } catch (error) { fail(res, error); }
  });

  router.post("/care-manager/notifications/:id/read", async (req, res) => {
    try {
      const userId = req.webUser?.id;
      if (!userId) return res.status(403).json({ error: "Care manager sign-in is required." });
      const updated = await repository.markCareManagerNotificationRead(org(req), userId, req.params.id);
      if (!updated) return res.status(404).json({ error: "Notification not found." });
      res.json({ id: req.params.id, read: true });
    } catch (error) { fail(res, error); }
  });

  router.get("/api-keys", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try { res.json(await repository.listApiKeys(req.orgId)); } catch (error) { fail(res, error); }
  });

  router.delete("/api-keys/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const revoked = await repository.revokeApiKey(req.orgId, req.params.id);
      if (!revoked) return res.status(404).json({ error: "Active API key not found" });
      res.json({ success: true });
    } catch (error) { fail(res, error); }
  });

  router.get("/care-managers", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try { res.json(await repository.listCareManagers(org(req))); } catch (error) { fail(res, error); }
  });

  router.post("/care-managers/:id/provision", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const organizationId = org(req);
      const manager = (await repository.listCareManagers(organizationId)).find((item) => item.id === req.params.id);
      if (!manager) return res.status(404).json({ error: "Care Manager not found." });
      if (manager.userId) return res.status(409).json({ error: "This Care Manager already has an account." });
      const phone = normalizeIndianMobile(manager.phone);
      if (!phone) return res.status(409).json({ error: "A valid Indian mobile number must be synced for this Care Manager before providing an account." });
      const password = String(req.body?.password || "");
      if (password.length < 12 || password.length > 1024) return res.status(400).json({ error: "Temporary password must contain 12 to 1024 characters." });
      const passwordSalt = crypto.randomBytes(16).toString("hex");
      const passwordHash = crypto.scryptSync(password, passwordSalt, 64).toString("hex");
      await repository.provisionCareManagerAccounts({ organizationId, managers: [{
        athulyaId: manager.athulyaCareManagerId,
        name: manager.name || `Care Manager ${manager.athulyaCareManagerId}`,
        phone,
        passwordSalt,
        passwordHash,
      }] });
      res.status(201).json({ success: true, loginPhone: phone, active: false, mustChangePassword: true });
    } catch (error) { fail(res, error); }
  });

  router.post("/care-managers", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const body = req.body || {};
      const email = String(body.email || "").trim().toLowerCase();
      const displayName = String(body.name || "").trim();
      const athulyaId = String(body.athulyaCareManagerId || "").trim();
      const phone = String(body.phone || "").trim();
      const password = String(body.password || "");
      if (!/^\S+@\S+\.\S+$/.test(email) || !displayName || !athulyaId || password.length < 12 || password.length > 1024) {
        return res.status(400).json({ error: "Provide a valid name, email, Athulya Care Manager ID, and password of at least 12 characters." });
      }
      const salt = crypto.randomBytes(16).toString("hex");
      const passwordHash = crypto.scryptSync(password, salt, 64).toString("hex");
      const user = await repository.createCareManagerUser({ organizationId: org(req), email, displayName, passwordSalt: salt, passwordHash, athulyaId, phone: phone || null });
      res.status(201).json({ id: user.id, email: user.email, displayName: user.display_name || displayName, role: "care_manager" });
    } catch (error) { fail(res, error); }
  });

  router.put("/care-managers/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const body = req.body || {};
      const email = String(body.email || "").trim().toLowerCase();
      const name = String(body.name || "").trim();
      const athulyaId = String(body.athulyaCareManagerId || "").trim();
      const phone = String(body.phone || "").trim();
      if (!/^\S+@\S+\.\S+$/.test(email) || !name || !athulyaId) return res.status(400).json({ error: "Provide a valid name, email, and Athulya Care Manager ID." });
      if (!await repository.updateCareManager(org(req), req.params.id, { name, email, phone, athulyaId })) return res.status(404).json({ error: "Care Manager not found" });
      res.json({ success: true });
    } catch (error) { fail(res, error); }
  });

  router.patch("/care-managers/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const active = req.body?.active;
    if (typeof active !== "boolean") return res.status(400).json({ error: "active must be true or false" });
    try {
      if (!await repository.setCareManagerActive(org(req), req.params.id, active)) return res.status(404).json({ error: "Care Manager not found" });
      res.json({ success: true, active });
    } catch (error) { fail(res, error); }
  });

  router.post("/care-managers/:id/reset-password", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const password = String(req.body?.password || "");
      if (password.length < 12 || password.length > 1024) return res.status(400).json({ error: "Password must contain 12 to 1024 characters." });
      const salt = crypto.randomBytes(16).toString("hex");
      const passwordHash = crypto.scryptSync(password, salt, 64).toString("hex");
      if (!await repository.resetCareManagerPassword(org(req), req.params.id, salt, passwordHash)) return res.status(404).json({ error: "Care Manager not found" });
      res.json({ success: true, sessionsRevoked: true });
    } catch (error) { fail(res, error); }
  });

  router.get("/integrations/athulya", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const value = await repository.getAthulyaIntegration(org(req));
      res.json({ integrationName: value.integrationName, apiBaseUrl: value.apiBaseUrl || DEFAULT_BASE_URL, enabled: value.enabled,
        autoSyncEnabled: value.autoSyncEnabled === true, autoSyncEnabledAt: value.autoSyncEnabledAt || null,
        lastAutoSyncSlot: value.lastAutoSyncSlot || null, autoSyncTimeZone: process.env.APP_TIMEZONE || "Asia/Kolkata",
        autoSyncScope: value.autoSyncScope || "all", autoSyncScopeId: value.autoSyncScopeId || "",
        keyConfigured: Boolean(value.encryptedApiKey), apiKeyMasked: value.encryptedApiKey ? "••••••••" : "", updatedAt: value.updatedAt || null,
        lastSuccessfulScheduleSync: value.lastSuccessfulScheduleSync || null,
        lastSuccessfulAttendanceSubmission: value.lastSuccessfulAttendanceSubmission || null,
        attendanceSubmissionStatus: "awaiting_api_specification" });
    } catch (error) { fail(res, error); }
  });

  router.put("/integrations/athulya", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const body = req.body || {};
      const integrationName = String(body.integrationName || "Athulya Platform").trim().slice(0, 100);
      const apiBaseUrl = validateBaseUrl(body.apiBaseUrl || DEFAULT_BASE_URL);
      const enabled = body.enabled === true;
      if (body.autoSyncEnabled != null && typeof body.autoSyncEnabled !== "boolean") return res.status(400).json({ error: "autoSyncEnabled must be a boolean." });
      const autoSyncEnabled = body.autoSyncEnabled === true;
      const autoSyncScope = String(body.autoSyncScope || "all");
      const autoSyncScopeId = String(body.autoSyncScopeId || "").trim();
      if (!["all", "branch", "care_manager"].includes(autoSyncScope)) return res.status(400).json({ error: "autoSyncScope must be all, branch, or care_manager." });
      if (autoSyncScopeId.length > 100) return res.status(400).json({ error: "autoSyncScopeId must be at most 100 characters." });
      const old = await repository.getAthulyaIntegration(org(req));
      const apiKeyInput = String(body.apiKey || "").trim();
      const encryptedApiKey = apiKeyInput ? encryptSecret(apiKeyInput) : null;
      if (enabled && !(encryptedApiKey || old.encryptedApiKey)) return res.status(400).json({ error: "Enter the Athulya API key before enabling the integration." });
      if (autoSyncEnabled && !enabled) return res.status(400).json({ error: "Enable the Athulya integration before enabling automatic sync." });
      if (autoSyncEnabled && autoSyncScope !== "all" && !autoSyncScopeId) return res.status(400).json({ error: "Enter the branch or Care Manager ID for the selected automatic sync scope." });
      const saved = await repository.saveAthulyaIntegration(org(req), { integrationName, apiBaseUrl, encryptedApiKey, enabled, autoSyncEnabled, autoSyncScope, autoSyncScopeId, updatedBy: req.webUser?.id });
      res.json({ integrationName: saved.integrationName, apiBaseUrl: saved.apiBaseUrl, enabled: saved.enabled,
        autoSyncEnabled: saved.autoSyncEnabled === true, autoSyncEnabledAt: saved.autoSyncEnabledAt || null,
        lastAutoSyncSlot: saved.lastAutoSyncSlot || null, autoSyncTimeZone: process.env.APP_TIMEZONE || "Asia/Kolkata",
        autoSyncScope: saved.autoSyncScope || "all", autoSyncScopeId: saved.autoSyncScopeId || "",
        keyConfigured: Boolean(saved.encryptedApiKey), apiKeyMasked: saved.encryptedApiKey ? "••••••••" : "", updatedAt: saved.updatedAt,
        lastSuccessfulScheduleSync: saved.lastSuccessfulScheduleSync || null,
        lastSuccessfulAttendanceSubmission: saved.lastSuccessfulAttendanceSubmission || null,
        attendanceSubmissionStatus: "awaiting_api_specification" });
    } catch (error) { fail(res, error); }
  });

  router.post("/integrations/athulya/test", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const settings = await repository.getAthulyaIntegration(org(req));
      const apiBaseUrl = validateBaseUrl(req.body?.apiBaseUrl || settings.apiBaseUrl);
      const apiKey = String(req.body?.apiKey || "").trim() || decryptSecret(settings.encryptedApiKey);
      const scheduleDate = localDateInTimeZone(new Date(), process.env.APP_TIMEZONE || "Asia/Kolkata");
      const records = await fetchAthulyaSchedules({ apiBaseUrl, apiKey, filters: { from_date: scheduleDate, to_date: scheduleDate } });
      res.json({ connected: true, scheduleDate, recordsReceived: records.length });
    } catch (error) { res.status(502).json({ connected: false, error: error.message }); }
  });

  router.post("/integrations/athulya/sync", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const settings = await repository.getAthulyaIntegration(org(req));
      if (!settings.enabled) return res.status(409).json({ error: "Enable the Athulya integration before synchronising." });
      const body = req.body || {};
      const fromDate = body.fromDate ? String(body.fromDate) : "";
      const toDate = body.toDate ? String(body.toDate) : "";
      const scheduleDate = String(body.scheduleDate || body.date || fromDate || toDate
        || localDateInTimeZone(new Date(), process.env.APP_TIMEZONE || "Asia/Kolkata"));
      const datePattern = /^\d{4}-\d{2}-\d{2}$/;
      const validDate = (value) => {
        if (!datePattern.test(value)) return false;
        const parsed = new Date(`${value}T00:00:00.000Z`);
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
      };
      if (!validDate(scheduleDate) || (fromDate && fromDate !== scheduleDate) || (toDate && toDate !== scheduleDate)) {
        return res.status(400).json({ error: "Sync exactly one schedule date using YYYY-MM-DD. Date ranges are not supported." });
      }
      const filters = { from_date: scheduleDate, to_date: scheduleDate,
        care_manager_id: body.careManagerId || undefined, branch_id: body.branchId || undefined, client_id: body.clientId || undefined };
      if (filters.care_manager_id && filters.branch_id) return res.status(400).json({ error: "Choose either one branch or one Care Manager for sync, not both." });
      const selectedScope = filters.branch_id ? "branch" : filters.care_manager_id ? "care_manager" : "all";
      const selectedScopeId = filters.branch_id || filters.care_manager_id || "";
      if (selectedScopeId.length > 100) return res.status(400).json({ error: "Branch and Care Manager IDs must be at most 100 characters." });
      filters.sync_scope = selectedScope;
      filters.sync_scope_id = selectedScopeId;
      const runId = await repository.createAthulyaSyncRun(org(req), { fromDate: scheduleDate, toDate: scheduleDate, filters });
      await queue.enqueue("sync_athulya_schedules", { runId, organizationId: org(req), filters }, { idempotencyKey: `athulya-sync:${runId}` });
      res.status(202).json({ runId, status: "running", scheduleDate });
    } catch (error) { fail(res, error); }
  });

  router.get("/integrations/athulya/sync-status", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try { res.json(await repository.listAthulyaSyncRuns(org(req))); } catch (error) { fail(res, error); }
  });

  router.get("/integrations/athulya/attendance-submissions", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const date = (key) => {
        const value = String(req.query[key] || "").trim();
        if (!value) return null;
        const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
          ? `${value}T${key === "toDate" ? "23:59:59.999" : "00:00:00.000"}Z` : value;
        const parsed = new Date(normalized);
        if (!Number.isFinite(parsed.getTime())) { const error = new Error(`${key} must be a valid timestamp`); error.status = 400; throw error; }
        return parsed;
      };
      res.json(await repository.listAthulyaAttendanceSubmissions(org(req), {
        eventType: ["check_in", "check_out"].includes(String(req.query.eventType)) ? String(req.query.eventType) : "all",
        status: ["pending", "processing", "synced", "failed", "retry_scheduled", "awaiting_api_specification"].includes(String(req.query.status)) ? String(req.query.status) : "all",
        fromDate: date("fromDate"), toDate: date("toDate"), caregiverId: String(req.query.caregiverId || ""), patientId: String(req.query.patientId || ""),
        limit: req.query.limit || 200,
      }));
    } catch (error) { fail(res, error); }
  });

  router.get("/integrations/athulya/schedules", async (req, res) => {
    try { res.json(await repository.listAthulyaSchedules(org(req), { fromDate: req.query.fromDate, toDate: req.query.toDate, limit: req.query.limit, careManagerExternalId: careManagerScope(req) })); }
    catch (error) { fail(res, error); }
  });

  router.get("/dashboard/summary", async (req, res) => {
    try { res.json(await repository.getOperationsSummary(org(req), { careManagerExternalId: careManagerScope(req) })); } catch (error) { fail(res, error); }
  });

  router.get("/assignments", async (req, res) => {
    try {
      res.json(await repository.listAttendanceSessions(org(req), {
        search: req.query.search || "", status: req.query.status || "all",
        limit: req.query.limit || 100, offset: req.query.offset || 0, careManagerExternalId: careManagerScope(req),
      }));
    } catch (error) { fail(res, error); }
  });

  router.get("/assignments/overlap", async (req, res) => {
    try {
      const organizationId = org(req);
      const employeeId = String(req.query.employeeId || "").trim();
      const startAt = new Date(String(req.query.startAt || ""));
      const endAt = new Date(String(req.query.endAt || ""));
      if (!employeeId || !Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || endAt <= startAt) {
        return res.status(400).json({ error: "employeeId, valid startAt, and a later endAt are required." });
      }
      const conflict = await repository.findEmployeeScheduleOverlap({
        organizationId, employeeId, startAt, endAt,
        assignmentId: String(req.query.assignmentId || "").trim(),
      });
      res.json({ overlap: Boolean(conflict), conflict });
    } catch (error) { fail(res, error); }
  });

  router.post("/staff", async (req, res) => {
    const id = String(req.body?.id || "").trim();
    const name = String(req.body?.name || "").trim();
    const companyName = String(req.body?.companyName || "").trim() || "ATHULYA";
    const phoneNumber = normalizeIndianMobile(req.body?.phoneNumber);
    const address = String(req.body?.address || "").trim();
    const language = String(req.body?.language || "en").trim().toLowerCase();
    if (!id || id.length > 120) return res.status(400).json({ error: "Staff ID is required and must be at most 120 characters." });
    if (!name || name.length > 120) return res.status(400).json({ error: "Staff name is required and must be at most 120 characters." });
    if (companyName.length > 200) return res.status(400).json({ error: "Company name must be at most 200 characters." });
    if (!phoneNumber) return res.status(400).json({ error: "Enter a valid 10-digit Indian mobile number, optionally prefixed with 91 or +91." });
    if (!address || address.length > 1000) return res.status(400).json({ error: "Staff address is required and must be at most 1000 characters." });
    if (!["ta", "en", "ml", "te"].includes(language)) return res.status(400).json({ error: "Language must be ta, en, ml, or te." });
    try {
      const record = await repository.createStaffDirectoryRecord(org(req), { id, name, companyName, phoneNumber, address, language });
      if (!record) return res.status(409).json({ error: "A staff record with this ID already exists." });
      return res.status(201).json(record);
    } catch (error) { return fail(res, error); }
  });

  router.put("/staff/:id", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const name = String(req.body?.name || "").trim();
    const companyName = String(req.body?.companyName || "").trim() || "ATHULYA";
    const phoneNumber = normalizeIndianMobile(req.body?.phoneNumber);
    const address = String(req.body?.address || "").trim();
    const language = String(req.body?.language || "en").trim().toLowerCase();
    if (!id || id.length > 120) return res.status(400).json({ error: "Staff ID is invalid." });
    if (!name || name.length > 120) return res.status(400).json({ error: "Staff name is required and must be at most 120 characters." });
    if (companyName.length > 200) return res.status(400).json({ error: "Company name must be at most 200 characters." });
    if (!phoneNumber) return res.status(400).json({ error: "Enter a valid 10-digit Indian mobile number, optionally prefixed with 91 or +91." });
    if (!address || address.length > 1000) return res.status(400).json({ error: "Staff address is required and must be at most 1000 characters." });
    if (!["ta", "en", "ml", "te"].includes(language)) return res.status(400).json({ error: "Language must be ta, en, ml, or te." });
    try {
      const record = await repository.updateStaffDirectoryRecord(org(req), { id, name, companyName, phoneNumber, address, language });
      return res.json(record);
    } catch (error) { return fail(res, error); }
  });

  router.get("/staff", async (req, res) => {
    try { res.json(await repository.listStaffDirectory(org(req), { search: req.query.search || "", status: req.query.status || "all", limit: req.query.limit || 100, careManagerExternalId: careManagerScope(req) })); }
    catch (error) { fail(res, error); }
  });

  router.post("/patients", async (req, res) => {
    const id = String(req.body?.id || "").trim();
    const name = String(req.body?.name || "").trim();
    const phoneInput = String(req.body?.phoneNumber || "").trim();
    const phoneNumber = phoneInput ? normalizeIndianMobile(phoneInput) : "";
    const address = String(req.body?.address || "").trim();
    const language = String(req.body?.language || "en").trim().toLowerCase();
    const careCategory = String(req.body?.careCategory || "").trim();
    const hub = String(req.body?.hub || "").trim();
    if (!id || id.length > 120) return res.status(400).json({ error: "Patient ID is required and must be at most 120 characters." });
    if (!name || name.length > 120) return res.status(400).json({ error: "Patient name is required and must be at most 120 characters." });
    if (phoneInput && !phoneNumber) return res.status(400).json({ error: "Enter a valid 10-digit Indian mobile number, optionally prefixed with 91 or +91." });
    if (!address || address.length > 1000) return res.status(400).json({ error: "Patient address is required and must be at most 1000 characters." });
    if (!["ta", "en", "ml", "te"].includes(language)) return res.status(400).json({ error: "Language must be ta, en, ml, or te." });
    if (careCategory.length > 120 || hub.length > 120) return res.status(400).json({ error: "Care category and hub must be at most 120 characters." });
    try {
      const record = await repository.createPatientDirectoryRecord(org(req), { id, name, phoneNumber, address, language, careCategory, hub });
      if (!record) return res.status(409).json({ error: "A patient record with this ID already exists." });
      return res.status(201).json(record);
    } catch (error) { return fail(res, error); }
  });

  router.put("/patients/:id", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const name = String(req.body?.name || "").trim();
    const phoneInput = String(req.body?.phoneNumber || "").trim();
    const phoneNumber = phoneInput ? normalizeIndianMobile(phoneInput) : "";
    const address = String(req.body?.address || "").trim();
    const language = String(req.body?.language || "en").trim().toLowerCase();
    const careCategory = String(req.body?.careCategory || "").trim();
    const hub = String(req.body?.hub || "").trim();
    if (!id || id.length > 120) return res.status(400).json({ error: "Patient ID is invalid." });
    if (!name || name.length > 120) return res.status(400).json({ error: "Patient name is required and must be at most 120 characters." });
    if (phoneInput && !phoneNumber) return res.status(400).json({ error: "Enter a valid 10-digit Indian mobile number, optionally prefixed with 91 or +91." });
    if (!address || address.length > 1000) return res.status(400).json({ error: "Patient address is required and must be at most 1000 characters." });
    if (!["ta", "en", "ml", "te"].includes(language)) return res.status(400).json({ error: "Language must be ta, en, ml, or te." });
    if (careCategory.length > 120 || hub.length > 120) return res.status(400).json({ error: "Care category and hub must be at most 120 characters." });
    try {
      const record = await repository.updatePatientDirectoryRecord(org(req), { id, name, phoneNumber, address, language, careCategory, hub });
      return res.json(record);
    } catch (error) { return fail(res, error); }
  });

  router.get("/patients", async (req, res) => {
    try { res.json(await repository.listPatientDirectory(org(req), { search: req.query.search || "", status: req.query.status || "all", limit: req.query.limit || 100, careManagerExternalId: careManagerScope(req) })); }
    catch (error) { fail(res, error); }
  });

  router.get("/supervision-queue", async (req, res) => {
    try { res.json(await repository.listSupervisionQueue(org(req), { search: req.query.search || "", severity: req.query.severity || "all", limit: req.query.limit || 100, careManagerExternalId: careManagerScope(req) })); }
    catch (error) { fail(res, error); }
  });

  router.get("/attendance/ledger", async (req, res) => {
    try { res.json(await repository.listAttendanceLedger(org(req), { search: req.query.search || "", limit: req.query.limit || 100, careManagerExternalId: careManagerScope(req) })); }
    catch (error) { fail(res, error); }
  });

  router.get("/call-center", async (req, res) => {
    try { res.json(await repository.getCallCenterData(org(req), { careManagerExternalId: careManagerScope(req) })); } catch (error) { fail(res, error); }
  });

  function serializeIncomingCall(call, appointmentCalls = []) {
    const hasRecording = Boolean(call.recordingObjectKey);
    const hasTranscript = Boolean(call.transcript?.trim());
    const terminalStatus = ["failed", "no_answer", "canceled", "cancelled"].includes(call.status);
    const status = terminalStatus ? call.status
      : (["ringing", "in_progress"].includes(call.status) || !hasRecording || !hasTranscript ? "processing" : "ready");
    return {
      id: call.id, status, fromNumber: call.fromNumber, patient: call.patient || null,
      language: call.language, startedAt: call.startedAt, answeredAt: call.answeredAt,
      endedAt: call.endedAt, durationSeconds: call.durationSeconds,
      hasRecording, hasTranscript, transcript: call.transcript || null,
      transcriptLanguage: call.transcriptLanguage || null,
      enquiryStatus: call.enquiryStatus,
      resolvedStaff: call.resolvedStaff || null,
      resolvedAt: call.resolvedAt || null,
      enquiryAnalysisStatus: call.enquiryAnalysisStatus || "pending",
      enquiryAnalysis: call.enquiryAnalysis || {},
      staffSuggestions: call.staffSuggestions || [],
      bookingStatus: call.bookingStatus || "not_started",
      bookingStaff: call.bookingStaff || null,
      bookingScheduleSessionId: call.bookingScheduleSessionId || null,
      appointmentCalls,
    };
  }

router.get("/activities", async (req, res) => {
    try { res.set("Cache-Control", "private, no-store").json(await repository.listCareActivities(org(req), { includeInactive: req.query.includeInactive === "true" })); }
    catch (error) { fail(res, error); }
  });

  router.post("/activities", async (req, res) => {
    const name = String(req.body?.name || "").trim();
    const description = String(req.body?.description || "").trim();
    const durationMinutes = Number(req.body?.durationMinutes);
    const rawAliases = req.body?.aliases ?? [];
    if (!Array.isArray(rawAliases) || rawAliases.length > 30 || rawAliases.some((alias) => typeof alias !== "string" || !alias.trim() || alias.trim().length > 120)) return res.status(400).json({ error: "Aliases must be up to 30 non-empty names, each at most 120 characters." });
    const aliases = [...new Map(rawAliases.map((alias) => [alias.trim().toLocaleLowerCase(), alias.trim()])).values()];
    if (!name || name.length > 120) return res.status(400).json({ error: "Activity name is required and must be at most 120 characters." });
    if (description.length > 500) return res.status(400).json({ error: "Description must be at most 500 characters." });
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 10080) return res.status(400).json({ error: "Duration must be between 1 and 10080 minutes." });
    try { return res.status(201).json(await repository.createCareActivity(org(req), { name, aliases, description, durationMinutes })); }
    catch (error) {
      if (error.code === "23505") return res.status(409).json({ error: "An activity with this name already exists." });
      return fail(res, error);
    }
  });

  router.put("/activities/:id", async (req, res) => {
    const name = String(req.body?.name || "").trim();
    const description = String(req.body?.description || "").trim();
    const durationMinutes = Number(req.body?.durationMinutes);
    const rawAliases = req.body?.aliases ?? [];
    if (!Array.isArray(rawAliases) || rawAliases.length > 30 || rawAliases.some((alias) => typeof alias !== "string" || !alias.trim() || alias.trim().length > 120)) return res.status(400).json({ error: "Aliases must be up to 30 non-empty names, each at most 120 characters." });
    const aliases = [...new Map(rawAliases.map((alias) => [alias.trim().toLocaleLowerCase(), alias.trim()])).values()];
    if (!name || name.length > 120) return res.status(400).json({ error: "Activity name is required and must be at most 120 characters." });
    if (description.length > 500) return res.status(400).json({ error: "Description must be at most 500 characters." });
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 10080) return res.status(400).json({ error: "Duration must be between 1 and 10080 minutes." });
    if (req.body?.active !== undefined && typeof req.body.active !== "boolean") return res.status(400).json({ error: "active must be a boolean." });
    try {
      const activity = await repository.updateCareActivity(org(req), req.params.id, { name, aliases, description, durationMinutes, active: req.body?.active });
      if (!activity) return res.status(404).json({ error: "Activity not found." });
      return res.json(activity);
    } catch (error) {
      if (error.code === "23505") return res.status(409).json({ error: "An activity with this name already exists." });
      return fail(res, error);
    }
  });

    router.get("/incoming-calls", async (req, res) => {
    try {
      const calls = await repository.listInboundCalls(org(req), req.query.limit || 100, careManagerScope(req));
      res.json(await Promise.all(calls.map(async (call) => serializeIncomingCall(
        call, await repository.listAppointmentCallAttempts(call.id, org(req)),
      ))));
    } catch (error) { fail(res, error); }
  });

  router.get("/incoming-calls/:id", async (req, res) => {
    try {
      const call = await repository.getInboundCall(req.params.id, org(req));
      if (!call || !await assertInboundVisible(req, req.params.id, res)) return;
      res.json(serializeIncomingCall(call, await repository.listAppointmentCallAttempts(call.id, org(req))));
    } catch (error) { fail(res, error); }
  });

  router.post("/incoming-calls/:id/resolve", async (req, res) => {
    try {
      const body = req.body || {};
      if (Object.keys(body).some((key) => key !== "staffId")) {
        return res.status(400).json({ error: "Only staffId is accepted; enquiry status is controlled by the system." });
      }
      const staffId = String(body.staffId || "").trim();
      if (!staffId) return res.status(400).json({ error: "Choose a staff member to resolve this enquiry." });
      const organizationId = org(req);
      const pendingCall = await repository.getInboundCall(req.params.id, organizationId);
      if (!pendingCall || !await assertInboundVisible(req, req.params.id, res)) return;
      const analysis = pendingCall.enquiryAnalysis || {};
      const requestedStart = new Date(analysis.requestedStartAt || "");
      const requestedEnd = new Date(analysis.requestedEndAt || "");
      const canSchedule = Boolean(analysis.activityId && Number.isFinite(requestedStart.getTime())
        && (Number.isFinite(requestedEnd.getTime()) || Number(analysis.durationMinutes) > 0));
      if (canSchedule) {
        const staff = await repository.getActiveStaffDirectoryRecord(organizationId, staffId);
        if (!staff) return res.status(400).json({ error: "Selected staff member is not active in this organization." });
        if (!staff.phoneNumber) return res.status(400).json({ error: "Selected staff member has no registered phone number." });
        const agents = await repository.listAgents(organizationId);
        const attendanceAgent = agents.find((item) => item.active && String(item.language).toLowerCase().startsWith(String(staff.language || pendingCall.language).slice(0, 2).toLowerCase()))
          || agents.find((item) => item.active);
        if (!attendanceAgent) return res.status(409).json({ error: "Configure an active attendance voice agent before assigning this enquiry." });
        const settings = await repository.getOrganizationCallSettings(organizationId);
        const fromNumber = settings.defaultFromNumber || process.env.VOBIZ_FROM_NUMBER;
        if (!fromNumber) return res.status(409).json({ error: "Configure the default Vobiz caller ID in Settings before assigning this enquiry." });
        const session = await repository.saveAppointmentAttendanceSchedule({
          inboundCallId: req.params.id, organizationId, staff, attendanceAgent, fromNumber,
        });
        await queue.enqueue("place_call", { sessionId: session.id, taskId: session.checkInTask?.id, stage: "check_in", attemptNumber: 1 }, {
          idempotencyKey: `call:${session.id}:check_in:1`, runAt: new Date(session.scheduledStartAt),
        });
        await queue.enqueue("place_call", { sessionId: session.id, taskId: session.checkOutTask?.id, stage: "check_out", attemptNumber: 1 }, {
          idempotencyKey: `call:${session.id}:check_out:1`, runAt: new Date(session.scheduledEndAt),
        });
        const updated = await repository.getInboundCall(req.params.id, organizationId);
        return res.json({ id: updated.id, enquiryStatus: updated.enquiryStatus, resolvedStaff: updated.resolvedStaff,
          resolvedAt: updated.resolvedAt, bookingStatus: updated.bookingStatus, bookingScheduleSessionId: session.id });
      }
      const call = await repository.resolveInboundEnquiry(req.params.id, org(req), staffId);
      if (!call) return res.status(404).json({ error: "Incoming call not found" });
      res.json({ id: call.id, enquiryStatus: call.enquiryStatus, resolvedStaff: call.resolvedStaff, resolvedAt: call.resolvedAt });
    } catch (error) { fail(res, error); }
  });

  router.get("/incoming-calls/:id/recording", async (req, res) => {
    try {
      const call = await repository.getInboundCall(req.params.id, org(req));
      if (!call || !await assertInboundVisible(req, req.params.id, res)) return;
      if (!call.recordingObjectKey) return res.status(404).json({ error: "Recording not found" });
      const audio = await recordings.getObjectBuffer(call.recordingObjectKey);
      res.set("Content-Type", call.recordingContentType || "audio/wav");
      res.set("Content-Disposition", `inline; filename="${call.id}.wav"`);
      res.set("Cache-Control", "private, no-store");
      res.send(audio);
    } catch (error) { fail(res, error); }
  });

  router.get("/incoming-calls/:id/appointment-attempts/:attemptId/recording", async (req, res) => {
    try {
      const call = await repository.getInboundCall(req.params.id, org(req));
      const attempt = await repository.getAppointmentCallAttempt(req.params.attemptId);
      if (!call || !await assertInboundVisible(req, req.params.id, res) || !attempt || attempt.inboundCallId !== call.id || attempt.organizationId !== org(req) || !attempt.recordingObjectKey) {
        return res.status(404).json({ error: "Appointment call recording not found" });
      }
      const audio = await recordings.getObjectBuffer(attempt.recordingObjectKey);
      res.set("Content-Type", attempt.recordingContentType || "audio/wav");
      res.set("Content-Disposition", `inline; filename="appointment-${attempt.id}.wav"`);
      res.set("Cache-Control", "private, no-store");
      res.send(audio);
    } catch (error) { fail(res, error); }
  });

  router.get("/settings/calling", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try { res.set("Cache-Control", "private, no-store").json(await getEffectiveCallingSettings(org(req))); }
    catch (error) { fail(res, error); }
  });

  router.put("/settings/calling", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const organizationId = org(req);
      const body = req.body || {};
      const defaultFromNumber = body.defaultFromNumber == null || body.defaultFromNumber === "" ? null : String(body.defaultFromNumber).trim();
      if (defaultFromNumber && !/^\+[1-9]\d{7,14}$/.test(defaultFromNumber)) {
        return res.status(400).json({ error: "Default caller ID must be in E.164 format, for example +918071580130" });
      }
      const retry = body.retry;
      if (!retry || typeof retry !== "object") return res.status(400).json({ error: "retry settings are required" });
      if (body.allowNonPatientInboundCalls !== undefined && typeof body.allowNonPatientInboundCalls !== "boolean") {
        return res.status(400).json({ error: "allowNonPatientInboundCalls must be a boolean" });
      }
      if (body.allowInboundCalls !== undefined && typeof body.allowInboundCalls !== "boolean") {
        return res.status(400).json({ error: "allowInboundCalls must be a boolean" });
      }
      if (body.requireHumanVerificationForStaffBooking !== undefined && typeof body.requireHumanVerificationForStaffBooking !== "boolean") {
        return res.status(400).json({ error: "requireHumanVerificationForStaffBooking must be a boolean" });
      }
      if (body.unansweredCallEscalation !== undefined && !["platform_notification", "call_care_manager"].includes(body.unansweredCallEscalation)) {
        return res.status(400).json({ error: "unansweredCallEscalation must be platform_notification or call_care_manager" });
      }
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
      const existingSettings = await repository.getOrganizationCallSettings(organizationId);
      await repository.saveOrganizationCallSettings(organizationId, {
        defaultFromNumber,
        callRetry: { maxConsecutiveNoAnswer, initialMinutes, multiplier, maxMinutes },
        allowInboundCalls: body.allowInboundCalls ?? existingSettings.allowInboundCalls ?? true,
        allowNonPatientInboundCalls: body.allowNonPatientInboundCalls ?? existingSettings.allowNonPatientInboundCalls ?? false,
        requireHumanVerificationForStaffBooking: body.requireHumanVerificationForStaffBooking ?? existingSettings.requireHumanVerificationForStaffBooking ?? false,
        unansweredCallEscalation: body.unansweredCallEscalation ?? existingSettings.unansweredCallEscalation ?? "platform_notification",
      });
      res.json(await getEffectiveCallingSettings(organizationId));
    } catch (error) { fail(res, error); }
  });

  router.post("/settings/calling/reset", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const organizationId = org(req);
      await repository.saveOrganizationCallSettings(organizationId, { defaultFromNumber: null, callRetry: null, allowInboundCalls: true, allowNonPatientInboundCalls: false, requireHumanVerificationForStaffBooking: false, unansweredCallEscalation: "platform_notification" });
      res.json(await getEffectiveCallingSettings(organizationId));
    } catch (error) { fail(res, error); }
  });

  router.post("/assignments", async (req, res) => {
    try {
      const organizationId = org(req);
      const body = req.body || {};
      const required = ["assignmentId", "agentId", "language", "scheduledStartAt", "scheduledEndAt"];
      const missing = required.filter((key) => !body[key]);
      const callingSettings = await getEffectiveCallingSettings(organizationId);
      const fromNumber = body.fromNumber || callingSettings.defaultFromNumber;
      const employeeCompanyName = String(body.employee?.companyName || "").trim() || "ATHULYA";
      if (employeeCompanyName.length > 200) {
        return res.status(400).json({ error: "Employee company name must be at most 200 characters." });
      }
      const employeePhone = normalizeIndianMobile(body.employee?.phoneNumber);
      const patientPhoneInput = String(body.patient?.phoneNumber || "").trim();
      const patientPhone = patientPhoneInput ? normalizeIndianMobile(patientPhoneInput) : "";
      if (missing.length || !fromNumber || !body.employee?.id || !body.employee?.name || !body.patient?.id || !body.patient?.name || !body.patient?.address) {
        return res.status(400).json({ error: "Assignment requires assignmentId, agentId, language, scheduledStartAt, scheduledEndAt, employee identity, patient identity and address, and either fromNumber or the default caller ID in Settings/.env" });
      }
      if (!employeePhone) return res.status(400).json({ error: "Enter a valid 10-digit Indian employee mobile number, optionally prefixed with 91 or +91." });
      if (patientPhoneInput && !patientPhone) return res.status(400).json({ error: "Enter a valid 10-digit Indian patient mobile number, optionally prefixed with 91 or +91." });
      const startAt = new Date(body.scheduledStartAt);
      const endAt = new Date(body.scheduledEndAt);
      if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || endAt <= startAt) {
        return res.status(400).json({ error: "scheduledStartAt and scheduledEndAt must be valid, ordered timestamps" });
      }
      const agent = await repository.getAgent(organizationId, body.agentId);
      if (!agent?.active) return res.status(400).json({ error: "An active agent in this organization is required" });
      const session = await queue.transaction(async (client) => {
        await repository.assertEmployeeScheduleAvailable({
          organizationId,
          assignmentId: body.assignmentId,
          employee: { id: body.employee.id },
          scheduledStartAt: startAt,
          scheduledEndAt: endAt,
        }, client);
        await repository.createStaffDirectoryRecord(organizationId, {
          id: body.employee.id, name: body.employee.name, companyName: employeeCompanyName, phoneNumber: employeePhone,
          address: String(body.employee.address || "").trim(), language: body.language,
        }, client);
        await repository.createPatientDirectoryRecord(organizationId, {
          id: body.patient.id, name: body.patient.name, phoneNumber: patientPhone || undefined,
          address: String(body.patient.address || "").trim(), language: body.language,
          careCategory: body.metadata?.careCategory, hub: body.metadata?.hub,
        }, client);
        const created = await repository.createAttendanceSession({
          organizationId, assignmentId: body.assignmentId, scheduleVersion: body.scheduleVersion || "1",
          agentId: body.agentId, fromNumber, language: body.language,
          employee: { ...body.employee, companyName: employeeCompanyName, phoneNumber: employeePhone },
          patient: { ...body.patient, phoneNumber: patientPhone || undefined }, scheduledStartAt: startAt,
          scheduledEndAt: endAt, metadata: body.metadata || {},
        }, client);
        await queue.enqueue("place_call", { sessionId: created.id, taskId: created.checkInTask?.id, stage: "check_in", attemptNumber: 1 }, {
          idempotencyKey: `call:${created.id}:check_in:1`, runAt: created.scheduledStartAt, client,
        });
        await queue.enqueue("place_call", { sessionId: created.id, taskId: created.checkOutTask?.id, stage: "check_out", attemptNumber: 1 }, {
          idempotencyKey: `call:${created.id}:check_out:1`, runAt: created.scheduledEndAt, client,
        });
        return created;
      });
      res.status(202).json({
        sessionId: session.id,
        status: session.sessionStatus,
        tasks: {
          checkIn: { taskId: session.checkInTask?.id || null, scheduledAt: session.checkInTask?.scheduledAt || session.scheduledStartAt },
          checkOut: { taskId: session.checkOutTask?.id || null, scheduledAt: session.checkOutTask?.scheduledAt || session.scheduledEndAt },
        },
        queued: ["check_in", "check_out"],
      });
    } catch (error) { fail(res, error); }
  });

  router.get("/assignments/:id/status", async (req, res) => {
    try {
      const organizationId = org(req);
      const session = await repository.getAttendanceSession(req.params.id);
      if (!session || session.organizationId !== organizationId || !await assertSessionVisible(req, req.params.id, res)) return;
      const context = session.activeContext || {};
      res.json({
        sessionId: session.id,
        assignmentId: session.assignmentId,
        sessionStatus: session.sessionStatus,
        timeZone: session.metadata?.timeZone || process.env.APP_TIMEZONE || "Asia/Kolkata",
        checkIn: {
          taskId: session.checkInTask?.id || null,
          deliveryStatus: session.checkInTask?.deliveryStatus || "pending",
          status: session.checkInStatus,
          flag: session.checkInStatus === "not_answered" ? "not_answered" : null,
          reportedAt: context.checkIn?.reportedAt || null,
          scheduledAt: session.scheduledStartAt,
          nextCallAt: context.checkIn?.nextCallAt || null,
        },
        checkOut: {
          taskId: session.checkOutTask?.id || null,
          deliveryStatus: session.checkOutTask?.deliveryStatus || "pending",
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
      if (!artifacts || artifacts.session.organizationId !== org(req) || !await assertSessionVisible(req, req.params.id, res)) return;
      const baseUrl = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
      res.set("Cache-Control", "private, no-store");
      res.json({
        session: artifacts.session,
        tasks: artifacts.tasks,
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

  router.get("/attendance-tasks/:id", async (req, res) => {
    try {
      const task = await repository.getAttendanceStageTask(req.params.id);
      if (!task || task.organizationId !== org(req)) return res.status(404).json({ error: "Attendance task not found" });
      if (!await assertSessionVisible(req, task.assignmentSessionId, res)) return;
      res.set("Cache-Control", "private, no-store");
      res.json(task);
    } catch (error) { fail(res, error); }
  });

  router.get("/assignments/:id/recordings/:attemptId", async (req, res) => {
    try {
      const session = await repository.getAttendanceSession(req.params.id);
      if (!session || session.organizationId !== org(req) || !await assertSessionVisible(req, req.params.id, res)) return;
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
    if (!requireAdmin(req, res)) return;
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
    if (!requireAdmin(req, res)) return;
    try {
      const agent = await repository.updateAgent(org(req), req.params.id, req.body || {});
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      res.json(agent);
    } catch (error) { fail(res, error); }
  });

  router.delete("/agents/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const removed = await repository.deleteAgent(org(req), req.params.id);
      if (!removed) return res.status(404).json({ error: "Agent not found" });
      res.json({ success: true });
    } catch (error) { fail(res, error); }
  });

  router.get("/campaigns", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try { res.json(await repository.listCampaigns(org(req))); } catch (error) { fail(res, error); }
  });

  router.post("/campaigns", async (req, res) => {
    if (!requireAdmin(req, res)) return;
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
    if (!requireAdmin(req, res)) return;
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
        endedAt: req.body?.EndTime || null,
        rawEvent: req.body || {},
      });
      const status = String(req.body?.CallStatus || req.body?.status || "").toLowerCase().replace(/[\s_-]+/g, "");
      const terminal = Boolean(req.body?.EndTime || ["completed", "noanswer", "busy", "failed", "timeout", "canceled", "cancelled"].includes(status));
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
      if (result?.appointmentCall && terminal && ["noanswer", "busy", "failed", "timeout", "canceled", "cancelled"].includes(status)) {
        await queue.enqueue("process_appointment_call", { appointmentCallId: result.id }, { idempotencyKey: `appointment-result:${result.id}` });
      }
      res.status(result ? 200 : 404).json({ received: Boolean(result) });
    } catch (error) { fail(res, error); }
  });

  return router;
}

module.exports = { createCallServiceRouter };
