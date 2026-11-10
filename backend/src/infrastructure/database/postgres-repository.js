"use strict";

function json(value) { return typeof value === "string" ? JSON.parse(value) : value; }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

class PostgresRepository {
  constructor(pool) {
    if (!pool?.query || !pool?.connect) throw new Error("A PostgreSQL pool is required");
    this.pool = pool;
  }

  async findWebUserByEmail(email) {
    const { rows } = await this.pool.query(
      `SELECT id,organization_id,email,display_name,password_salt,password_hash,active
       FROM web_users WHERE lower(email)=lower($1) LIMIT 1`,
      [email],
    );
    const row = rows[0];
    return row ? {
      id: row.id,
      organizationId: row.organization_id,
      email: row.email,
      displayName: row.display_name,
      passwordSalt: row.password_salt,
      passwordHash: row.password_hash,
      active: row.active,
    } : null;
  }

  async createWebUser({ organizationId, email, displayName, passwordSalt, passwordHash }) {
    const { rows } = await this.pool.query(
      `INSERT INTO web_users (organization_id,email,display_name,password_salt,password_hash)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id,organization_id,email,display_name,active,created_at`,
      [organizationId, email, displayName, passwordSalt, passwordHash],
    );
    return rows[0];
  }

  async createWebSession(userId, tokenHash, expiresAt) {
    await this.pool.query(
      `INSERT INTO web_sessions (user_id,token_hash,expires_at) VALUES ($1,$2,$3)`,
      [userId, tokenHash, expiresAt],
    );
  }

  async resolveWebSession(tokenHash) {
    const { rows } = await this.pool.query(
      `UPDATE web_sessions s SET last_used_at=NOW()
       FROM web_users u
       WHERE s.token_hash=$1 AND s.user_id=u.id AND s.revoked_at IS NULL
         AND s.expires_at>NOW() AND u.active=TRUE
       RETURNING u.id,u.organization_id,u.email,u.display_name`,
      [tokenHash],
    );
    const row = rows[0];
    return row ? { id: row.id, organizationId: row.organization_id, email: row.email, displayName: row.display_name } : null;
  }

  async revokeWebSession(tokenHash) {
    const { rowCount } = await this.pool.query(
      `UPDATE web_sessions SET revoked_at=NOW() WHERE token_hash=$1 AND revoked_at IS NULL`,
      [tokenHash],
    );
    return rowCount > 0;
  }

  async getOrganizationCallSettings(organizationId) {
    const { rows } = await this.pool.query(
      "SELECT settings FROM organization_call_settings WHERE organization_id=$1",
      [organizationId],
    );
    return rows[0] ? json(rows[0].settings) || {} : {};
  }

  async saveOrganizationCallSettings(organizationId, settings) {
    const { rows } = await this.pool.query(
      `INSERT INTO organization_call_settings (organization_id, settings)
       VALUES ($1,$2::jsonb)
       ON CONFLICT (organization_id) DO UPDATE SET settings=EXCLUDED.settings, updated_at=NOW()
       RETURNING settings`,
      [organizationId, JSON.stringify(settings || {})],
    );
    return json(rows[0].settings) || {};
  }

  async createApiKey(orgId, { label, prefix, hash }) {
    const { rows } = await this.pool.query(
      `INSERT INTO service_api_keys (organization_id,label,key_prefix,key_hash)
       VALUES ($1,$2,$3,$4) RETURNING id,organization_id,label,key_prefix,created_at,last_used_at,revoked_at`,
      [orgId, label, prefix, hash],
    );
    return this.mapApiKey(rows[0]);
  }

  async listApiKeys(orgId) {
    const { rows } = await this.pool.query(
      `SELECT id,organization_id,label,key_prefix,created_at,last_used_at,revoked_at
       FROM service_api_keys WHERE organization_id=$1 ORDER BY created_at DESC`,
      [orgId],
    );
    return rows.map((row) => this.mapApiKey(row));
  }

  async resolveApiKey(hash) {
    const { rows } = await this.pool.query(
      `UPDATE service_api_keys SET last_used_at=NOW()
       WHERE key_hash=$1 AND revoked_at IS NULL
       RETURNING organization_id`,
      [hash],
    );
    return rows[0]?.organization_id || null;
  }

  async revokeApiKey(orgId, id) {
    const { rowCount } = await this.pool.query(
      `UPDATE service_api_keys SET revoked_at=NOW()
       WHERE organization_id=$1 AND id=$2 AND revoked_at IS NULL`,
      [orgId, id],
    );
    return rowCount > 0;
  }

  mapApiKey(row) {
    return {
      id: row.id,
      organizationId: row.organization_id,
      label: row.label,
      prefix: row.key_prefix,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    };
  }

