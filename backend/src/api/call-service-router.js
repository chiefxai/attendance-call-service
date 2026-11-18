"use strict";

const crypto = require("node:crypto");

const { normalizeIndianMobile } = require("../domain/attendance/phone-number");
const { assertRepository } = require("../domain/repository-contract");
const { DEFAULT_BASE_URL, encryptSecret, decryptSecret, validateBaseUrl, fetchAthulyaSchedules, resolveAthulyaConnection, localDateInTimeZone } = require("../infrastructure/integrations/athulya-platform");
const { verifyChiefVoiceSignature, normalizeChiefVoiceWebhook, normalizeChiefVoiceFailureWebhook } = require("../infrastructure/integrations/chiefvoice-webhook");
const { processChiefVoiceResult, processChiefVoiceFailure } = require("../domain/attendance/chiefvoice-result");

function createCallServiceRouter({ express, repository, queue, recordings }) {
  if (!express?.Router) throw new Error("An Express-compatible module is required");
  assertRepository(repository);
  if (!queue?.enqueue || !queue?.transaction) throw new Error("A transactional durable job queue is required");

  const router = express.Router();
  router.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
  router.use(express.urlencoded({ extended: false }));
  const validateAdminToken = (req) => {
    const expected = Buffer.from(process.env.API_KEY_ADMIN_TOKEN || "");
    const supplied = Buffer.from(String(req.get("x-api-admin-token") || ""));
    return expected.length > 0 && expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
  };
  router.use(async (req, res, next) => {
    if (req.method === "POST" && req.path === "/webhooks/chiefvoice") return next();
    if (req.path === "/test-platform" || req.path.startsWith("/test-platform/")) {
      if (!process.env.DEFAULT_ORGANIZATION_ID) return res.status(503).json({ error: "Default organization is not configured" });
      req.orgId = process.env.DEFAULT_ORGANIZATION_ID;
      return next();
    }

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
  const fail = (res, error) => res.status(error.status || 500).json({ error: error.message || "Request failed" });
  const envNumber = (name, fallback) => process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : fallback;
  const getEffectiveCallingSettings = async (organizationId) => {
    const stored = await repository.getOrganizationCallSettings(organizationId);
    const storedRetry = stored.callRetry || {};
    const configuredGrace = envNumber("ATHULYA_LATE_SCHEDULE_GRACE_MINUTES", 2);
    const environmentGrace = Number.isInteger(configuredGrace) && configuredGrace >= 0 && configuredGrace <= 30 ? configuredGrace : 2;
    return {
      defaultFromNumber: stored.defaultFromNumber ?? process.env.CHIEFVOICE_CALLER_ID ?? "",
      unansweredCallEscalation: stored.unansweredCallEscalation ?? "call_care_manager",
      lateScheduleGraceMinutes: stored.lateScheduleGraceMinutes ?? environmentGrace,
      retry: {
        maxConsecutiveNoAnswer: storedRetry.maxConsecutiveNoAnswer ?? envNumber("CALL_MAX_CONSECUTIVE_NO_ANSWER", 3),
        initialMinutes: storedRetry.initialMinutes ?? envNumber("CALL_RETRY_INITIAL_MINUTES", 3),
        multiplier: storedRetry.multiplier ?? envNumber("CALL_RETRY_MULTIPLIER", 1.2),
        maxMinutes: storedRetry.maxMinutes ?? envNumber("CALL_RETRY_MAX_MINUTES", 30),
      },
      source: {
        defaultFromNumber: stored.defaultFromNumber ? "settings" : "environment",
        lateScheduleGraceMinutes: stored.lateScheduleGraceMinutes != null ? "settings" : "environment",
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

  router.get("/settings/mock-platform-server", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const setting = await repository.getMockPlatformServerSettings(org(req));
      res.json({ enabled: setting.enabled, configured: Boolean(process.env.ATHULYA_MOCK_API_KEY && process.env.MOCK_PLATFORM_UPSTREAM_URL), activeMode: setting.enabled ? "mock" : "live" });
    } catch (error) { fail(res, error); }
  });

  router.put("/settings/mock-platform-server", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "enabled must be a boolean" });
      const configured = Boolean(process.env.ATHULYA_MOCK_API_KEY && process.env.MOCK_PLATFORM_UPSTREAM_URL);
      if (req.body.enabled && !configured) return res.status(400).json({ error: "Configure the mock platform API key and upstream URL on the server before enabling it." });
      const setting = await repository.setMockPlatformServerEnabled(org(req), req.body.enabled, req.webUser?.id || null);
      res.json({ enabled: setting.enabled, configured, activeMode: setting.enabled ? "mock" : "live" });
    } catch (error) { fail(res, error); }
  });

  router.use("/test-platform", async (req, res) => {
    try {
      const setting = await repository.getMockPlatformServerSettings(org(req));
      if (!setting.enabled) return res.status(404).json({ error: "Test platform API is disabled" });
      const expected = Buffer.from(String(process.env.ATHULYA_MOCK_API_KEY || ""));
      const authorization = String(req.get("authorization") || "");
      const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] || "";
      const supplied = Buffer.from(String(req.get("x-api-key") || bearer));
      if (!expected.length || expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
        return res.status(expected.length ? 401 : 503).json({ error: expected.length ? "Invalid test platform key" : "Test platform key is not configured" });
      }
      const relative = new URL(req.originalUrl, "http://service").pathname.split("/test-platform").pop() || "/";
      const routeMap = {
        "GET /caremanager/clients": "/api/caremanager/clients",
        "POST /check-in-out": "/api/check-in-out",
        "GET /submissions": "/mock/submissions",
        "DELETE /submissions": "/mock/submissions",
      };
      const upstreamPath = routeMap[`${req.method} ${relative}`];
      if (!upstreamPath) return res.status(404).json({ error: "Test platform route not found" });
      const query = new URL(req.originalUrl, "http://service").searchParams;
      query.delete("api_key");
      const upstreamUrl = `${process.env.MOCK_PLATFORM_UPSTREAM_URL}${upstreamPath}${query.size ? `?${query}` : ""}`;
      const headers = { "x-api-key": process.env.ATHULYA_MOCK_API_KEY, accept: "application/json" };
      const idempotencyKey = req.get("idempotency-key");
      if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
      const options = { method: req.method, headers, signal: AbortSignal.timeout(10000) };
      if (req.method === "POST") { headers["content-type"] = "application/json"; options.body = JSON.stringify(req.body || {}); }
      const upstream = await fetch(upstreamUrl, options);
      const responseText = await upstream.text();
      res.status(upstream.status).set("Content-Type", upstream.headers.get("content-type") || "application/json").set("Cache-Control", "no-store").send(responseText);
    } catch (error) { fail(res, error); }
  });

  const proxyMockScheduleRequest = async (req, res, method, scheduleId = null) => {
    if (!requireAdmin(req, res)) return;
    try {
      const setting = await repository.getMockPlatformServerSettings(org(req));
      if (!setting.enabled) return res.status(409).json({ error: "Enable the mock test server before managing mock schedules." });
      const key = String(process.env.ATHULYA_MOCK_API_KEY || "");
      const base = String(process.env.MOCK_PLATFORM_UPSTREAM_URL || "");
      if (!key || !base) return res.status(503).json({ error: "Mock server credentials or upstream URL are not configured." });
      const suffix = scheduleId ? `/${encodeURIComponent(scheduleId)}` : "";
      const upstream = await fetch(`${base}/mock/schedules${suffix}`, {
        method,
        headers: { "x-api-key": key, accept: "application/json", ...(method !== "GET" && method !== "DELETE" ? { "content-type": "application/json" } : {}) },
        ...(method !== "GET" && method !== "DELETE" ? { body: JSON.stringify(req.body || {}) } : {}),
        signal: AbortSignal.timeout(10000),
      });
      const responseText = await upstream.text();
      res.status(upstream.status).set("Content-Type", upstream.headers.get("content-type") || "application/json").set("Cache-Control", "no-store").send(responseText);
    } catch (error) { fail(res, error); }
  };
  router.get("/mock-schedules", (req, res) => proxyMockScheduleRequest(req, res, "GET"));
  router.post("/mock-schedules", (req, res) => proxyMockScheduleRequest(req, res, "POST"));
  router.put("/mock-schedules/:id", (req, res) => proxyMockScheduleRequest(req, res, "PUT", req.params.id));
  router.delete("/mock-schedules/:id", (req, res) => proxyMockScheduleRequest(req, res, "DELETE", req.params.id));

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
        attendanceSubmissionStatus: value.enabled && value.encryptedApiKey ? "ready" : "not_configured" });
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
      const mockSetting = await repository.getMockPlatformServerSettings(org(req));
      const autoSyncScope = String(body.autoSyncScope || "all");
      const autoSyncScopeId = String(body.autoSyncScopeId || "").trim();
      if (!["all", "branch", "care_manager"].includes(autoSyncScope)) return res.status(400).json({ error: "autoSyncScope must be all, branch, or care_manager." });
      if (autoSyncScopeId.length > 100) return res.status(400).json({ error: "autoSyncScopeId must be at most 100 characters." });
      const old = await repository.getAthulyaIntegration(org(req));
      const apiKeyInput = String(body.apiKey || "").trim();
      const encryptedApiKey = apiKeyInput ? encryptSecret(apiKeyInput) : null;
      if (enabled && !(encryptedApiKey || old.encryptedApiKey)) return res.status(400).json({ error: "Enter the Athulya API key before enabling the integration." });
      if (autoSyncEnabled && !enabled && !mockSetting.enabled) return res.status(400).json({ error: "Enable the live Athulya integration or the mock test server before enabling automatic sync." });
      if (autoSyncEnabled && autoSyncScope !== "all" && !autoSyncScopeId) return res.status(400).json({ error: "Enter the branch or Care Manager ID for the selected automatic sync scope." });
      const saved = await repository.saveAthulyaIntegration(org(req), { integrationName, apiBaseUrl, encryptedApiKey, enabled, autoSyncEnabled, autoSyncScope, autoSyncScopeId, updatedBy: req.webUser?.id });
      res.json({ integrationName: saved.integrationName, apiBaseUrl: saved.apiBaseUrl, enabled: saved.enabled,
        autoSyncEnabled: saved.autoSyncEnabled === true, autoSyncEnabledAt: saved.autoSyncEnabledAt || null,
        lastAutoSyncSlot: saved.lastAutoSyncSlot || null, autoSyncTimeZone: process.env.APP_TIMEZONE || "Asia/Kolkata",
        autoSyncScope: saved.autoSyncScope || "all", autoSyncScopeId: saved.autoSyncScopeId || "",
        keyConfigured: Boolean(saved.encryptedApiKey), apiKeyMasked: saved.encryptedApiKey ? "••••••••" : "", updatedAt: saved.updatedAt,
        lastSuccessfulScheduleSync: saved.lastSuccessfulScheduleSync || null,
        lastSuccessfulAttendanceSubmission: saved.lastSuccessfulAttendanceSubmission || null,
        attendanceSubmissionStatus: saved.enabled && saved.encryptedApiKey ? "ready" : "not_configured" });
    } catch (error) { fail(res, error); }
  });

  router.post("/integrations/athulya/test", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const mockSetting = await repository.getMockPlatformServerSettings(org(req));
      const settings = await repository.getAthulyaIntegration(org(req));
      const connection = mockSetting.enabled
        ? await resolveAthulyaConnection(repository, org(req))
        : {
          apiBaseUrl: validateBaseUrl(req.body?.apiBaseUrl || settings.apiBaseUrl),
          apiKey: String(req.body?.apiKey || "").trim() || decryptSecret(settings.encryptedApiKey),
        };
      const { apiBaseUrl, apiKey } = connection;
      const scheduleDate = localDateInTimeZone(new Date(), process.env.APP_TIMEZONE || "Asia/Kolkata");
      const records = await fetchAthulyaSchedules({ apiBaseUrl, apiKey, filters: { from_date: scheduleDate, to_date: scheduleDate } });
      res.json({ connected: true, scheduleDate, recordsReceived: records.length });
    } catch (error) { res.status(502).json({ connected: false, error: error.message }); }
  });

  router.post("/integrations/athulya/sync", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const mockSetting = await repository.getMockPlatformServerSettings(org(req));
      const settings = await repository.getAthulyaIntegration(org(req));
      if (!settings.enabled && !mockSetting.enabled) return res.status(409).json({ error: "Enable either the live Athulya integration or the mock test server before synchronising." });
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


  router.get("/scheduled-calls", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const timeZone = process.env.APP_TIMEZONE || "Asia/Kolkata";
      const date = String(req.query.date || localDateInTimeZone(new Date(), timeZone)).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date + "T00:00:00.000Z").toISOString().slice(0,10) !== date) {
        return res.status(400).json({ error: "date must be a valid YYYY-MM-DD calendar date." });
      }
      const items = await repository.listScheduledAthulyaCallItems(org(req), { date, timeZone });
      res.set("Cache-Control", "private, no-store").json({ date, timeZone, items });
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
      if (body.unansweredCallEscalation !== undefined && !["platform_notification", "call_care_manager"].includes(body.unansweredCallEscalation)) {
        return res.status(400).json({ error: "unansweredCallEscalation must be platform_notification or call_care_manager" });
      }
      const lateScheduleGraceMinutes = Number(body.lateScheduleGraceMinutes);
      if (!Number.isInteger(lateScheduleGraceMinutes) || lateScheduleGraceMinutes < 0 || lateScheduleGraceMinutes > 30) {
        return res.status(400).json({ error: "lateScheduleGraceMinutes must be an integer from 0 to 30" });
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
        lateScheduleGraceMinutes,
        callRetry: { maxConsecutiveNoAnswer, initialMinutes, multiplier, maxMinutes },
        unansweredCallEscalation: body.unansweredCallEscalation ?? existingSettings.unansweredCallEscalation ?? "call_care_manager",
      });
      res.json(await getEffectiveCallingSettings(organizationId));
    } catch (error) { fail(res, error); }
  });

  router.post("/settings/calling/reset", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const organizationId = org(req);
      await repository.saveOrganizationCallSettings(organizationId, { defaultFromNumber: null, lateScheduleGraceMinutes: null, callRetry: null, unansweredCallEscalation: "call_care_manager" });
      res.json(await getEffectiveCallingSettings(organizationId));
    } catch (error) { fail(res, error); }
  });

  router.post("/assignments", async (req, res) => {
    try {
      const organizationId = org(req);
      const body = req.body || {};
      const required = ["assignmentId", "language", "scheduledStartAt", "scheduledEndAt"];
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
        return res.status(400).json({ error: "Assignment requires assignmentId, language, scheduledStartAt, scheduledEndAt, employee identity, patient identity and address, and either fromNumber or the default ChiefVoice caller ID in Settings/.env" });
      }
      if (!employeePhone) return res.status(400).json({ error: "Enter a valid 10-digit Indian employee mobile number, optionally prefixed with 91 or +91." });
      if (patientPhoneInput && !patientPhone) return res.status(400).json({ error: "Enter a valid 10-digit Indian patient mobile number, optionally prefixed with 91 or +91." });
      const startAt = new Date(body.scheduledStartAt);
      const endAt = new Date(body.scheduledEndAt);
      if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || endAt <= startAt) {
        return res.status(400).json({ error: "scheduledStartAt and scheduledEndAt must be valid, ordered timestamps" });
      }
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
          callProvider: "chiefvoice", fromNumber, language: body.language,
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
      const [checkInNextAttemptNumber, checkOutNextAttemptNumber] = await Promise.all([
        repository.nextAttemptNumber(req.params.id, "check_in"),
        repository.nextAttemptNumber(req.params.id, "check_out"),
      ]);
      res.json({
        sessionId: session.id,
        assignmentId: session.assignmentId,
        sessionStatus: session.sessionStatus,
        timeZone: session.metadata?.timeZone || process.env.APP_TIMEZONE || "Asia/Kolkata",
        checkIn: {
          taskId: session.checkInTask?.id || null,
          deliveryStatus: session.checkInTask?.deliveryStatus || "pending",
          status: session.checkInStatus,
          flag: session.checkInStatus === "not_answered" || context.checkIn?.reason === "consecutive_no_answer_limit_reached" ? "not_answered" : null,
          reportedAt: context.checkIn?.reportedAt || null,
          scheduledAt: session.scheduledStartAt,
          nextCallAt: context.checkIn?.nextCallAt || null,
          nextCallReason: context.checkIn?.reason || null,
          nextAttemptNumber: checkInNextAttemptNumber,
        },
        checkOut: {
          taskId: session.checkOutTask?.id || null,
          deliveryStatus: session.checkOutTask?.deliveryStatus || "pending",
          status: session.checkOutStatus,
          flag: session.checkOutStatus === "not_answered" || context.checkOut?.reason === "consecutive_no_answer_limit_reached" ? "not_answered" : null,
          reportedAt: context.checkOut?.reportedAt || null,
          scheduledAt: session.scheduledEndAt,
          nextCallAt: context.checkOut?.nextCallAt || null,
          nextCallReason: context.checkOut?.reason || null,
          nextAttemptNumber: checkOutNextAttemptNumber,
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
          failure: attempt.failure,
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

  // ChiefVoice signs outcome and fallback failure events over timestamp.event_id.raw_body.
  router.post("/webhooks/chiefvoice", async (req, res) => {
    try {
      const secret = String(process.env.CHIEFVOICE_WEBHOOK_SECRET || "");
      const eventIdHeader = String(req.get("x-chiefvoice-event-id") || "");
      const eventTypeHeader = String(req.get("x-chiefvoice-event") || "");
      const timestamp = String(req.get("x-chiefvoice-timestamp") || "");
      const signature = String(req.get("x-chiefvoice-signature") || "");
      if (!verifyChiefVoiceSignature({
        secret, timestamp, eventId: eventIdHeader, signature, rawBody: req.rawBody,
      })) {
        return res.status(401).json({ error: "Invalid or expired ChiefVoice webhook signature" });
      }

      let event;
      try {
        const options = {
          headerEventId: eventIdHeader,
          headerEventType: eventTypeHeader,
        };
        event = ["call.failed", "call.post_call.failed"].includes(eventTypeHeader)
          ? normalizeChiefVoiceFailureWebhook(req.body, options)
          : normalizeChiefVoiceWebhook(req.body, options);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }

      const acceptance = event.failure
        ? await processChiefVoiceFailure({ event, repository, queue })
        : await processChiefVoiceResult({ event, repository, queue });
      return res.status(200).json({ received: true, ...(acceptance.duplicate ? { duplicate: true } : {}) });
    } catch (error) {
      if (error.status === 404) return res.status(404).json({ received: false });
      const safeCode = String(error.safeCode || error.code || "processing_failed").replace(/[^a-z0-9_-]/gi, "").slice(0, 40) || "processing_failed";
      console.error("[chiefvoice-webhook] delivery processing failed", { code: safeCode });
      return res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  return router;
}

module.exports = { createCallServiceRouter };
