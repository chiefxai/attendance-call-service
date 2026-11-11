"use strict";

const crypto = require("node:crypto");

const { createVobizClient } = require("../infrastructure/telephony/vobiz-client");
const { normalizeIndianMobile } = require("../domain/attendance/phone-number");
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
    if (req.method === "POST" && ["/answer", "/incoming/answer", "/webhooks/call-status"].includes(req.path)) return next();

    try {
      const cookieHeader = String(req.headers.cookie || "");
      const cookiePair = cookieHeader.split(";").map((item) => item.trim()).find((item) => item.startsWith("attendance_session="));
      const sessionToken = cookiePair ? decodeURIComponent(cookiePair.slice("attendance_session=".length)) : "";
      if (sessionToken) {
        const user = await repository.resolveWebSession(crypto.createHash("sha256").update(sessionToken).digest("hex"));
        if (user) {
          req.orgId = user.organizationId;
          req.webUser = { id: user.id, email: user.email, displayName: user.displayName };
          return next();
        }
      }

      if (req.path === "/api-keys" || req.path.startsWith("/api-keys/")) {
        if (!process.env.API_KEY_ADMIN_TOKEN) return res.status(503).json({ error: "API_KEY_ADMIN_TOKEN is not configured" });
        if (!validateAdminToken(req)) return res.status(401).json({ error: "A web session or valid X-API-Admin-Token is required" });
        req.orgId = process.env.DEFAULT_ORGANIZATION_ID;
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
      allowNonPatientInboundCalls: stored.allowNonPatientInboundCalls ?? false,
      requireHumanVerificationForStaffBooking: stored.requireHumanVerificationForStaffBooking ?? false,
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
    const companyName = String(req.body?.companyName || "").trim();
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
    const companyName = String(req.body?.companyName || "").trim();
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
    try { res.json(await repository.listStaffDirectory(org(req), { search: req.query.search || "", status: req.query.status || "all", limit: req.query.limit || 100 })); }
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
      const calls = await repository.listInboundCalls(org(req), req.query.limit || 100);
      res.json(await Promise.all(calls.map(async (call) => serializeIncomingCall(
        call, await repository.listAppointmentCallAttempts(call.id, org(req)),
      ))));
    } catch (error) { fail(res, error); }
  });

  router.get("/incoming-calls/:id", async (req, res) => {
    try {
      const call = await repository.getInboundCall(req.params.id, org(req));
      if (!call) return res.status(404).json({ error: "Incoming call not found" });
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
      if (!pendingCall) return res.status(404).json({ error: "Incoming call not found" });
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
        await queue.enqueue("place_call", { sessionId: session.id, stage: "check_in", attemptNumber: 1 }, {
          idempotencyKey: `call:${session.id}:check_in:1`, runAt: new Date(session.scheduledStartAt),
        });
        await queue.enqueue("place_call", { sessionId: session.id, stage: "check_out", attemptNumber: 1 }, {
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
      if (!call?.recordingObjectKey) return res.status(404).json({ error: "Recording not found" });
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
      if (!call || !attempt || attempt.inboundCallId !== call.id || attempt.organizationId !== org(req) || !attempt.recordingObjectKey) {
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
    try { res.set("Cache-Control", "private, no-store").json(await getEffectiveCallingSettings(org(req))); }
    catch (error) { fail(res, error); }
  });

  router.put("/settings/calling", async (req, res) => {
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
      if (body.requireHumanVerificationForStaffBooking !== undefined && typeof body.requireHumanVerificationForStaffBooking !== "boolean") {
        return res.status(400).json({ error: "requireHumanVerificationForStaffBooking must be a boolean" });
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
        allowNonPatientInboundCalls: body.allowNonPatientInboundCalls ?? existingSettings.allowNonPatientInboundCalls ?? false,
        requireHumanVerificationForStaffBooking: body.requireHumanVerificationForStaffBooking ?? existingSettings.requireHumanVerificationForStaffBooking ?? false,
      });
      res.json(await getEffectiveCallingSettings(organizationId));
    } catch (error) { fail(res, error); }
  });

  router.post("/settings/calling/reset", async (req, res) => {
    try {
      const organizationId = org(req);
      await repository.saveOrganizationCallSettings(organizationId, { defaultFromNumber: null, callRetry: null, allowNonPatientInboundCalls: false, requireHumanVerificationForStaffBooking: false });
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
      if (String(body.employee?.companyName || "").trim().length > 200) {
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
          id: body.employee.id, name: body.employee.name, companyName: body.employee.companyName || "", phoneNumber: employeePhone,
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
          employee: { ...body.employee, companyName: String(body.employee.companyName || "").trim(), phoneNumber: employeePhone },
          patient: { ...body.patient, phoneNumber: patientPhone || undefined }, scheduledStartAt: startAt,
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
        timeZone: session.metadata?.timeZone || process.env.APP_TIMEZONE || "Asia/Kolkata",
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