  async listAgents(orgId) {
    const r = await this.pool.query("SELECT * FROM call_agents WHERE organization_id=$1 ORDER BY name", [orgId]);
    return r.rows.map((row) => ({ ...row, ...json(row.config), systemPrompt: row.system_prompt, language: row.language }));
  }
  async getAgent(orgId, id) {
    const r = await this.pool.query("SELECT * FROM call_agents WHERE organization_id=$1 AND id=$2", [orgId, id]);
    const row = r.rows[0];
    return row ? { ...row, ...json(row.config), systemPrompt: row.system_prompt, language: row.language } : null;
  }
  async createAgent(orgId, agent) {
    const { rows } = await this.pool.query(
      `INSERT INTO call_agents (organization_id,name,active,language,system_prompt,config)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
      [orgId, agent.name, agent.active !== false, agent.language || "en", agent.systemPrompt || "", JSON.stringify(agent)],
    );
    return this.getAgent(orgId, rows[0].id);
  }
  async updateAgent(orgId, id, patch) {
    const current = await this.getAgent(orgId, id);
    if (!current) return null;
    const next = { ...current, ...patch };
    await this.pool.query(
      `UPDATE call_agents SET name=$3, active=$4, language=$5, system_prompt=$6, config=$7::jsonb, updated_at=NOW()
       WHERE organization_id=$1 AND id=$2`,
      [orgId, id, next.name, next.active !== false, next.language || "en", next.systemPrompt || "", JSON.stringify(next)],
    );
    return this.getAgent(orgId, id);
  }
  async deleteAgent(orgId, id) {
    const r = await this.pool.query("DELETE FROM call_agents WHERE organization_id=$1 AND id=$2 RETURNING id", [orgId, id]);
    return r.rowCount > 0;
  }

  async listCampaigns(orgId) {
    const r = await this.pool.query("SELECT * FROM call_campaigns WHERE organization_id=$1 ORDER BY created_at DESC", [orgId]);
    return r.rows.map((row) => ({ ...row, ...json(row.config) }));
  }
  async getCampaign(orgId, id) {
    const r = await this.pool.query("SELECT * FROM call_campaigns WHERE organization_id=$1 AND id=$2", [orgId, id]);
    return r.rows[0] ? { ...r.rows[0], ...json(r.rows[0].config) } : null;
  }
  async createCampaign(orgId, campaign) {
    const r = await this.pool.query(
      `INSERT INTO call_campaigns (organization_id,name,agent_id,from_number,status,config)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
      [orgId, campaign.name, campaign.agentId, campaign.fromNumber, campaign.status || "draft", JSON.stringify(campaign)],
    );
    return { ...r.rows[0], ...json(r.rows[0].config) };
  }
  async createCall(orgId, call) {
    const r = await this.pool.query(
      `INSERT INTO call_records (organization_id,provider,provider_call_id,agent_id,campaign_id,from_number,to_number,status,provider_response)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`,
      [orgId, call.provider, call.providerCallId, call.agentId, call.campaignId, call.from, call.to, call.status, JSON.stringify(call.providerResponse || {})],
    );
    return r.rows[0];
  }

  async createAttendanceSession(assignment, client = this.pool) {
    const r = await client.query(
      `INSERT INTO attendance_sessions
       (organization_id,external_assignment_id,schedule_version,agent_id,language,employee,patient,assignment_metadata,from_number,scheduled_start_at,scheduled_end_at,active_context)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12::jsonb)
       ON CONFLICT (organization_id,external_assignment_id,schedule_version) DO NOTHING
       RETURNING *`,
      [assignment.organizationId, assignment.assignmentId, String(assignment.scheduleVersion || "1"), assignment.agentId,
        assignment.language, JSON.stringify(assignment.employee), JSON.stringify(assignment.patient), JSON.stringify(assignment.metadata || {}),
        assignment.fromNumber, assignment.scheduledStartAt, assignment.scheduledEndAt,
        JSON.stringify({ assignmentId: assignment.assignmentId, language: assignment.language, stage: "check_in", factsConfirmed: {}, priorCallStatus: [] })],
    );
    let row = r.rows[0];
    if (!row) {
      const existing = await client.query(
        `SELECT * FROM attendance_sessions
         WHERE organization_id=$1 AND external_assignment_id=$2 AND schedule_version=$3
         FOR UPDATE`,
        [assignment.organizationId, assignment.assignmentId, String(assignment.scheduleVersion || "1")],
      );
      row = existing.rows[0];
      if (!row) throw new Error("Assignment session conflicted but could not be loaded");
      const same = row.agent_id === assignment.agentId
        && row.language === assignment.language
        && row.from_number === assignment.fromNumber
        && new Date(row.scheduled_start_at).getTime() === new Date(assignment.scheduledStartAt).getTime()
        && new Date(row.scheduled_end_at).getTime() === new Date(assignment.scheduledEndAt).getTime()
        && stableJson(json(row.employee)) === stableJson(assignment.employee)
        && stableJson(json(row.patient)) === stableJson(assignment.patient)
        && stableJson(json(row.assignment_metadata)) === stableJson(assignment.metadata || {});
      if (!same) {
        const error = new Error("This assignment already exists with different details. Increment scheduleVersion to create a revised session.");
        error.status = 409;
        throw error;
      }
    }
    return this.mapSession(row);
  }

