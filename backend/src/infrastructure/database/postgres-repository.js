Warning: truncated output (original token count: 28246)
Total output lines: 1905

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

  async findWebUserByLogin(identifier) {
    const digits = String(identifier || "").replace(/\D/g, "");
    const phoneCandidates = digits.length === 12 && digits.startsWith("91")
      ? [digits, digits.slice(2)]
      : digits.length === 10 ? [`91${digits}`, digits] : [digits, ""];
    const { rows } = await this.pool.query(
      `SELECT DISTINCT u.id,u.organization_id,u.email,u.display_name,u.password_salt,u.password_hash,u.active,u.role,
         u.must_change_password,cm.phone
       FROM web_users u
       LEFT JOIN athulya_care_managers cm ON cm.app_user_id=u.id AND cm.organization_id=u.organization_id
       WHERE lower(COALESCE(u.email,''))=lower($1)
          OR (u.role='care_manager' AND regexp_replace(COALESCE(cm.phone,''),'[^0-9]','','g') IN ($2,$3))
       LIMIT 2`,
      [identifier, phoneCandidates[0], phoneCandidates[1]],
    );
    if (rows.length !== 1) return null;
    const row = rows[0];
    return row ? {
      id: row.id,
      organizationId: row.organization_id,
      email: row.email,
      displayName: row.display_name,
      passwordSalt: row.password_salt,
      passwordHash: row.password_hash,
      active: row.active,
      role: row.role || "admin",
      phone: row.phone || null,
      mustChangePassword: row.must_change_password === true,
    } : null;
  }

  async getWebUserById(id) {
    const { rows } = await this.pool.query(
      `SELECT u.id,u.organization_id,u.email,u.display_name,u.password_salt,u.password_hash,u.active,u.role,u.must_change_password,
         (SELECT cm.phone FROM athulya_care_managers cm WHERE cm.app_user_id=u.id AND cm.organization_id=u.organization_id LIMIT 1) AS phone
       FROM web_users u WHERE u.id=$1 LIMIT 1`, [id],
    );
    const row = rows[0];
    return row ? {
      id: row.id, organizationId: row.organization_id, email: row.email,
      displayName: row.display_name, passwordSalt: row.password_salt,
      passwordHash: row.password_hash, active: row.active, role: row.role || "admin",
      phone: row.phone || null,
      mustChangePassword: row.must_change_password === true,
    } : null;
  }

  async updateWebUserPassword(id, passwordSalt, passwordHash, currentTokenHash) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rowCount } = await client.query(
        `UPDATE web_users SET password_salt=$2,password_hash=$3,must_change_password=FALSE,updated_at=NOW()
         WHERE id=$1 AND active=TRUE`, [id, passwordSalt, passwordHash],
      );
      if (!rowCount) { await client.query("ROLLBACK"); return false; }
      await client.query(
        `UPDATE web_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL AND token_hash<>$2`,
        [id, currentTokenHash],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
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

  async provisionCareManagerAccounts({ organizationId, managers }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const created = [];
      for (const manager of managers) {
        const existing = await client.query(
          `SELECT id,app_user_id FROM athulya_care_managers
           WHERE organization_id=$1 AND athulya_care_manager_id=$2 FOR UPDATE`,
          [organizationId, manager.athulyaId],
        );
        const normalizedPhone = manager.phone.replace(/\D/g, "");
        const localPhone = normalizedPhone.startsWith("91") ? normalizedPhone.slice(2) : normalizedPhone;
        const reusedPhone = await client.query(
          `SELECT athulya_care_manager_id FROM athulya_care_managers
           WHERE organization_id=$1 AND athulya_care_manager_id<>$2 AND app_user_id IS NOT NULL
             AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g') IN ($3,$4)
           LIMIT 1`,
          [organizationId, manager.athulyaId, normalizedPhone, localPhone],
        );
        if (reusedPhone.rows[0]) throw new Error(`The phone number for Care Manager ID ${manager.athulyaId} is already used by another account.`);
        if (existing.rows[0]?.app_user_id) {
          throw new Error(`Care Manager ID ${manager.athulyaId} is already linked to an application account.`);
        }
        const user = await client.query(
          `INSERT INTO web_users (organization_id,email,display_name,password_salt,password_hash,role,must_change_password)
           VALUES ($1,NULL,$2,$3,$4,'care_manager',TRUE)
           RETURNING id,display_name,role`,
          [organizationId, manager.name, manager.passwordSalt, manager.passwordHash],
        );
        if (existing.rows[0]) {
          await client.query(
            `UPDATE athulya_care_managers SET app_user_id=$3,name=$4,phone=$5,active=TRUE,updated_at=NOW()
             WHERE organization_id=$1 AND athulya_care_manager_id=$2`,
            [organizationId, manager.athulyaId, user.rows[0].id, manager.name, manager.phone],
          );
        } else {
          await client.query(
            `INSERT INTO athulya_care_managers (organization_id,athulya_care_manager_id,app_user_id,name,phone)
             VALUES ($1,$2,$3,$4,$5)`,
            [organizationId, manager.athulyaId, user.rows[0].id, manager.name, manager.phone],
          );
        }
        created.push({ id: user.rows[0].id, name: manager.name, athulyaId: manager.athulyaId, phone: manager.phone });
      }
      await client.query("COMMIT");
      return created;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async createCareManagerUser({ organizationId, email, displayName, passwordSalt, passwordHash, athulyaId, phone = null }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `INSERT INTO web_users (organization_id,email,display_name,password_salt,password_hash,role)
         VALUES ($1,$2,$3,$4,$5,'care_manager')
         RETURNING id,organization_id,email,display_name,active,role,created_at`,
        [organizationId, email, displayName, passwordSalt, passwordHash],
      );
      const user = rows[0];
      const linked = await client.query(
        `INSERT INTO athulya_care_managers (organization_id,athulya_care_manager_id,app_user_id,name,email,phone)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (organization_id,athulya_care_manager_id) DO UPDATE SET
           app_user_id=EXCLUDED.app_user_id,name=EXCLUDED.name,email=EXCLUDED.email,phone=EXCLUDED.phone,active=TRUE,updated_at=NOW()
         WHERE athulya_care_managers.app_user_id IS NULL
         RETURNING id`,
        [organizationId, athulyaId, user.id, displayName, email, phone],
      );
      if (!linked.rowCount) throw new Error("This Athulya Care Manager ID is already linked to an application account.");
      await client.query("COMMIT");
      return user;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async listCareManagers(organizationId) {
    const { rows } = await this.pool.query(
      `SELECT cm.id,cm.athulya_care_manager_id AS "athulyaCareManagerId",cm.name,cm.email,cm.phone,
        cm.active,u.id AS "userId",u.active AS "accountActive",u.created_at AS "createdAt",
        MAX(s.last_used_at) AS "lastLogin"
       FROM athulya_care_managers cm LEFT JOIN web_users u ON u.id=cm.app_user_id
       LEFT JOIN web_sessions s ON s.user_id=u.id AND s.revoked_at IS NULL
       WHERE cm.organization_id=$1 GROUP BY cm.id,u.id ORDER BY lower(cm.name)`, [organizationId],
    );
    return rows.map((row) => ({ ...row, lastLogin: row.lastLogin || null }));
  }

  async updateCareManager(organizationId, id, { name, email, phone, athulyaId }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `UPDATE athulya_care_managers cm SET athulya_care_manager_id=$3,name=$4,email=$5,phone=$6,updated_at=NOW()
         WHERE cm.organization_id=$1 AND cm.id=$2 RETURNING cm.app_user_id`,
        [organizationId,id,athulyaId,name,email,phone || null],
      );
      if (!rows[0]) { await client.query("ROLLBACK"); return false; }
      if (rows[0].app_user_id) await client.query(
        `UPDATE web_users SET email=$2,display_name=$3,updated_at=NOW() WHERE id=$1`, [rows[0].app_user_id,email,name],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async setCareManagerActive(organizationId, id, active) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `UPDATE athulya_care_managers SET active=$3,updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING app_user_id`,
        [organizationId, id, active],
      );
      if (rows[0]?.app_user_id) {
        await client.query("UPDATE web_users SET active=$2,updated_at=NOW() WHERE id=$1", [rows[0].app_user_id, active]);
        if (!active) await client.query("UPDATE web_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL", [rows[0].app_user_id]);
      }
      await client.query("COMMIT");
      return rows.length > 0;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async resetCareManagerPassword(organizationId, id, passwordSalt, passwordHash) {
    const { rows } = await this.pool.query(
      `UPDATE web_users u SET password_salt=$3,password_hash=$4,must_change_password=TRUE,updated_at=NOW()
       FROM athulya_care_managers cm WHERE cm.app_user_id=u.id AND cm.organization_id=$1 AND cm.id=$2
       RETURNING u.id`, [organizationId, id, passwordSalt, passwordHash],
    );
    if (rows[0]) await this.pool.query("UPDATE web_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL", [rows[0].id]);
    return Boolean(rows[0]);
  }

  async getAthulyaIntegration(organizationId) {
    const { rows } = await this.pool.query(
      `SELECT integration_name AS "integrationName",api_base_url AS "apiBaseUrl",encrypted_api_key AS "encryptedApiKey",
        enabled,auto_sync_enabled AS "autoSyncEnabled",auto_sync_enabled_at AS "autoSyncEnabledAt",
        last_auto_sync_slot AS "lastAutoSyncSlot",auto_sync_scope AS "autoSyncScope",
        auto_sync_scope_id AS "autoSyncScopeId",updated_at AS "updatedAt",
        (SELECT MAX(completed_at) FROM athulya_sync_runs WHERE organization_id=$1 AND status='succeeded') AS "lastSuccessfulScheduleSync",
        (SELECT MAX(updated_at) FROM athulya_attendance_submissions WHERE organization_id=$1 AND status='synced') AS "lastSuccessfulAttendanceSubmission"
       FROM athulya_integration_settings WHERE organization_id=$1`, [organizationId],
    );
    return rows[0] || { integrationName: "Athulya Platform", apiBaseUrl: "https://homecare.athulyaliving.net/api", encryptedApiKey: null, enabled: false, autoSyncEnabled: false, autoSyncEnabledAt: null, lastAutoSyncSlot: null, autoSyncScope: "all", autoSyncScopeId: "", lastSuccessfulScheduleSync: null, lastSuccessfulAttendanceSubmission: null };
  }

  async saveAthulyaIntegration(organizationId, { integrationName, apiBaseUrl, encryptedApiKey, enabled, autoSyncEnabled = false, autoSyncScope = "all", autoSyncScopeId = "", updatedBy }) {
    const { rows } = await this.pool.query(
      `INSERT INTO athulya_integration_settings (organization_id,integration_name,api_base_url,encrypted_api_key,enabled,auto_sync_enabled,auto_sync_enabled_at,auto_sync_scope,auto_sync_scope_id,updated_by)
       VALUES ($1,$2,$3,$4,$5,$7,CASE WHEN $7 THEN NOW() ELSE NULL END,$8,$9,$6) ON CONFLICT (organization_id) DO UPDATE SET
       integration_name=EXCLUDED.integration_name,api_base_url=EXCLUDED.api_base_url,
       encrypted_api_key=COALESCE(EXCLUDED.encrypted_api_key,athulya_integration_settings.encrypted_api_key),
       enabled=EXCLUDED.enabled,
       auto_sync_enabled_at=CASE WHEN EXCLUDED.auto_sync_enabled AND NOT athulya_integration_settings.auto_sync_enabled THEN NOW() WHEN EXCLUDED.auto_sync_enabled THEN athulya_integration_settings.auto_sync_enabled_at ELSE NULL END,
       auto_sync_enabled=EXCLUDED.auto_sync_enabled,auto_sync_scope=EXCLUDED.auto_sync_scope,
       auto_sync_scope_id=EXCLUDED.auto_sync_scope_id,updated_by=EXCLUDED.updated_by,updated_at=NOW()
       RETURNING integration_name AS "integrationName",api_base_url AS "apiBaseUrl",encrypted_api_key AS "encryptedApiKey",enabled,
       auto_sync_enabled AS "autoSyncEnabled",auto_sync_enabled_at AS "autoSyncEnabledAt",last_auto_sync_slot AS "lastAutoSyncSlot",
       auto_sync_scope AS "autoSyncScope",auto_sync_scope_id AS "autoSyncScopeId",updated_at AS "updatedAt",
       (SELECT MAX(completed_at) FROM athulya_sync_runs WHERE organization_id=$1 AND status='succeeded') AS "lastSuccessfulScheduleSync",
       (SELECT MAX(updated_at) FROM athulya_attendance_submissions WHERE organization_id=$1 AND status='synced') AS "lastSuccessfulAttendanceSubmission"`,
      [organizationId, integrationName, apiBaseUrl, encryptedApiKey || null, enabled, updatedBy || null, autoSyncEnabled, autoSyncScope, autoSyncScopeId],
    );
    return rows[0];
  }

  async listAutoSyncAthulyaIntegrations() {
    const { rows } = await this.pool.query(
      `SELECT organization_id AS "organizationId",auto_sync_enabled_at AS "autoSyncEnabledAt",last_auto_sync_slot AS "lastAutoSyncSlot",
        auto_sync_scope AS "autoSyncScope",auto_sync_scope_id AS "autoSyncScopeId"
       FROM athulya_integration_settings WHERE enabled=TRUE AND auto_sync_enabled=TRUE AND encrypted_api_key IS NOT NULL`,
    );
    return rows;
  }

  async enqueueScheduledAthulyaSync({ organizationId, slotKey, slotAt, filters = {}, scope = "all", scopeId = "", client }) {
    if (!client?.query) throw new Error("A database transaction client is required");
    const claimed = await client.query(
      `UPDATE athulya_integration_settings SET last_auto_sync_slot=$2,updated_at=NOW()
       WHERE organization_id=$1 AND enabled=TRUE AND auto_sync_enabled=TRUE
         AND auto_sync_enabled_at <= $3 AND (last_auto_sync_slot IS NULL OR last_auto_sync_slot < $2)
       RETURNING organization_id`, [organizationId, slotKey, slotAt],
    );
    if (!claimed.rowCount) return null;
    const run = await client.query(
      `INSERT INTO athulya_sync_runs (organization_id,status,from_date,to_date,filters)
       VALUES ($1,'running',$2,$3,$4::jsonb) RETURNING id`,
      [organizationId, filters.from_date || null, filters.to_date || null,
        JSON.stringify({ sync_source: "automatic", slot: slotKey, sync_scope: scope, sync_scope_id: scopeId, ...filters })],
    );
    return run.rows[0].id;
  }

  async createAthulyaSyncRun(organizationId, { fromDate, toDate, filters }) {
    const { rows } = await this.pool.query(
      `INSERT INTO athulya_sync_runs (organization_id,status,from_date,to_date,filters) VALUES ($1,'running',$2,$3,$4::jsonb) RETURNING id`,
      [organizationId, fromDate || null, toDate || null, JSON.stringify({ ...(filters || {}), sync_source: "manual" })],
    );
    return rows[0].id;
  }

  async finishAthulyaSyncRun(id, { status, recordsReceived = 0, recordsUpserted = 0, errorMessage = null }) {
    await this.pool.query(
      `UPDATE athulya_sync_runs SET status=$2,records_received=$3,records_upserted=$4,error_message=$5,completed_at=NOW() WHERE id=$1`,
      [id, status, recordsReceived, recordsUpserted, errorMessage],
    );
  }

  async upsertAthulyaSchedules(organizationId, records) {
    const client = await this.pool.connect();
    let upserted = 0;
    try {
      await client.query("BEGIN");
      for (const item of records) {
        const source = item.source;
        const scheduleId = source.schedule_id == null ? null : String(source.schedule_id).trim();
        const schedulePk = source.schedule_pk == null ? "" : String(source.schedule_pk).trim();
        if (!scheduleId) continue;
        const patientId = source.patient_id == null ? "" : String(source.patient_id).trim();
        const patientUhid = source.patient_uhid == null ? "" : String(source.patient_uhid).trim();
        const careManagerId = source.care_manager_id == null ? "" : String(source.care_manager_id).trim();
        const careManagerName = source.care_manager_name == null ? "" : String(source.care_manager_name).trim();
        const careManagerPhone = source.care_manager_phone == null ? null : String(source.care_manager_phone).trim();
        if (patientId) await client.query(
          `INSERT INTO patient_directory (organization_id,external_id,name,phone_number,address,language,care_category,hub,athulya_patient_uhid,branch)
           VALUES ($1,$2,$3,NULL,'','ta',$4,$5,$6,$7) ON CONFLICT (organization_id,external_id) DO UPDATE SET
           name=CASE WHEN EXCLUDED.name<>'' THEN EXCLUDED.name ELSE patient_directory.name END,
           care_category=CASE WHEN EXCLUDED.care_category<>'' THEN EXCLUDED.care_category ELSE patient_directory.care_category END,
           hub=CASE WHEN EXCLUDED.hub<>'' THEN EXCLUDED.hub ELSE patient_directory.hub END,
           athulya_patient_uhid=CASE WHEN EXCLUDED.athulya_patient_uhid<>'' THEN EXCLUDED.athulya_patient_uhid ELSE patient_directory.athulya_patient_uhid END,
           branch=CASE WHEN EXCLUDED.branch<>'' THEN EXCLUDED.branch ELSE patient_directory.branch END,updated_at=NOW()`,
          [organizationId,patientId,String(source.client_name ?? "").trim(),String(source.service_name ?? "").trim(),String(source.branch ?? "").trim(),patientUhid,String(source.branch ?? "").trim()],
        );
        if (careManagerId && careManagerName) await client.query(
          `INSERT INTO athulya_care_managers (organization_id,athulya_care_manager_id,name,phone)
           VALUES ($1,$2,$3,$4) ON CONFLICT (organization_id,athulya_care_manager_id) DO UPDATE SET
           name=CASE WHEN EXCLUDED.name<>'' THEN EXCLUDED.name ELSE athulya_care_managers.name END,
           phone=COALESCE(NULLIF(EXCLUDED.phone,''),athulya_care_managers.phone),updated_at=NOW()`,
          [organizationId,careManagerId,careManagerName,careManagerPhone],
        );
        for (const caregiver of item.caregivers) {
          if (!caregiver.id) continue;
          await client.query(
            `INSERT INTO staff_directory (organization_id,external_id,name,company_name,phone_number,address,language,branch)
             VALUES ($1,$2,$3,$4,$5,'','ta',$6) ON CONFLICT (organization_id,external_id) DO UPDATE SET
             name=CASE WHEN EXCLUDED.name<>'' THEN EXCLUDED.name ELSE staff_directory.name END,
             company_name=CASE WHEN EXCLUDED.company_name<>'' THEN EXCLUDED.company_name ELSE staff_directory.company_name END,
             phone_number=CASE WHEN EXCLUDED.phone_number<>'' THEN EXCLUDED.phone_number ELSE staff_directory.phone_number END,
             branch=CASE WHEN EXCLUDED.branch<>'' THEN EXCLUDED.branch ELSE staff_directory.branch END,active=TRUE,updated_at=NOW()`,
            [organizationId,String(caregiver.id).trim(),caregiver.name?.trim() || "",String(source.vendor_company ?? "ATHULYA").trim() || "ATHULYA",caregiver.phone?.trim() || "",String(source.branch ?? "").trim()],
          );
        }
        const { rows } = await client.query(
          `INSERT INTO athulya_schedules (organization_id,athulya_schedule_id,athulya_schedule_pk,patient_external_id,patient_uhid,patient_name,
           care_manager_external_id,care_manager_name,care_manager_phone,schedule_date,start_time,end_time,schedule_status,service_name,
           service_from_date,service_to_date,active_service_status,care_plan,branch,vendor_company,raw_source_data,last_synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11,$12,$13,$14,$15::date,$16::date,$17,$18,$19,$20,$21::jsonb,NOW())
           ON CONFLICT (organization_id,athulya_schedule_id,athulya_schedule_pk) DO UPDATE SET
           patient_external_id=EXCLUDED.patient_external_id,patient_uhid=EXCLUDED.patient_uhid,patient_name=EXCLUDED.patient_name,
           care_manager_external_id=EXCLUDED.care_manager_external_id,care_manager_name=EXCLUDED.care_manager_name,care_manager_phone=EXCLUDED.care_manager_phone,
           schedule_date=EXCLUDED.schedule_date,start_time=EXCLUDED.start_time,end_time=EXCLUDED.end_time,schedule_status=EXCLUDED.schedule_status,
           service_name=EXCLUDED.service_name,service_from_date=EXCLUDED.service_from_date,service_to_date=EXCLUDED.service_to_date,
           active_service_status=EXCLUDED.active_service_status,care_plan=EXCLUDED.care_plan,branch=EXCLUDED.branch,vendor_company=EXCLUDED.vendor_company,
           raw_source_data=EXCLUDED.raw_source_data,last_synced_at=NOW(),updated_at=NOW() RETURNING id`,
          [organizationId,scheduleId,schedulePk,patientId,patientUhid,String(source.client_name ?? "").trim(),
            careManagerId,careManagerName,String(careManagerPhone ?? "").trim(),
            item.scheduleDate || null,source.start_time == null ? null : String(source.start_time),source.end_time == null ? null : String(source.end_time),
            String(source.schedule_status ?? ""),String(source.service_name ?? ""),item.serviceFromDate || null,item.serviceToDate || null,
            String(source.active_service_status ?? ""),String(source.care_plan ?? ""),String(source.branch ?? ""),String(source.vendor_company ?? ""),JSON.stringify(source)],
        );
        const id = rows[0].id;
        await client.query("DELETE FROM athulya_schedule_caregivers WHERE schedule_id=$1", [id]);
        for (const caregiver of item.caregivers) {
          await client.query(
            `INSERT INTO athulya_schedule_caregivers (organization_id,schedule_id,athulya_caregiver_id,caregiver_name,caregiver_phone,caregiver_schedule_status)
             VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (schedule_id,athulya_caregiver_id,caregiver_phone) DO UPDATE SET caregiver_name=EXCLUDED.caregiver_name,caregiver_schedule_status=EXCLUDED.caregiver_schedule_status`,
            [organizationId,id,caregiver.id,caregiver.name,caregiver.phone,caregiver.status],
          );
        }
        upserted += 1;
      }
      await client.query("COMMIT");
      return upserted;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async listAthulyaSchedules(organizationId, { fromDate, toDate, limit = 500 } = {}) {
    const { rows } = await this.pool.query(
      `SELECT s.*,COALESCE(jsonb_agg(jsonb_build_object('id',c.athulya_caregiver_id,'name',c.caregiver_name,'phone',c.caregiver_phone,'status',c.caregiver_schedule_status)) FILTER (WHERE c.id IS NOT NULL),'[]'::jsonb) AS caregivers
       FROM athulya_schedules s LEFT JOIN athulya_schedule_caregivers c ON c.schedule_id=s.id
       WHERE s.organization_id=$1 AND ($2::date …16246 tokens truncated…", limit = 100 } = {}) {
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
       FROM attendance_call_attempts WHERE session_id=$1 AND stage=$2 ORDER BY created_at`, [id, stage],
    );
    const history = attempts.rows.map((row) => ({
      stage: row.stage, status: row.status, attemptNumber: row.attempt_number,
      scheduledAt: row.scheduled_at, answeredAt: row.answered_at, endedAt: row.ended_at,
      outcome: json(row.outcome),
    }));
    const task = stage === "check_in" ? session.checkInTask : session.checkOutTask;
    const taskResult = await this.pool.query(
      `SELECT active_context FROM attendance_stage_tasks WHERE assignment_session_id=$1 AND stage=$2`, [id, stage],
    );
    const context = json(taskResult.rows[0]?.active_context) || {};
    return {
      assignment: { id: session.assignmentId, scheduleVersion: session.scheduleVersion, ...(session.metadata || {}) },
      employee: session.employee,
      patient: session.patient,
      stage,
      scheduledStartAt: session.scheduledStartAt,
      scheduledEndAt: session.scheduledEndAt,
      priorCallStatus: history,
      stageTask: task,
      factsConfirmed: stage === "check_in"
        ? { checkIn: task?.status === "confirmed" ? context : {} }
        : { checkOut: task?.status === "confirmed" ? context : {} },
      requestedCallbackAt: context.nextCallAt || null,
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
      r = await client.query("SELECT * FROM appointment_call_attempts WHERE provider=$1 AND provider_call_id=$2 FOR UPDATE", [event.provider, event.providerCallId]);
      if (r.rows[0]) {
        const row = r.rows[0];
        const normalized = String(event.status || "").toLowerCase().replace(/[\s_-]+/g, "");
        const status = ["noanswer", "busy", "failed", "timeout", "canceled", "cancelled"].includes(normalized)
          ? "no_answer" : ["completed", "answered"].includes(normalized) ? "completed" : normalized === "inprogress" ? "in_progress" : "ringing";
        const effectiveStatus = row.status === "no_answer" ? "no_answer" : status;
        await client.query(
          `UPDATE appointment_call_attempts SET status=$2,ended_at=COALESCE($3,ended_at),duration_seconds=COALESCE($4,duration_seconds),
           answered_at=COALESCE(answered_at,$5),updated_at=NOW() WHERE id=$1`,
          [row.id, effectiveStatus, event.endedAt || null, event.durationSeconds || null, event.rawEvent?.AnswerTime || null],
        );
        await client.query("COMMIT");
        return { id: row.id, status: effectiveStatus, appointmentCall: true, inboundCallId: row.inbound_call_id, organizationId: row.organization_id,
          candidateIndex: row.candidate_index, recordingObjectKey: row.recording_object_key };
      }
      r = await client.query("SELECT * FROM call_records WHERE provider=$1 AND provider_call_id=$2 FOR UPDATE", [event.provider, event.providerCallId]);
      if (!r.rows[0]) {
        const inbound = await client.query("SELECT * FROM inbound_calls WHERE provider=$1 AND provider_call_id=$2 FOR UPDATE", [event.provider, event.providerCallId]);
        if (!inbound.rows[0]) { await client.query("COMMIT"); return null; }
        const state = String(event.status || "").toLowerCase().replace(/[\s_-]+/g, "");
        const inboundStatus = ({ queued: "ringing", initiated: "ringing", ringing: "ringing", answered: "in_progress",
          inprogress: "in_progress", completed: "completed", hangup: "completed", noanswer: "no_answer",
          busy: "failed", failed: "failed", canceled: "canceled", cancelled: "cancelled" })[state] || "failed";
        await client.query(
          `UPDATE inbound_calls SET status=$3,ended_at=COALESCE($4,ended_at),duration_seconds=COALESCE($5,duration_seconds),
           answered_at=COALESCE(answered_at,$6),updated_at=NOW() WHERE provider=$1 AND provider_call_id=$2`,
          [event.provider, event.providerCallId, inboundStatus, event.endedAt || null, event.durationSeconds || null, event.rawEvent?.AnswerTime || null],
        );
        await client.query("COMMIT");
        return { id: inbound.rows[0].id, status: inboundStatus, inboundCall: true };
      }
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
    const persistedContextPatch = { status, ...contextPatch };
    await this.pool.query(
      `WITH updated AS (
         UPDATE attendance_sessions SET ${column}=$2,
          active_context=jsonb_set(active_context, ARRAY[$3], COALESCE(active_context-> $3,'{}'::jsonb) || $4::jsonb, true), updated_at=NOW()
          WHERE id=$1 RETURNING organization_id
       )
       INSERT INTO attendance_audit_events (organization_id,session_id,event_type,event_data)
       SELECT organization_id,$1,'attendance.stage_status',$5::jsonb FROM updated`,
      [sessionId, status, stageKey, JSON.stringify(persistedContextPatch), JSON.stringify({ stage, status, ...contextPatch })],
    );
    const taskResult = await this.pool.query(
      `UPDATE attendance_stage_tasks SET status=$3,
        delivery_status=CASE WHEN $3='confirmed' AND delivery_status<>'delivered' THEN 'queued' ELSE delivery_status END,
        active_context=active_context || $4::jsonb,updated_at=NOW()
       WHERE assignment_session_id=$1 AND stage=$2 RETURNING id`,
      [sessionId, stage, status, JSON.stringify(persistedContextPatch)],
    );
    if (!taskResult.rowCount) throw new Error(`Independent ${stage} task is missing for assignment ${sessionId}`);
    if (status === "confirmed") {
      await this.pool.query(
        `UPDATE attendance_sessions s SET
           backend_delivery_status=CASE WHEN EXISTS (
             SELECT 1 FROM attendance_stage_tasks t WHERE t.assignment_session_id=s.id
               AND t.status='confirmed' AND t.delivery_status<>'delivered'
           ) THEN 'queued' ELSE 'delivered' END,
           backend_delivered_at=CASE WHEN EXISTS (
             SELECT 1 FROM attendance_stage_tasks t WHERE t.assignment_session_id=s.id
               AND t.status='confirmed' AND t.delivery_status<>'delivered'
           ) THEN NULL ELSE backend_delivered_at END,
           updated_at=NOW() WHERE s.id=$1`, [sessionId],
      );
      await this.pool.query(
        `INSERT INTO athulya_attendance_submissions (organization_id,schedule_id,caregiver_id,event_type,event_at,status,idempotency_key)
         SELECT s.organization_id,source.id,s.employee->>'id',$2,COALESCE($3::timestamptz,NOW()),'awaiting_api_specification',
           'attendance:'||s.id::text||':'||$2
         FROM attendance_sessions s JOIN athulya_schedules source ON source.organization_id=s.organization_id
           AND (source.athulya_schedule_id=s.external_assignment_id OR source.athulya_schedule_pk=s.external_assignment_id)
         JOIN athulya_schedule_caregivers caregiver ON caregiver.schedule_id=source.id AND caregiver.athulya_caregiver_id=s.employee->>'id'
         WHERE s.id=$1
         ON CONFLICT (organization_id,idempotency_key) DO NOTHING`,
        [sessionId, stage, contextPatch.reportedAt || null],
      );
    }
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
      tasks: [session.checkInTask, session.checkOutTask].filter(Boolean),
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
  async buildBackendAttendancePayload(sessionId, stage, callAttemptId) {
    const artifacts = await this.getSessionArtifacts(sessionId);
    if (!artifacts) return null;
    const task = artifacts.tasks.find((item) => item.stage === stage);
    if (!task || task.status !== "confirmed") return null;
    const callAttempt = artifacts.callAttempts.find((item) => item.id === callAttemptId && item.stage === stage);
    if (!callAttempt) return null;
    const transcript = artifacts.transcripts.find((item) => item.callAttemptId === callAttemptId) || null;
    return {
      eventType: stage,
      task,
      assignment: artifacts.session,
      callAttempt,
      transcript,
    };
  }
  async markBackendDelivered(sessionId, stage, response) {
    const updated = await this.pool.query(
      `UPDATE attendance_stage_tasks SET delivery_status='delivered',delivery_response=$3::jsonb,
          delivered_at=NOW(),updated_at=NOW()
       WHERE assignment_session_id=$1 AND stage=$2 AND status='confirmed' RETURNING organization_id`,
      [sessionId, stage, JSON.stringify(response || {})],
    );
    if (!updated.rowCount) return false;
    if (updated.rowCount) await this.pool.query(
      `UPDATE attendance_sessions s SET
         backend_delivery_status=CASE WHEN NOT EXISTS (
           SELECT 1 FROM attendance_stage_tasks t WHERE t.assignment_session_id=s.id
             AND t.status='confirmed' AND t.delivery_status<>'delivered'
         ) THEN 'delivered' ELSE 'queued' END,
         backend_delivery_response=$2::jsonb,
         backend_delivered_at=CASE WHEN NOT EXISTS (
           SELECT 1 FROM attendance_stage_tasks t WHERE t.assignment_session_id=s.id
             AND t.status='confirmed' AND t.delivery_status<>'delivered'
         ) THEN NOW() ELSE backend_delivered_at END,
         updated_at=NOW()
       WHERE s.id=$1`, [sessionId, JSON.stringify(response || {})],
    );
    await this.pool.query(
      `INSERT INTO attendance_audit_events (organization_id,session_id,event_type,event_data)
       SELECT organization_id,$1,'attendance.stage_backend_delivered',$2::jsonb
       FROM attendance_sessions WHERE id=$1`,
      [sessionId, JSON.stringify({ stage, status: response?.status || null })],
    );
    return true;
  }
}

module.exports = { PostgresRepository };