  mapSession(row) {
    if (!row) return null;
    return {
      id: row.id, organizationId: row.organization_id, assignmentId: row.external_assignment_id,
      scheduleVersion: row.schedule_version, agentId: row.agent_id, language: row.language,
      employee: json(row.employee), patient: json(row.patient), metadata: json(row.assignment_metadata),
      fromNumber: row.from_number, scheduledStartAt: row.scheduled_start_at, scheduledEndAt: row.scheduled_end_at,
      checkInStatus: row.check_in_status, checkOutStatus: row.check_out_status, sessionStatus: row.session_status,
      activeContext: json(row.active_context), backendDeliveryStatus: row.backend_delivery_status,
    };
  }
  async getAttendanceSession(id) {
    const r = await this.pool.query("SELECT * FROM attendance_sessions WHERE id=$1", [id]);
    return this.mapSession(r.rows[0]);
  }
  maskPhone(value) {
    const phone = String(value || "");
    if (!phone) return null;
    const last = phone.replace(/\D/g, "").slice(-4);
    return last ? `•••• ${last}` : "••••";
  }
  mapAttendanceSummary(row) {
    const session = this.mapSession(row);
    const context = session.activeContext || {};
    const employee = session.employee || {};
    const patient = session.patient || {};
    return {
      sessionId: session.id,
      assignmentId: session.assignmentId,
      scheduleVersion: session.scheduleVersion,
      language: session.language,
      employee: { id: employee.id || null, name: employee.name || "Unknown staff", phoneMasked: this.maskPhone(employee.phoneNumber) },
      patient: { id: patient.id || null, name: patient.name || "Unknown patient" },
      scheduledStartAt: session.scheduledStartAt,
      scheduledEndAt: session.scheduledEndAt,
      checkIn: { status: session.checkInStatus, reportedAt: context.checkIn?.reportedAt || null, nextCallAt: context.checkIn?.nextCallAt || null },
      checkOut: { status: session.checkOutStatus, reportedAt: context.checkOut?.reportedAt || null, nextCallAt: context.checkOut?.nextCallAt || null },
      stageReasons: { checkIn: context.checkIn?.reason || null, checkOut: context.checkOut?.reason || null },
      sessionStatus: session.sessionStatus,
      backendDeliveryStatus: session.backendDeliveryStatus,
      callAttemptCount: Number(row.call_attempt_count || 0),
      metadata: session.metadata || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  async listAttendanceSessions(organizationId, { search = "", status = "all", limit = 100, offset = 0 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    const r = await this.pool.query(
      `SELECT s.*, COUNT(a.id)::int AS call_attempt_count
       FROM attendance_sessions s
       LEFT JOIN attendance_call_attempts a ON a.session_id=s.id
       WHERE s.organization_id=$1
         AND ($2='' OR s.id::text ILIKE '%'||$2||'%' OR s.external_assignment_id ILIKE '%'||$2||'%'
              OR COALESCE(s.employee->>'name','') ILIKE '%'||$2||'%' OR COALESCE(s.employee->>'id','') ILIKE '%'||$2||'%'
              OR COALESCE(s.patient->>'name','') ILIKE '%'||$2||'%' OR COALESCE(s.patient->>'id','') ILIKE '%'||$2||'%')
         AND ($3='all' OR s.check_in_status=$3 OR s.check_out_status=$3 OR s.session_status=$3)
       GROUP BY s.id ORDER BY s.scheduled_start_at DESC LIMIT $4 OFFSET $5`,
      [organizationId, String(search || "").trim(), status, safeLimit, safeOffset],
    );
    return r.rows.map((row) => this.mapAttendanceSummary(row));
  }
  async getOperationsSummary(organizationId) {
    const timezone = process.env.APP_TIMEZONE || "Asia/Kolkata";
    const [sessions, calls, jobs] = await Promise.all([
      this.pool.query(
        `WITH bounds AS (SELECT date_trunc('day', NOW() AT TIME ZONE $2) AT TIME ZONE $2 AS day_start)
         SELECT
           COUNT(*) FILTER (WHERE scheduled_start_at >= bounds.day_start AND scheduled_start_at < bounds.day_start + INTERVAL '1 day')::int AS scheduled_today,
           COUNT(*) FILTER (WHERE check_in_status='confirmed' AND scheduled_start_at >= bounds.day_start AND scheduled_start_at < bounds.day_start + INTERVAL '1 day')::int AS check_ins_confirmed,
           COUNT(*) FILTER (WHERE check_out_status='confirmed' AND scheduled_start_at >= bounds.day_start AND scheduled_start_at < bounds.day_start + INTERVAL '1 day')::int AS check_outs_confirmed,
           COUNT(*) FILTER (WHERE check_in_status IN ('scheduled','calling','processing','follow_up') AND scheduled_start_at >= bounds.day_start AND scheduled_start_at < bounds.day_start + INTERVAL '1 day')::int AS check_ins_pending,
           COUNT(*) FILTER (WHERE check_out_status IN ('scheduled','calling','processing','follow_up') AND scheduled_start_at >= bounds.day_start AND scheduled_start_at < bounds.day_start + INTERVAL '1 day')::int AS check_outs_pending,
           COUNT(*) FILTER (WHERE check_in_status IN ('not_answered','missed','review') OR check_out_status IN ('not_answered','missed','review'))::int AS exceptions
         FROM attendance_sessions CROSS JOIN bounds WHERE organization_id=$1`, [organizationId, timezone],
      ),
      this.pool.query(
        `WITH bounds AS (SELECT date_trunc('day', NOW() AT TIME ZONE $2) AT TIME ZONE $2 AS day_start)
         SELECT COUNT(*)::int AS calls_today,
           COUNT(*) FILTER (WHERE LOWER(REPLACE(REPLACE(REPLACE(status,'-',''),'_',''),' ','')) IN ('ringing','inprogress','answered'))::int AS active_calls,
           COUNT(*) FILTER (WHERE LOWER(status)='completed')::int AS completed_calls,
           COALESCE(AVG(duration_seconds) FILTER (WHERE duration_seconds IS NOT NULL),0)::int AS average_duration_seconds
         FROM attendance_call_attempts CROSS JOIN bounds WHERE organization_id=$1 AND created_at >= bounds.day_start AND created_at < bounds.day_start + INTERVAL '1 day'`, [organizationId, timezone],
      ),
      this.pool.query("SELECT COUNT(*)::int AS waiting FROM attendance_jobs j JOIN attendance_sessions s ON j.payload->>'sessionId'=s.id::text WHERE s.organization_id=$1 AND j.job_type='place_call' AND j.status='queued'", [organizationId]),
    ]);
    const s = sessions.rows[0] || {};
    const c = calls.rows[0] || {};
    return {
      scheduledToday: s.scheduled_today || 0,
      checkInsConfirmed: s.check_ins_confirmed || 0,
      checkOutsConfirmed: s.check_outs_confirmed || 0,
      checkInsPending: s.check_ins_pending || 0,
      checkOutsPending: s.check_outs_pending || 0,
      exceptions: s.exceptions || 0,
      callsToday: c.calls_today || 0,
      activeCalls: c.active_calls || 0,
      completedCalls: c.completed_calls || 0,
      averageDurationSeconds: c.average_duration_seconds || 0,
      callsWaiting: jobs.rows[0]?.waiting || 0,
      maxConcurrentCalls: Number(process.env.MAX_CONCURRENT_CALLS) || 20,
    };
  }
  async createStaffDirectoryRecord(organizationId, person) {
    const { rows } = await this.pool.query(
      `INSERT INTO staff_directory (organization_id,external_id,name,phone_number,address,language)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (organization_id,external_id) DO NOTHING
       RETURNING external_id,name,phone_number,address,language`,
      [organizationId, person.id, person.name, person.phoneNumber, person.address, person.language || "en"],
    );
    const row = rows[0];
    return row ? {
      id: row.external_id, name: row.name, phoneNumber: row.phone_number,
      phoneMasked: this.maskPhone(row.phone_number), address: row.address, language: row.language,
      patientName: "Unassigned", patientId: null, dutyStatus: "unassigned", assignmentId: "—", sessionId: "",
    } : null;
  }

  async createPatientDirectoryRecord(organizationId, patient) {
    const { rows } = await this.pool.query(
      `INSERT INTO patient_directory (organization_id,external_id,name,phone_number,address,language,care_category,hub)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (organization_id,external_id) DO NOTHING
       RETURNING external_id,name,phone_number,address,language,care_category,hub`,
      [organizationId, patient.id, patient.name, patient.phoneNumber || null, patient.address,
        patient.language || "en", patient.careCategory || "", patient.hub || ""],
    );
    const row = rows[0];
    return row ? {
      id: row.external_id, name: row.name, phoneNumber: row.phone_number, address: row.address,
      language: row.language, assignedStaff: "Unassigned", employeeId: null,
      careCategory: row.care_category || "Not specified", hub: row.hub || "Not specified",
      locationVerification: "not_integrated", status: "unassigned",
    } : null;
  }

  async listStaffDirectory(organizationId, { search = "", status = "all", limit = 100 } = {}) {
    const [profiles, sessions] = await Promise.all([
      this.pool.query(
        `SELECT external_id,name,phone_number,address,language FROM staff_directory
         WHERE organization_id=$1 AND active=TRUE ORDER BY lower(name)`,
        [organizationId],
      ),
      this.listAttendanceSessions(organizationId, { limit: 500 }),
    ]);
    const records = new Map();
    for (const row of profiles.rows) {
      records.set(row.external_id, {
        id: row.external_id, name: row.name, phoneNumber: row.phone_number,
        phoneMasked: this.maskPhone(row.phone_number), address: row.address || "", language: row.language,
        patientName: "Unassigned", patientId: null, dutyStatus: "unassigned", assignmentId: "—", sessionId: "",
      });
    }
    for (const session of sessions) {
      const person = session.employee;
      const key = person.id || person.name;
      if (!key) continue;
      const previous = records.get(key);
      const state = session.sessionStatus === "active" ? "on duty" : session.sessionStatus;
      records.set(key, {
        id: key,
        name: previous?.name || person.name,
        phoneNumber: previous?.phoneNumber || person.phoneNumber || null,
        phoneMasked: previous?.phoneMasked || this.maskPhone(person.phoneNumber),
        address: previous?.address || person.address || "",
        language: previous?.language || session.language,
        patientName: session.patient.name,
        patientId: session.patient.id,
        dutyStatus: state,
        assignmentId: session.assignmentId,
        sessionId: session.sessionId,
      });
    }
    return [...records.values()]
      .filter((record) => (status === "all" || status === record.dutyStatus)
        && (!search || `${record.id} ${record.name} ${record.patientName} ${record.address}`.toLowerCase().includes(search.toLowerCase())))
      .slice(0, Math.min(Number(limit) || 100, 500));
  }

  async listPatientDirectory(organizationId, { search = "", status = "all", limit = 100 } = {}) {
    const [profiles, sessions] = await Promise.all([
      this.pool.query(
        `SELECT external_id,name,phone_number,address,language,care_category,hub FROM patient_directory
         WHERE organization_id=$1 AND active=TRUE ORDER BY lower(name)`,
        [organizationId],
      ),
      this.listAttendanceSessions(organizationId, { limit: 500 }),
    ]);
    const records = new Map();
    for (const row of profiles.rows) {
      records.set(row.external_id, {
        id: row.external_id, name: row.name, phoneNumber: row.phone_number, address: row.address || "",
        language: row.language, assignedStaff: "Unassigned", employeeId: null,
        careCategory: row.care_category || "Not specified", hub: row.hub || "Not specified",
        locationVerification: "not_integrated", status: "unassigned",
      });
    }
    for (const session of sessions) {
      const patient = session.patient;
      const key = patient.id || patient.name;
      if (!key) continue;
      const previous = records.get(key);
      const metadata = session.metadata || {};
      records.set(key, {
        id: key,
        name: previous?.name || patient.name,
        phoneNumber: previous?.phoneNumber || patient.phoneNumber || null,
        address: previous?.address || patient.address || "",
        language: previous?.language || session.language,
        assignedStaff: session.employee.name,
        employeeId: session.employee.id,
        careCategory: previous?.careCategory !== "Not specified" && previous?.careCategory ? previous.careCategory : metadata.careCategory || "Not specified",
        hub: previous?.hub !== "Not specified" && previous?.hub ? previous.hub : metadata.hub || "Not specified",
        locationVerification: "not_integrated",
        status: session.sessionStatus,
      });
    }
    return [...records.values()]
      .filter((record) => (status === "all" || status === record.status)
        && (!search || `${record.id} ${record.name} ${record.assignedStaff} ${record.address}`.toLowerCase().includes(search.toLowerCase())))
      .slice(0, Math.min(Number(limit) || 100, 500));
  }
  async listSupervisionQueue(organizationId, { search = "", severity = "all", limit = 100 } = {}) {
    const sessions = await this.listAttendanceSessions(organizationId, { limit: 500 });
    const items = [];
    for (const session of sessions) {
      for (const stage of ["checkIn", "checkOut"]) {
        const stageState = session[stage].status;
        if (!["not_answered", "missed", "review"].includes(stageState)) continue;
        const critical = stageState === "not_answered" || stageState === "missed";
        const reason = session.stageReasons?.[stage] || (critical ? "No answer retry limit reached" : "Attendance detail needs operations review");
        const item = { id: `${session.sessionId}:${stage}`, sessionId: session.sessionId, assignmentId: session.assignmentId,
          employee: session.employee, patient: session.patient, stage: stage === "checkIn" ? "check_in" : "check_out",
          status: stageState, severity: critical ? "critical" : "high", reason,
          callAttemptCount: session.callAttemptCount, scheduledAt: stage === "checkIn" ? session.scheduledStartAt : session.scheduledEndAt,
          updatedAt: session.updatedAt };
        if ((severity === "all" || item.severity === severity) && (!search || `${item.assignmentId} ${item.employee.name} ${item.patient.name} ${item.reason}`.toLowerCase().includes(search.toLowerCase()))) items.push(item);
      }
    }
    return items.slice(0, Math.min(Number(limit) || 100, 500));
  }
  async listDueFollowUpCalls(limit = 100) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const sql = [
      "WITH followups AS (",
      "SELECT id AS session_id, organization_id, 'check_in' AS stage, active_context->'checkIn' AS stage_context FROM attendance_sessions WHERE check_in_status='follow_up' AND session_status <> 'completed'",
      "UNION ALL",
      "SELECT id AS session_id, organization_id, 'check_out' AS stage, active_context->'checkOut' AS stage_context FROM attendance_sessions WHERE check_out_status='follow_up' AND session_status <> 'completed'",
      ")",
      "SELECT f.session_id, f.organization_id, f.stage, f.stage_context->>'reason' AS reason, f.stage_context->>'nextCallAt' AS due_at,",
      "COALESCE((SELECT MAX(a.attempt_number) FROM attendance_call_attempts a WHERE a.session_id=f.session_id AND a.stage=f.stage),0)::int AS max_call_attempt,",
      "COALESCE((SELECT MAX((j.payload->>'attemptNumber')::int) FROM attendance_jobs j WHERE j.job_type='place_call' AND j.payload->>'sessionId'=f.session_id::text AND j.payload->>'stage'=f.stage),0)::int AS max_job_attempt,",
      "(SELECT j.id FROM attendance_jobs j WHERE j.job_type='place_call' AND j.payload->>'sessionId'=f.session_id::text AND j.payload->>'stage'=f.stage AND j.status='queued' ORDER BY j.run_at,j.created_at LIMIT 1) AS queued_job_id,",
      "(SELECT (j.payload->>'attemptNumber')::int FROM attendance_jobs j WHERE j.job_type='place_call' AND j.payload->>'sessionId'=f.session_id::text AND j.payload->>'stage'=f.stage AND j.status='queued' ORDER BY j.run_at,j.created_at LIMIT 1) AS queued_attempt_number,",
      "EXISTS(SELECT 1 FROM attendance_jobs j WHERE j.job_type='place_call' AND j.payload->>'sessionId'=f.session_id::text AND j.payload->>'stage'=f.stage AND j.status='running') AS has_running_job,",
      "(SELECT COALESCE(a.consecutive_no_answer_before,0)::int FROM attendance_call_attempts a WHERE a.session_id=f.session_id AND a.stage=f.stage ORDER BY a.attempt_number DESC,a.created_at DESC LIMIT 1) AS last_no_answer_before,",
      "(SELECT LOWER(REPLACE(REPLACE(REPLACE(a.status,'-',''),'_',''),' ','')) FROM attendance_call_attempts a WHERE a.session_id=f.session_id AND a.stage=f.stage ORDER BY a.attempt_number DESC,a.created_at DESC LIMIT 1) AS last_attempt_status",
      "FROM followups f",
      "WHERE NULLIF(f.stage_context->>'nextCallAt','') IS NOT NULL AND (f.stage_context->>'nextCallAt')::timestamptz <= NOW()",
      "AND NOT EXISTS(SELECT 1 FROM attendance_call_attempts a WHERE a.session_id=f.session_id AND a.stage=f.stage AND a.ended_at IS NULL AND LOWER(REPLACE(REPLACE(REPLACE(a.status,'-',''),'_',''),' ','')) IN ('placing','ringing','answered','inprogress'))",
      "ORDER BY (f.stage_context->>'nextCallAt')::timestamptz LIMIT $1",
    ].join(" ");
    const { rows } = await this.pool.query(sql, [safeLimit]);
    return rows.map((row) => ({
      sessionId: row.session_id,
      organizationId: row.organization_id,
      stage: row.stage,
      reason: row.reason,
      dueAt: row.due_at,
      maxCallAttempt: Number(row.max_call_attempt) || 0,
      maxJobAttempt: Number(row.max_job_attempt) || 0,
      queuedJobId: row.queued_job_id || null,
      queuedAttemptNumber: row.queued_attempt_number == null ? null : Number(row.queued_attempt_number),
      hasRunningJob: row.has_running_job === true,
      lastNoAnswerBefore: Number(row.last_no_answer_before) || 0,
      lastAttemptStatus: row.last_attempt_status || null,
    }));
  }

  async listAttendanceLedger(organizationId, { search = "", limit = 100 } = {}) {
    const sessions = await this.listAttendanceSessions(organizationId, { search, status: "completed", limit });
    return sessions.filter((session) => session.checkIn.status === "confirmed" && session.checkOut.status === "confirmed");
  }
  async getCallCenterData(organizationId) {
    const [active, retries] = await Promise.all([
      this.pool.query(
        `SELECT a.id AS attempt_id,a.provider_call_id,a.stage,a.status,a.attempt_number,a.answered_at,a.created_at,
                s.id AS session_id,s.external_assignment_id,s.language,s.employee->>'id' AS employee_id,
                s.employee->>'name' AS employee_name,s.patient->>'name' AS patient_name,
                s.patient->>'id' AS patient_id,s.active_context
         FROM attendance_call_attempts a JOIN attendance_sessions s ON s.id=a.session_id
         WHERE a.organization_id=$1 AND LOWER(REPLACE(REPLACE(REPLACE(a.status,'-',''),'_',''),' ','')) IN ('ringing','inprogress','answered')
         ORDER BY a.created_at DESC LIMIT 100`, [organizationId],
      ),
      this.pool.query(
        `SELECT j.id,j.run_at,j.payload->>'stage' AS stage,j.payload->>'attemptNumber' AS attempt_number,
                s.id AS session_id,s.external_assignment_id,s.language,s.employee->>'id' AS employee_id,
                s.employee->>'name' AS employee_name,s.patient->>'name' AS patient_name
         FROM attendance_jobs j JOIN attendance_sessions s ON j.payload->>'sessionId'=s.id::text
         WHERE s.organization_id=$1 AND j.job_type='place_call' AND j.status='queued'
         ORDER BY j.run_at LIMIT 100`, [organizationId],
      ),
    ]);
    return {
      activeCalls: active.rows.map((row) => ({ attemptId: row.attempt_id, callId: row.provider_call_id, sessionId: row.session_id,
        assignmentId: row.external_assignment_id, stage: row.stage, status: row.status, attemptNumber: row.attempt_number,
        employee: { id: row.employee_id, name: row.employee_name }, patient: { id: row.patient_id, name: row.patient_name },
        language: row.language, startedAt: row.answered_at || row.created_at })),
      retryQueue: retries.rows.map((row) => ({ jobId: row.id, sessionId: row.session_id, assignmentId: row.external_assignment_id,
        stage: row.stage, attemptNumber: Number(row.attempt_number) || 1, runAt: row.run_at, language: row.language,
        employee: { id: row.employee_id, name: row.employee_name }, patient: { name: row.patient_name } })),
      maxConcurrentCalls: Number(process.env.MAX_CONCURRENT_CALLS) || 20,
    };
  }
  async getAgentSessionContext(id, stage) {
    const session = await this.getAttendanceSession(id);
    if (!session) return null;
    const attempts = await this.pool.query(
      `SELECT stage,status,attempt_number,scheduled_at,answered_at,ended_at,outcome
       FROM attendance_call_attempts WHERE session_id=$1 ORDER BY created_at`, [id],
    );
    const history = attempts.rows.map((row) => ({
      stage: row.stage, status: row.status, attemptNumber: row.attempt_number,
      scheduledAt: row.scheduled_at, answeredAt: row.answered_at, endedAt: row.ended_at,
      outcome: json(row.outcome),
    }));
    const context = session.activeContext || {};
    return {
      assignment: { id: session.assignmentId, scheduleVersion: session.scheduleVersion, ...(session.metadata || {}) },
      employee: session.employee,
      patient: session.patient,
      stage,
      scheduledStartAt: session.scheduledStartAt,
      scheduledEndAt: session.scheduledEndAt,
      priorCallStatus: history,
      factsConfirmed: {
        checkIn: context.checkIn || (session.checkInStatus === "confirmed" ? { status: "confirmed" } : {}),
        checkOut: context.checkOut || (session.checkOutStatus === "confirmed" ? { status: "confirmed" } : {}),
      },
      requestedCallbackAt: context.checkIn?.nextCallAt || context.checkOut?.nextCallAt || null,
      unresolvedQuestions: context.unresolvedQuestions || [],
    };
  }
  async createCallAttempt({ organizationId, sessionId, stage, attemptNumber, callTargetRole = "employee", scheduledAt, consecutiveNoAnswer = 0 }) {
    const r = await this.pool.query(
      `INSERT INTO attendance_call_attempts (organization_id,session_id,stage,attempt_number,call_target_role,scheduled_at,status,consecutive_no_answer_before)
       VALUES ($1,$2,$3,$4,$5,$6,'scheduled',$7)
       ON CONFLICT (session_id,stage,attempt_number) DO NOTHING
       RETURNING *`, [organizationId, sessionId, stage, attemptNumber, callTargetRole, scheduledAt, consecutiveNoAnswer],
    );
    if (r.rows[0]) return { ...this.mapAttempt(r.rows[0]), shouldPlace: true };
    const existing = await this.pool.query("SELECT * FROM attendance_call_attempts WHERE session_id=$1 AND stage=$2 AND attempt_number=$3", [sessionId, stage, attemptNumber]);
    const attempt = this.mapAttempt(existing.rows[0]);
    // Capacity-deferred attempts stay scheduled; the conditional transition
    // in markCallPlacing below ensures only one worker can place the call.
    return { ...attempt, shouldPlace: attempt.status === "scheduled" && !attempt.providerCallId };
  }
  mapAttempt(row) {
    if (!row) return null;
    return { id: row.id, organizationId: row.organization_id, sessionId: row.session_id, stage: row.stage,
      attemptNumber: row.attempt_number, callTargetRole: row.call_target_role, providerCallId: row.provider_call_id,
      status: row.status, scheduledAt: row.scheduled_at, answeredAt: row.answered_at, endedAt: row.ended_at,
      consecutiveNoAnswerBefore: row.consecutive_no_answer_before || 0, recordingUrl: row.recording_url,
      recordingObjectKey: row.recording_object_key, recordingContentType: row.recording_content_type,
      outcome: json(row.outcome), durationSeconds: row.duration_seconds };
  }
  async getCallAttempt(id) {
    const r = await this.pool.query("SELECT * FROM attendance_call_attempts WHERE id=$1", [id]);
    return this.mapAttempt(r.rows[0]);
  }
  async attachProviderCallId(id, providerCallId, response) {
    await this.pool.query(
      `UPDATE attendance_call_attempts SET provider_call_id=$2,status='ringing',raw_provider_event=$3::jsonb,updated_at=NOW() WHERE id=$1`,
      [id, providerCallId, JSON.stringify(response || {})],
    );
  }
  async markCallPlacing(id) {
    const r = await this.pool.query("UPDATE attendance_call_attempts SET status='placing',updated_at=NOW() WHERE id=$1 AND status='scheduled' RETURNING id", [id]);
    return r.rowCount === 1;
  }
  async reserveOutboundCallSlot({ callAttemptId, organizationId, maxConcurrentCalls, ttlMinutes = 180 }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // One transaction-scoped lock serializes capacity checks across replicas.
      await client.query("SELECT pg_advisory_xact_lock($1)", [741928461]);
      await client.query("DELETE FROM outbound_call_slots WHERE expires_at <= NOW()");
      const existing = await client.query("SELECT 1 FROM outbound_call_slots WHERE call_attempt_id=$1", [callAttemptId]);
      if (existing.rowCount) { await client.query("COMMIT"); return true; }
      const count = await client.query("SELECT COUNT(*)::int AS active FROM outbound_call_slots");
      if (count.rows[0].active >= maxConcurrentCalls) { await client.query("COMMIT"); return false; }
      await client.query(
        `INSERT INTO outbound_call_slots(call_attempt_id,organization_id,expires_at)
         VALUES($1,$2,NOW()+($3 * INTERVAL '1 minute'))`,
        [callAttemptId, organizationId, ttlMinutes],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async releaseOutboundCallSlot(callAttemptId) {
    await this.pool.query("DELETE FROM outbound_call_slots WHERE call_attempt_id=$1", [callAttemptId]);
  }
  async markCallPlacementFailed(id, reason) {
    await this.pool.query("UPDATE attendance_call_attempts SET status='placement_failed',raw_provider_event=$2::jsonb,updated_at=NOW() WHERE id=$1",
      [id, JSON.stringify({ error: String(reason || "Call placement failed") })]);
  }
  async claimCallStream(id) {
    const r = await this.pool.query(
      `UPDATE attendance_call_attempts SET stream_started_at=NOW(),stream_ended_at=NULL,updated_at=NOW()
       WHERE id=$1 AND LOWER(status) NOT IN ('completed','no-answer','noanswer','failed','busy','canceled','cancelled')
         AND (stream_started_at IS NULL OR stream_ended_at IS NOT NULL) RETURNING id`, [id],
    );
    return r.rowCount === 1;
  }
  async endCallStream(id) {
    await this.pool.query("UPDATE attendance_call_attempts SET stream_ended_at=NOW(),updated_at=NOW() WHERE id=$1 AND stream_ended_at IS NULL", [id]);
  }
  async updateCallByProviderId(event) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let r = await client.query("SELECT * FROM attendance_call_attempts WHERE provider=$1 AND provider_call_id=$2 FOR UPDATE", [event.provider, event.providerCallId]);
      if (r.rows[0]) {
        const row = r.rows[0];
        const raw = event.rawEvent || {};
        const status = String(event.status || row.status).toLowerCase();
        const safeProviderEvent = {
          providerCallId: event.providerCallId,
          status,
          startTime: raw.StartTime || null,
          answerTime: raw.AnswerTime || null,
          endTime: raw.EndTime || null,
          durationSeconds: event.durationSeconds || null,
          recordingAvailable: Boolean(raw.RecordingUrl || raw.recording_url),
        };
        await client.query(
          `UPDATE attendance_call_attempts SET status=$2, ended_at=$3, duration_seconds=$4,
           answered_at=COALESCE(answered_at,$5), recording_url=COALESCE($6,recording_url), raw_provider_event=$7::jsonb, updated_at=NOW()
           WHERE id=$1`,
          [row.id, status, event.endedAt, event.durationSeconds, raw.AnswerTime || null, raw.RecordingUrl || raw.recording_url || null, JSON.stringify(safeProviderEvent)],
        );
        const terminal = ["completed", "no-answer", "noanswer", "failed", "busy", "canceled", "cancelled"].includes(status.replace(/[ _-]/g, ""));
        if (terminal || raw.EndTime) await client.query("DELETE FROM outbound_call_slots WHERE call_attempt_id=$1", [row.id]);
        await client.query(
          `INSERT INTO attendance_audit_events (organization_id,session_id,event_type,event_data)
           VALUES ($1,$2,'vobiz.call_status',$3::jsonb)`,
          [row.organization_id, row.session_id, JSON.stringify({
            provider: event.provider, providerCallId: event.providerCallId, status,
            durationSeconds: event.durationSeconds || null, startTime: raw.StartTime || null,
            answerTime: raw.AnswerTime || null, endTime: raw.EndTime || null,
            recordingAvailable: Boolean(raw.RecordingUrl || raw.recording_url),
          })],
        );
        await client.query("COMMIT");
        return this.getCallAttempt(row.id);
      }
      r = await client.query("SELECT * FROM call_records WHERE provider=$1 AND provider_call_id=$2 FOR UPDATE", [event.provider, event.providerCallId]);
      if (!r.rows[0]) { await client.query("COMMIT"); return null; }
      await client.query("UPDATE call_records SET status=$3,updated_at=NOW() WHERE provider=$1 AND provider_call_id=$2", [event.provider, event.providerCallId, event.status]);
      await client.query("COMMIT");
      return { id: r.rows[0].id, status: event.status, genericCall: true };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async saveTranscript({ organizationId, sessionId, callAttemptId, language, text }) {
    const r = await this.pool.query(
      `INSERT INTO attendance_transcripts (organization_id,session_id,call_attempt_id,language,transcript)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (call_attempt_id) DO UPDATE SET transcript=EXCLUDED.transcript,language=EXCLUDED.language
       RETURNING *`, [organizationId, sessionId, callAttemptId, language, text],
    );
    await this.pool.query("UPDATE attendance_call_attempts SET transcript_id=$2,updated_at=NOW() WHERE id=$1", [callAttemptId, r.rows[0].id]);
    return r.rows[0];
  }
  async getTranscriptForCall(callAttemptId) {
    const r = await this.pool.query("SELECT * FROM attendance_transcripts WHERE call_attempt_id=$1", [callAttemptId]);
    return r.rows[0] ? { ...r.rows[0], text: r.rows[0].transcript } : null;
  }
  async saveCallOutcome(callAttemptId, outcome) {
    await this.pool.query("UPDATE attendance_call_attempts SET outcome=$2::jsonb,updated_at=NOW() WHERE id=$1", [callAttemptId, JSON.stringify(outcome)]);
    await this.pool.query(
      `UPDATE attendance_transcripts SET extraction=$2::jsonb WHERE call_attempt_id=$1`, [callAttemptId, JSON.stringify(outcome)],
    );
  }
  async nextAttemptNumber(sessionId, stage) {
    const r = await this.pool.query("SELECT COALESCE(MAX(attempt_number),0)+1 AS next FROM attendance_call_attempts WHERE session_id=$1 AND stage=$2", [sessionId, stage]);
    return Number(r.rows[0].next);
  }
  async setStageStatus(sessionId, stage, status, contextPatch = {}) {
    const column = stage === "check_in" ? "check_in_status" : "check_out_status";
    const stageKey = stage === "check_in" ? "checkIn" : "checkOut";
    await this.pool.query(
      `WITH updated AS (
         UPDATE attendance_sessions SET ${column}=$2,
          active_context=jsonb_set(active_context, ARRAY[$3], COALESCE(active_context-> $3,'{}'::jsonb) || $4::jsonb, true), updated_at=NOW()
          WHERE id=$1 RETURNING organization_id
       )
       INSERT INTO attendance_audit_events (organization_id,session_id,event_type,event_data)
       SELECT organization_id,$1,'attendance.stage_status',$5::jsonb FROM updated`,
      [sessionId, status, stageKey, JSON.stringify(contextPatch), JSON.stringify({ stage, status, ...contextPatch })],
    );
  }
  async setRecordingObjectKey(callAttemptId, key, contentType) {
    await this.pool.query("UPDATE attendance_call_attempts SET recording_object_key=$2,recording_content_type=$3,updated_at=NOW() WHERE id=$1", [callAttemptId, key, contentType || null]);
  }
  async markSessionCompleted(sessionId) {
    const result = await this.pool.query(
      `WITH eligible AS (
         SELECT id, organization_id, session_status
         FROM attendance_sessions
         WHERE id=$1 AND check_in_status='confirmed' AND check_out_status='confirmed'
         FOR UPDATE
       ), updated AS (
         UPDATE attendance_sessions s SET session_status='completed',updated_at=NOW()
         FROM eligible e
         WHERE s.id=e.id AND e.session_status IS DISTINCT FROM 'completed'
         RETURNING s.organization_id,s.id
       ), audit AS (
         INSERT INTO attendance_audit_events (organization_id,session_id,event_type,event_data)
         SELECT organization_id,id,'attendance.session_completed','{}'::jsonb FROM updated
       )
       SELECT EXISTS(SELECT 1 FROM eligible) AS eligible`, [sessionId],
    );
    return result.rows[0]?.eligible === true;
  }
  async markSessionException(sessionId) {
    await this.pool.query(
      `WITH updated AS (UPDATE attendance_sessions SET session_status='exception',updated_at=NOW() WHERE id=$1 RETURNING organization_id)
       INSERT INTO attendance_audit_events (organization_id,session_id,event_type,event_data)
       SELECT organization_id,$1,'attendance.session_exception','{}'::jsonb FROM updated`, [sessionId],
    );
  }
  async getSessionArtifacts(sessionId) {
    const session = await this.getAttendanceSession(sessionId);
    if (!session) return null;
    const [attempts, transcripts, events] = await Promise.all([
      this.pool.query("SELECT * FROM attendance_call_attempts WHERE session_id=$1 ORDER BY created_at", [sessionId]),
      this.pool.query("SELECT * FROM attendance_transcripts WHERE session_id=$1 ORDER BY created_at", [sessionId]),
      this.pool.query("SELECT event_type,event_data,created_at FROM attendance_audit_events WHERE session_id=$1 ORDER BY created_at", [sessionId]),
    ]);
    return {
      session,
      callAttempts: attempts.rows.map((row) => this.mapAttempt(row)),
      transcripts: transcripts.rows.map((row) => ({
        id: row.id,
        callAttemptId: row.call_attempt_id,
        language: row.language,
        text: row.transcript,
        extraction: json(row.extraction),
        createdAt: row.created_at,
      })),
      logs: events.rows.map((row) => ({
        eventType: row.event_type,
        data: json(row.event_data),
        createdAt: row.created_at,
      })),
    };
  }
  async buildBackendAttendancePayload(sessionId) {
    const artifacts = await this.getSessionArtifacts(sessionId);
    if (!artifacts) return null;
    return {
      session: artifacts.session,
      callAttempts: artifacts.callAttempts,
      transcripts: artifacts.transcripts,
    };
  }
  async markBackendDelivered(sessionId, response) {
    await this.pool.query(
      `WITH updated AS (
         UPDATE attendance_sessions SET backend_delivery_status='delivered',backend_delivery_response=$2::jsonb,
          backend_delivered_at=NOW(),updated_at=NOW()
          WHERE id=$1 AND session_status='completed' AND check_in_status='confirmed' AND check_out_status='confirmed'
          RETURNING organization_id
       )
       INSERT INTO attendance_audit_events (organization_id,session_id,event_type,event_data)
       SELECT organization_id,$1,'attendance.backend_delivered',$3::jsonb FROM updated`,
      [sessionId, JSON.stringify(response || {}), JSON.stringify({ status: response?.status || null })],
    );
  }
}

module.exports = { PostgresRepository };
