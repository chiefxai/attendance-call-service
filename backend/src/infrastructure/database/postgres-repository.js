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
      `SELECT id,organization_id,email,display_name,password_salt,password_hash,active,role
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
      role: row.role || "admin",
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
      `UPDATE web_users u SET password_salt=$3,password_hash=$4,updated_at=NOW()
       FROM athulya_care_managers cm WHERE cm.app_user_id=u.id AND cm.organization_id=$1 AND cm.id=$2
       RETURNING u.id`, [organizationId, id, passwordSalt, passwordHash],
    );
    if (rows[0]) await this.pool.query("UPDATE web_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL", [rows[0].id]);
    return Boolean(rows[0]);
  }

  async getAthulyaIntegration(organizationId) {
    const { rows } = await this.pool.query(
      `SELECT integration_name AS "integrationName",api_base_url AS "apiBaseUrl",encrypted_api_key AS "encryptedApiKey",
        enabled,updated_at AS "updatedAt",
        (SELECT MAX(completed_at) FROM athulya_sync_runs WHERE organization_id=$1 AND status='succeeded') AS "lastSuccessfulScheduleSync",
        (SELECT MAX(updated_at) FROM athulya_attendance_submissions WHERE organization_id=$1 AND status='synced') AS "lastSuccessfulAttendanceSubmission"
       FROM athulya_integration_settings WHERE organization_id=$1`, [organizationId],
    );
    return rows[0] || { integrationName: "Athulya Platform", apiBaseUrl: "https://homecare.athulyaliving.net/api", encryptedApiKey: null, enabled: false, lastSuccessfulScheduleSync: null, lastSuccessfulAttendanceSubmission: null };
  }

  async saveAthulyaIntegration(organizationId, { integrationName, apiBaseUrl, encryptedApiKey, enabled, updatedBy }) {
    const { rows } = await this.pool.query(
      `INSERT INTO athulya_integration_settings (organization_id,integration_name,api_base_url,encrypted_api_key,enabled,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (organization_id) DO UPDATE SET
       integration_name=EXCLUDED.integration_name,api_base_url=EXCLUDED.api_base_url,
       encrypted_api_key=COALESCE(EXCLUDED.encrypted_api_key,athulya_integration_settings.encrypted_api_key),
       enabled=EXCLUDED.enabled,updated_by=EXCLUDED.updated_by,updated_at=NOW()
       RETURNING integration_name AS "integrationName",api_base_url AS "apiBaseUrl",encrypted_api_key AS "encryptedApiKey",enabled,updated_at AS "updatedAt",
       (SELECT MAX(completed_at) FROM athulya_sync_runs WHERE organization_id=$1 AND status='succeeded') AS "lastSuccessfulScheduleSync",
       (SELECT MAX(updated_at) FROM athulya_attendance_submissions WHERE organization_id=$1 AND status='synced') AS "lastSuccessfulAttendanceSubmission"`,
      [organizationId, integrationName, apiBaseUrl, encryptedApiKey || null, enabled, updatedBy || null],
    );
    return rows[0];
  }

  async createAthulyaSyncRun(organizationId, { fromDate, toDate, filters }) {
    const { rows } = await this.pool.query(
      `INSERT INTO athulya_sync_runs (organization_id,status,from_date,to_date,filters) VALUES ($1,'running',$2,$3,$4::jsonb) RETURNING id`,
      [organizationId, fromDate || null, toDate || null, JSON.stringify(filters || {})],
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
        const scheduleId = source.schedule_id == null ? null : String(source.schedule_id);
        const schedulePk = source.schedule_pk == null ? "" : String(source.schedule_pk);
        if (!scheduleId) continue;
        const patientId = source.patient_id == null ? "" : String(source.patient_id);
        if (patientId) await client.query(
          `INSERT INTO patient_directory (organization_id,external_id,name,phone_number,address,language,care_category,hub,athulya_patient_uhid,branch)
           VALUES ($1,$2,$3,NULL,'','ta',$4,$5,$6,$7) ON CONFLICT (organization_id,external_id) DO UPDATE SET
           name=CASE WHEN EXCLUDED.name<>'' THEN EXCLUDED.name ELSE patient_directory.name END,
           care_category=CASE WHEN EXCLUDED.care_category<>'' THEN EXCLUDED.care_category ELSE patient_directory.care_category END,
           hub=CASE WHEN EXCLUDED.hub<>'' THEN EXCLUDED.hub ELSE patient_directory.hub END,
           athulya_patient_uhid=CASE WHEN EXCLUDED.athulya_patient_uhid<>'' THEN EXCLUDED.athulya_patient_uhid ELSE patient_directory.athulya_patient_uhid END,
           branch=CASE WHEN EXCLUDED.branch<>'' THEN EXCLUDED.branch ELSE patient_directory.branch END,updated_at=NOW()`,
          [organizationId,patientId,String(source.client_name ?? ""),String(source.service_name ?? ""),String(source.branch ?? ""),String(source.patient_uhid ?? ""),String(source.branch ?? "")],
        );
        if (source.care_manager_id != null && source.care_manager_name) await client.query(
          `INSERT INTO athulya_care_managers (organization_id,athulya_care_manager_id,name,phone)
           VALUES ($1,$2,$3,$4) ON CONFLICT (organization_id,athulya_care_manager_id) DO UPDATE SET
           name=CASE WHEN EXCLUDED.name<>'' THEN EXCLUDED.name ELSE athulya_care_managers.name END,
           phone=COALESCE(NULLIF(EXCLUDED.phone,''),athulya_care_managers.phone),updated_at=NOW()`,
          [organizationId,String(source.care_manager_id),String(source.care_manager_name),source.care_manager_phone == null ? null : String(source.care_manager_phone)],
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
            [organizationId,caregiver.id,caregiver.name || "",String(source.vendor_company ?? "ATHULYA") || "ATHULYA",caregiver.phone || "",String(source.branch ?? "")],
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
          [organizationId,scheduleId,schedulePk,patientId,String(source.patient_uhid ?? ""),String(source.client_name ?? ""),
            String(source.care_manager_id ?? ""),String(source.care_manager_name ?? ""),String(source.care_manager_phone ?? ""),
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
       WHERE s.organization_id=$1 AND ($2::date IS NULL OR s.schedule_date >= $2::date) AND ($3::date IS NULL OR s.schedule_date <= $3::date)
       GROUP BY s.id ORDER BY s.schedule_date,s.start_time LIMIT $4`, [organizationId, fromDate || null, toDate || null, Math.min(Math.max(Number(limit) || 500,1),5000)],
    );
    return rows.map((row) => ({ id: row.id, athulyaScheduleId: row.athulya_schedule_id, athulyaSchedulePk: row.athulya_schedule_pk,
      patient: { id: row.patient_external_id, uhid: row.patient_uhid, name: row.patient_name }, careManager: { id: row.care_manager_external_id, name: row.care_manager_name, phone: row.care_manager_phone },
      date: row.schedule_date, startTime: row.start_time, endTime: row.end_time, status: row.schedule_status, service: row.service_name, carePlan: row.care_plan,
      branch: row.branch, vendorCompany: row.vendor_company, caregivers: json(row.caregivers) || [], lastSyncedAt: row.last_synced_at }));
  }

  async listAthulyaSyncRuns(organizationId, limit = 100) {
    const { rows } = await this.pool.query(
      `SELECT id,status,from_date AS "fromDate",to_date AS "toDate",filters,records_received AS "recordsReceived",records_upserted AS "recordsUpserted",error_message AS "errorMessage",started_at AS "startedAt",completed_at AS "completedAt"
       FROM athulya_sync_runs WHERE organization_id=$1 ORDER BY started_at DESC LIMIT $2`, [organizationId, Math.min(Number(limit) || 100,500)],
    );
    return rows;
  }

  async listAthulyaAttendanceSubmissions(organizationId, { eventType = "all", status = "all", fromDate = null, toDate = null, caregiverId = "", patientId = "", limit = 200 } = {}) {
    const { rows } = await this.pool.query(
      `SELECT e.id,e.event_type AS "eventType",e.event_at AS "eventAt",e.status,e.attempt_count AS "retryCount",
       e.response_code AS "responseCode",e.error_message AS "errorMessage",e.external_reference AS "externalReference",e.created_at AS "createdAt",
       s.athulya_schedule_id AS "scheduleId",s.patient_external_id AS "patientId",s.patient_name AS "patientName",c.caregiver_name AS "caregiverName"
       FROM athulya_attendance_submissions e LEFT JOIN athulya_schedules s ON s.id=e.schedule_id
       LEFT JOIN athulya_schedule_caregivers c ON c.schedule_id=s.id AND c.athulya_caregiver_id=e.caregiver_id
       WHERE e.organization_id=$1 AND ($2='all' OR e.event_type=$2) AND ($3='all' OR e.status=$3)
         AND ($4::timestamptz IS NULL OR e.event_at >= $4::timestamptz) AND ($5::timestamptz IS NULL OR e.event_at <= $5::timestamptz)
         AND ($6='' OR e.caregiver_id=$6) AND ($7='' OR s.patient_external_id=$7)
       ORDER BY e.created_at DESC LIMIT $8`, [organizationId,eventType,status,fromDate,toDate,caregiverId,patientId,Math.min(Number(limit) || 200,500)],
    );
    return rows;
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
       RETURNING u.id,u.organization_id,u.email,u.display_name,u.role`,
      [tokenHash],
    );
    const row = rows[0];
    return row ? { id: row.id, organizationId: row.organization_id, email: row.email, displayName: row.display_name, role: row.role || "admin" } : null;
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

  async listCareActivities(organizationId, { includeInactive = false } = {}) {
    const { rows } = await this.pool.query(
      `SELECT id,name,aliases,description,duration_minutes,active,created_at,updated_at
       FROM care_activities WHERE organization_id=$1 AND ($2::boolean OR active=TRUE)
       ORDER BY active DESC, lower(name)`, [organizationId, includeInactive],
    );
    return rows.map((row) => ({ id: row.id, name: row.name, aliases: row.aliases || [], description: row.description,
      durationMinutes: row.duration_minutes, active: row.active,
      createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  async createCareActivity(organizationId, activity) {
    const { rows } = await this.pool.query(
      `INSERT INTO care_activities (organization_id,name,aliases,description,duration_minutes)
       VALUES ($1,$2,$3,$4,$5) RETURNING id,name,aliases,description,duration_minutes,active,created_at,updated_at`,
      [organizationId, activity.name, activity.aliases || [], activity.description || "", activity.durationMinutes],
    );
    const row = rows[0];
    return { id: row.id, name: row.name, aliases: row.aliases || [], description: row.description, durationMinutes: row.duration_minutes,
      active: row.active, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  async updateCareActivity(organizationId, id, activity) {
    const { rows } = await this.pool.query(
      `UPDATE care_activities SET name=$3,aliases=$4,description=$5,duration_minutes=$6,active=$7,updated_at=NOW()
       WHERE organization_id=$1 AND id=$2
       RETURNING id,name,aliases,description,duration_minutes,active,created_at,updated_at`,
      [organizationId, id, activity.name, activity.aliases || [], activity.description || "", activity.durationMinutes, activity.active !== false],
    );
    const row = rows[0];
    return row ? { id: row.id, name: row.name, aliases: row.aliases || [], description: row.description, durationMinutes: row.duration_minutes,
      active: row.active, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }

  async findAvailableStaffForEnquiry({ organizationId, startAt, endAt, patientAddress, limit = 10 }) {
    const parts = String(patientAddress || "").split(" | ");
    const patientState = parts.length === 4 ? parts[0].trim() : "";
    const patientDistrict = parts.length === 4 ? parts[1].trim() : "";
    const { rows } = await this.pool.query(
      `SELECT d.external_id,d.name,d.company_name,d.phone_number,d.address,d.language,
         CASE
           WHEN $4<>'' AND split_part(d.address,' | ',2)<>'' AND lower(trim(split_part(d.address,' | ',2)))=lower($4) THEN 'same_district'
           WHEN $5<>'' AND split_part(d.address,' | ',1)<>'' AND lower(trim(split_part(d.address,' | ',1)))=lower($5) THEN 'same_region'
           ELSE 'other_region'
         END AS location_match
       FROM staff_directory d
       WHERE d.organization_id=$1 AND d.active=TRUE
         AND NOT EXISTS (
           SELECT 1 FROM attendance_sessions s
           WHERE s.organization_id=d.organization_id AND s.employee->>'id'=d.external_id
             AND s.scheduled_start_at < $3::timestamptz AND s.scheduled_end_at > $2::timestamptz
         )
       ORDER BY CASE
           WHEN $4<>'' AND split_part(d.address,' | ',2)<>'' AND lower(trim(split_part(d.address,' | ',2)))=lower($4) THEN 0
           WHEN $5<>'' AND split_part(d.address,' | ',1)<>'' AND lower(trim(split_part(d.address,' | ',1)))=lower($5) THEN 1
           ELSE 2 END,
         lower(d.name)
       LIMIT $6`,
      [organizationId, startAt, endAt, patientDistrict, patientState, Math.min(Math.max(Number(limit) || 10, 1), 10)],
    );
    return rows.map((row) => ({ id: row.external_id, name: row.name, companyName: row.company_name?.trim() || "ATHULYA", phoneNumber: row.phone_number, address: row.address,
      language: row.language, locationMatch: row.location_match }));
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

  async findEmployeeScheduleOverlap({ organizationId, employeeId, startAt, endAt, assignmentId }, client = this.pool) {
    const { rows } = await client.query(
      `SELECT external_assignment_id, patient->>'name' AS patient_name,
              scheduled_start_at, scheduled_end_at
       FROM attendance_sessions
       WHERE organization_id=$1
         AND employee->>'id'=$2
         AND ($5::text IS NULL OR external_assignment_id<>$5)
         AND tstzrange(scheduled_start_at, scheduled_end_at, '[)')
             && tstzrange($3::timestamptz, $4::timestamptz, '[)')
       ORDER BY scheduled_start_at
       LIMIT 1`,
      [organizationId, String(employeeId), startAt, endAt, assignmentId ? String(assignmentId) : null],
    );
    const row = rows[0];
    return row ? {
      assignmentId: row.external_assignment_id,
      patientName: row.patient_name || "Unknown patient",
      scheduledStartAt: row.scheduled_start_at,
      scheduledEndAt: row.scheduled_end_at,
    } : null;
  }

  async assertEmployeeScheduleAvailable(assignment, client = this.pool) {
    const lockKey = `${assignment.organizationId}:employee:${assignment.employee.id}`;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
    const conflict = await this.findEmployeeScheduleOverlap({
      organizationId: assignment.organizationId,
      employeeId: assignment.employee.id,
      startAt: assignment.scheduledStartAt,
      endAt: assignment.scheduledEndAt,
      assignmentId: assignment.assignmentId,
    }, client);
    if (conflict) {
      const error = new Error(
        `This employee already has assignment ${conflict.assignmentId} for ${conflict.patientName} during the selected duty window.`,
      );
      error.status = 409;
      error.code = "EMPLOYEE_SCHEDULE_OVERLAP";
      error.conflict = conflict;
      throw error;
    }
  }

  async findPatientContactByPhone(organizationId, phoneNumber) {
    const digits = String(phoneNumber || "").replace(/\\D/g, "");
    const national = digits.length > 10 && digits.startsWith("91") ? digits.slice(-10) : digits;
    if (national.length !== 10) return null;
    const { rows } = await this.pool.query(
      `SELECT external_id,name,phone_number,address,language,care_category,hub
       FROM patient_directory WHERE organization_id=$1 AND active=TRUE
         AND RIGHT(regexp_replace(COALESCE(phone_number,''), '[^0-9]', '', 'g'),10)=$2
       ORDER BY updated_at DESC LIMIT 2`, [organizationId, national],
    );
    if (rows.length !== 1) return null;
    const row = rows[0];
    return { id: row.external_id, name: row.name, phoneNumber: row.phone_number,
      address: row.address, language: row.language || "en", careCategory: row.care_category || "", hub: row.hub || "" };
  }

  async createInboundCall(call) {
    const retentionDays = Math.min(Math.max(Number(process.env.DATA_RETENTION_DAYS) || 90, 1), 3650);
    const { rows } = await this.pool.query(
      `INSERT INTO inbound_calls
       (organization_id,provider,provider_call_id,from_number,to_number,patient_id,patient_context,agent_id,language,status,enquiry_status,retention_expires_at)
       VALUES ($1,'vobiz',$2,$3,$4,$5,$6::jsonb,$7,$8,'ringing','processing',NOW()+($9 * INTERVAL '1 day'))
       ON CONFLICT (provider,provider_call_id) DO UPDATE SET provider_call_id=EXCLUDED.provider_call_id
       RETURNING *`, [call.organizationId, call.providerCallId, call.fromNumber, call.toNumber || null,
        call.patient?.id || null, JSON.stringify(call.patient || {}), call.agentId || null,
        call.language || call.patient?.language || "en", retentionDays],
    );
    return this.mapInboundCall(rows[0]);
  }

  mapInboundCall(row) {
    if (!row) return null;
    return { id: row.id, organizationId: row.organization_id, providerCallId: row.provider_call_id,
      fromNumber: row.from_number, toNumber: row.to_number, patientId: row.patient_id,
      patient: json(row.patient_context), agentId: row.agent_id, language: row.language,
      status: row.status, recordingObjectKey: row.recording_object_key,
      recordingContentType: row.recording_content_type, transcript: row.transcript,
      transcriptLanguage: row.transcript_language, enquiryAnalysisStatus: row.enquiry_analysis_status || "pending",
      enquiryStatus: row.enquiry_status || "processing", resolvedStaff: json(row.resolved_staff), resolvedAt: row.resolved_at,
      enquiryAnalysis: json(row.enquiry_analysis) || {}, staffSuggestions: json(row.staff_suggestions) || [],
      bookingStatus: row.booking_status || "not_started",
      bookingScheduleSessionId: row.booking_schedule_session_id || null,
      bookingStaff: json(row.booking_staff) || null,
      bookingUpdatedAt: row.booking_updated_at || null,
      startedAt: row.started_at, answeredAt: row.answered_at, endedAt: row.ended_at,
      durationSeconds: row.duration_seconds };
  }

  async getInboundCall(id, organizationId) {
    const { rows } = await this.pool.query(
      "SELECT * FROM inbound_calls WHERE id=$1 AND organization_id=$2 AND retention_expires_at>NOW()", [id, organizationId],
    );
    return this.mapInboundCall(rows[0]);
  }

  async listAppointmentCallAttempts(inboundCallId, organizationId) {
    const { rows } = await this.pool.query(
      `SELECT a.* FROM appointment_call_attempts a
       JOIN inbound_calls i ON i.id=a.inbound_call_id
       WHERE a.inbound_call_id=$1 AND a.organization_id=$2 AND i.retention_expires_at>NOW()
       ORDER BY a.candidate_index`, [inboundCallId, organizationId],
    );
    return rows.map((row) => ({ id: row.id, candidateIndex: row.candidate_index, staff: json(row.staff_context),
      providerCallId: row.provider_call_id, status: row.status, answeredAt: row.answered_at, endedAt: row.ended_at,
      durationSeconds: row.duration_seconds, transcript: row.transcript, outcome: json(row.outcome), recordingObjectKey: row.recording_object_key }));
  }

  async getAppointmentCallAttempt(id) {
    const { rows } = await this.pool.query("SELECT * FROM appointment_call_attempts WHERE id=$1", [id]);
    const row = rows[0];
    return row ? { id: row.id, organizationId: row.organization_id, inboundCallId: row.inbound_call_id,
      candidateIndex: row.candidate_index, staff: json(row.staff_context), agentId: row.agent_id, providerCallId: row.provider_call_id,
      status: row.status, answeredAt: row.answered_at, endedAt: row.ended_at, durationSeconds: row.duration_seconds,
      recordingObjectKey: row.recording_object_key, recordingContentType: row.recording_content_type,
      transcript: row.transcript, outcome: json(row.outcome), streamClaimedAt: row.stream_claimed_at } : null;
  }

  async createAppointmentCallAttempt({ inboundCallId, organizationId, candidateIndex, staff, agentId }) {
    const { rows } = await this.pool.query(
      `INSERT INTO appointment_call_attempts (organization_id,inbound_call_id,candidate_index,staff_context,agent_id,status)
       VALUES ($1,$2,$3,$4::jsonb,$5,'placing') ON CONFLICT (inbound_call_id,candidate_index)
       DO UPDATE SET updated_at=NOW() WHERE appointment_call_attempts.status IN ('placing','failed')
       RETURNING *`, [organizationId, inboundCallId, candidateIndex, JSON.stringify(staff), agentId],
    );
    if (!rows[0]) return null;
    const row = rows[0];
    return { id: row.id, organizationId: row.organization_id, inboundCallId: row.inbound_call_id,
      candidateIndex: row.candidate_index, staff: json(row.staff_context), agentId: row.agent_id, providerCallId: row.provider_call_id, status: row.status };
  }

  async attachAppointmentProviderCallId(id, providerCallId) {
    await this.pool.query("UPDATE appointment_call_attempts SET provider_call_id=$2,status=CASE WHEN status='placing' THEN 'ringing' ELSE status END,updated_at=NOW() WHERE id=$1", [id, providerCallId]);
  }

  async markAppointmentCallFailed(id, reason) {
    await this.pool.query("UPDATE appointment_call_attempts SET status='failed',outcome=outcome || $2::jsonb,updated_at=NOW() WHERE id=$1",
      [id, JSON.stringify({ placementError: String(reason || "call placement failed").slice(0, 300) })]);
  }

  async markAppointmentCallNoAnswer(id) {
    await this.pool.query("UPDATE appointment_call_attempts SET status='no_answer',ended_at=COALESCE(ended_at,NOW()),updated_at=NOW() WHERE id=$1 AND status IN ('ringing','in_progress')", [id]);
  }

  async claimAppointmentCallStream(id) {
    const { rowCount } = await this.pool.query(
      `UPDATE appointment_call_attempts SET stream_claimed_at=NOW(),status='in_progress',answered_at=COALESCE(answered_at,NOW()),updated_at=NOW()
       WHERE id=$1 AND stream_claimed_at IS NULL AND status IN ('placing','ringing','in_progress')`, [id]);
    return rowCount === 1;
  }

  async saveAppointmentCallRecording(id, objectKey, contentType = "audio/wav") {
    await this.pool.query("UPDATE appointment_call_attempts SET recording_object_key=$2,recording_content_type=$3,updated_at=NOW() WHERE id=$1", [id, objectKey, contentType]);
  }

  async saveAppointmentCallTranscript(id, transcript, outcome = {}) {
    const status = outcome?.outcome === "available_confirmed" ? "confirmed"
      : outcome?.outcome === "unavailable" ? "unavailable" : "completed";
    await this.pool.query("UPDATE appointment_call_attempts SET transcript=$2,outcome=$3::jsonb,status=$4,updated_at=NOW() WHERE id=$1",
      [id, transcript, JSON.stringify(outcome || {}), status]);
  }

  async getAppointmentCallContext(id) {
    const { rows } = await this.pool.query(
      `SELECT a.*, i.organization_id AS enquiry_org, i.patient_context, i.patient_id, i.from_number AS caller_number,
              i.language AS enquiry_language, i.enquiry_analysis, i.agent_id AS patient_agent_id, i.staff_suggestions,
              i.retention_expires_at
       FROM appointment_call_attempts a JOIN inbound_calls i ON i.id=a.inbound_call_id
       WHERE a.id=$1 AND i.retention_expires_at>NOW()`, [id],
    );
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, organizationId: row.organization_id, inboundCallId: row.inbound_call_id, agentId: row.agent_id,
      candidateIndex: row.candidate_index, staff: json(row.staff_context), providerCallId: row.provider_call_id,
      status: row.status, recordingObjectKey: row.recording_object_key, recordingContentType: row.recording_content_type,
      patient: json(row.patient_context) || {}, patientId: row.patient_id, callerNumber: row.caller_number,
      language: row.enquiry_language || "en", analysis: json(row.enquiry_analysis) || {},
      patientAgentId: row.patient_agent_id, staffSuggestions: json(row.staff_suggestions) || [] };
  }

  async getActiveAppointmentCallAttemptByProvider(provider, providerCallId) {
    const { rows } = await this.pool.query(
      "SELECT id FROM appointment_call_attempts WHERE provider=$1 AND provider_call_id=$2", [provider, providerCallId]);
    return rows[0] ? this.getAppointmentCallContext(rows[0].id) : null;
  }

  async saveAppointmentAttendanceSchedule({ inboundCallId, organizationId, staff, attendanceAgent, fromNumber }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        "SELECT * FROM inbound_calls WHERE id=$1 AND organization_id=$2 AND retention_expires_at>NOW() FOR UPDATE",
        [inboundCallId, organizationId]);
      const enquiry = rows[0];
      if (!enquiry) throw Object.assign(new Error("Enquiry not found"), { status: 404 });
      if (enquiry.booking_schedule_session_id) {
        const existing = await client.query("SELECT * FROM attendance_sessions WHERE id=$1", [enquiry.booking_schedule_session_id]);
        await client.query("COMMIT");
        return this.mapSession(existing.rows[0]);
      }
      const analysis = json(enquiry.enquiry_analysis) || {};
      const start = new Date(analysis.requestedStartAt);
      const suppliedEnd = new Date(analysis.requestedEndAt);
      const end = Number.isFinite(suppliedEnd.getTime())
        ? suppliedEnd
        : Number(analysis.durationMinutes) > 0 && Number.isFinite(start.getTime())
          ? new Date(start.getTime() + Number(analysis.durationMinutes) * 60_000)
          : suppliedEnd;
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
        throw Object.assign(new Error("Enquiry does not have a valid requested care window"), { status: 409 });
      }
      const patient = json(enquiry.patient_context) || {};
      const employee = { id: staff.id, name: staff.name, companyName: staff.companyName?.trim() || "ATHULYA", phoneNumber: staff.phoneNumber, address: staff.address || "" };
      await this.assertEmployeeScheduleAvailable({ organizationId, employee, scheduledStartAt: start, scheduledEndAt: end }, client);
      await this.createStaffDirectoryRecord(organizationId, { ...employee, language: staff.language || enquiry.language }, client);
      const session = await this.createAttendanceSession({
        organizationId, assignmentId: `enquiry-${inboundCallId}`, scheduleVersion: "1", agentId: attendanceAgent.id,
        language: staff.language || enquiry.language || attendanceAgent.language || "en", fromNumber,
        employee, patient: { ...patient, id: patient.id || enquiry.patient_id, name: patient.name || "Caller", phoneNumber: enquiry.caller_number },
        scheduledStartAt: start, scheduledEndAt: end,
        metadata: { source: "patient_enquiry_appointment_booking", inboundCallId, activityId: analysis.activityId,
          activityName: analysis.activityName, needsSummary: analysis.needsSummary },
      }, client);
      await client.query(
        `UPDATE inbound_calls SET booking_status='scheduled',booking_staff=$3::jsonb,booking_schedule_session_id=$4,
         booking_updated_at=NOW(),enquiry_status='resolved',resolved_staff=$3::jsonb,resolved_at=NOW(),updated_at=NOW()
         WHERE id=$1 AND organization_id=$2`, [inboundCallId, organizationId, JSON.stringify(employee), session.id]);
      await client.query("COMMIT");
      return session;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async setEnquiryBookingStatus(id, organizationId, status, { staff = null, sessionId = null } = {}) {
    const allowed = new Set(["not_started", "calling", "scheduled", "not_answered", "no_staff_available", "needs_review"]);
    if (!allowed.has(status)) throw new Error("Invalid appointment booking status");
    const { rows } = await this.pool.query(
      `UPDATE inbound_calls SET booking_status=$3,booking_staff=COALESCE($4::jsonb,booking_staff),
       booking_schedule_session_id=COALESCE($5::uuid,booking_schedule_session_id),booking_updated_at=NOW(),updated_at=NOW()
       WHERE id=$1 AND organization_id=$2 RETURNING *`,
      [id, organizationId, status, staff ? JSON.stringify(staff) : null, sessionId],
    );
    return this.mapInboundCall(rows[0]);
  }

  async getActiveStaffDirectoryRecord(organizationId, staffId) {
    const { rows } = await this.pool.query(
      `SELECT external_id,name,company_name,phone_number,address,language
       FROM staff_directory WHERE organization_id=$1 AND external_id=$2 AND active=TRUE`,
      [organizationId, staffId],
    );
    const row = rows[0];
    return row ? { id: row.external_id, name: row.name, companyName: row.company_name?.trim() || "ATHULYA",
      phoneNumber: row.phone_number, address: row.address || "", language: row.language || "en" } : null;
  }

  async listInboundCalls(organizationId, limit = 100) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const { rows } = await this.pool.query(
      "SELECT * FROM inbound_calls WHERE organization_id=$1 AND retention_expires_at>NOW() ORDER BY started_at DESC LIMIT $2",
      [organizationId, safeLimit],
    );
    return rows.map((row) => this.mapInboundCall(row));
  }

  async claimInboundCallStream(id) {
    const { rowCount } = await this.pool.query(
      `UPDATE inbound_calls SET stream_claimed_at=NOW(),answered_at=COALESCE(answered_at,NOW()),status='in_progress'
       WHERE id=$1 AND stream_claimed_at IS NULL AND status IN ('ringing','in_progress')`, [id],
    );
    return rowCount === 1;
  }

  async finishInboundCall(id, { status = "completed", endedAt = new Date(), durationSeconds = null } = {}) {
    await this.pool.query(
      `UPDATE inbound_calls SET status=$2,ended_at=COALESCE(ended_at,$3),duration_seconds=COALESCE($4,duration_seconds),updated_at=NOW() WHERE id=$1`,
      [id, status, endedAt, durationSeconds],
    );
  }

  async saveInboundCallRecording(id, objectKey, contentType) {
    await this.pool.query(
      "UPDATE inbound_calls SET recording_object_key=$2,recording_content_type=$3,updated_at=NOW() WHERE id=$1",
      [id, objectKey, contentType || "audio/wav"],
    );
  }

  async saveInboundCallTranscript(id, transcript, organizationId) {
    await this.pool.query(
      "UPDATE inbound_calls SET transcript=$2,transcript_language=$3,transcribed_at=NOW(),enquiry_analysis_status='processing',enquiry_status='processing',updated_at=NOW() WHERE id=$1 AND organization_id=$4",
      [id, transcript.text, transcript.language || null, organizationId],
    );
  }

  async saveInboundEnquiryAnalysis(id, { organizationId, status = "processing", analysis = {}, staffSuggestions = [] } = {}) {
    const allowedStatuses = new Set(["processing", "need_review", "suggestion", "shortage", "resolved"]);
    if (!allowedStatuses.has(status)) throw new Error("Invalid enquiry status");
    await this.pool.query(
      `UPDATE inbound_calls SET enquiry_status=$2,enquiry_analysis_status=$3,enquiry_analysis=$4::jsonb,
       staff_suggestions=$5::jsonb,updated_at=NOW() WHERE id=$1 AND organization_id=$6 AND enquiry_status<>'resolved'`,
      [id, status, status === "processing" ? "processing" : status === "need_review" ? "needs_details" : "complete",
        JSON.stringify(analysis || {}), JSON.stringify(staffSuggestions || []), organizationId],
    );
  }

  async resolveInboundEnquiry(id, organizationId, staffId) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const enquiryResult = await client.query(
        "SELECT enquiry_status FROM inbound_calls WHERE id=$1 AND organization_id=$2 AND retention_expires_at>NOW() FOR UPDATE",
        [id, organizationId],
      );
      if (!enquiryResult.rowCount) {
        await client.query("COMMIT");
        return null;
      }
      if (!["need_review", "suggestion", "shortage"].includes(enquiryResult.rows[0].enquiry_status)) {
        const error = new Error("Only enquiries needing review or staff assignment can be resolved");
        error.status = 409;
        throw error;
      }
      const staffResult = await client.query(
        `SELECT external_id,name,company_name,phone_number,address,language,branch FROM staff_directory
         WHERE organization_id=$1 AND external_id=$2 AND active=TRUE FOR SHARE`, [organizationId, staffId],
      );
      if (!staffResult.rowCount) {
        const error = new Error("Selected staff member is not active in this organization");
        error.status = 400;
        throw error;
      }
      const staff = staffResult.rows[0];
      const result = await client.query(
        `UPDATE inbound_calls SET enquiry_status='resolved',resolved_staff=$3::jsonb,resolved_at=NOW(),updated_at=NOW()
         WHERE id=$1 AND organization_id=$2
         RETURNING *`,
        [id, organizationId, JSON.stringify({ id: staff.external_id, name: staff.name, companyName: staff.company_name?.trim() || "ATHULYA", phoneNumber: staff.phone_number,
          address: staff.address || "", language: staff.language || "en" })],
      );
      await client.query("COMMIT");
      return this.mapInboundCall(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listExpiredInboundCalls(limit = 100) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const { rows } = await this.pool.query(
      `SELECT i.id,i.recording_object_key,COALESCE(array_agg(a.recording_object_key) FILTER (WHERE a.recording_object_key IS NOT NULL),'{}') AS appointment_recording_keys
       FROM inbound_calls i LEFT JOIN appointment_call_attempts a ON a.inbound_call_id=i.id
       WHERE i.retention_expires_at<=NOW() GROUP BY i.id ORDER BY MIN(i.retention_expires_at) LIMIT $1`,
      [safeLimit],
    );
    return rows.map((row) => ({ id: row.id, recordingObjectKey: row.recording_object_key, appointmentRecordingKeys: row.appointment_recording_keys || [] }));
  }

  async deleteExpiredInboundCall(id) {
    const { rowCount } = await this.pool.query("DELETE FROM inbound_calls WHERE id=$1 AND retention_expires_at<=NOW()", [id]);
    return rowCount === 1;
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
      employee: { id: employee.id || null, name: employee.name || "Unknown staff", companyName: employee.companyName || "ATHULYA", phoneMasked: this.maskPhone(employee.phoneNumber) },
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
    const [sessions, calls, jobs, workforce] = await Promise.all([
      this.pool.query(
        `WITH bounds AS (SELECT date_trunc('day', NOW() AT TIME ZONE $2) AT TIME ZONE $2 AS day_start)
         SELECT
           COUNT(*) FILTER (WHERE scheduled_start_at >= bounds.day_start AND scheduled_start_at < bounds.day_start + INTERVAL '1 day')::int AS scheduled_today,
           COUNT(*) FILTER (WHERE check_in_status='confirmed' AND scheduled_start_at >= bounds.day_start AND scheduled_start_at < bounds.day_start + INTERVAL '1 day')::int AS check_ins_confirmed,
           COUNT(*) FILTER (WHERE check_out_status='confirmed' AND scheduled_start_at >= bounds.day_start AND scheduled_start_at < bounds.day_start + INTERVAL '1 day')::int AS check_outs_confirmed,
           COUNT(*) FILTER (WHERE check_in_status IN ('scheduled','calling','processing','follow_up') AND scheduled_start_at >= bounds.day_start AND scheduled_start_at < bounds.day_start + INTERVAL '1 day')::int AS check_ins_pending,
           COUNT(*) FILTER (WHERE check_out_status IN ('scheduled','calling','processing','follow_up') AND scheduled_start_at >= bounds.day_start AND scheduled_start_at < bounds.day_start + INTERVAL '1 day')::int AS check_outs_pending,
           COUNT(*) FILTER (WHERE check_in_status IN ('not_answered','missed','review') OR check_out_status IN ('not_answered','missed','review'))::int AS exceptions
           ,COUNT(*) FILTER (WHERE session_status='completed')::int AS completed_schedules
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
      this.pool.query(
        `SELECT (SELECT COUNT(*)::int FROM staff_directory WHERE organization_id=$1 AND active=TRUE) AS caregivers,
          (SELECT COUNT(*)::int FROM patient_directory WHERE organization_id=$1 AND active=TRUE) AS patients,
          (SELECT COUNT(*)::int FROM athulya_care_managers WHERE organization_id=$1 AND active=TRUE AND app_user_id IS NOT NULL) AS care_managers`, [organizationId],
      ),
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
      completedSchedules: s.completed_schedules || 0,
      callsToday: c.calls_today || 0,
      activeCalls: c.active_calls || 0,
      completedCalls: c.completed_calls || 0,
      averageDurationSeconds: c.average_duration_seconds || 0,
      callsWaiting: jobs.rows[0]?.waiting || 0,
      maxConcurrentCalls: Number(process.env.MAX_CONCURRENT_CALLS) || 20,
      careManagers: workforce.rows[0]?.care_managers || 0,
      caregivers: workforce.rows[0]?.caregivers || 0,
      patients: workforce.rows[0]?.patients || 0,
    };
  }
  async createStaffDirectoryRecord(organizationId, person, client = this.pool) {
    const { rows } = await client.query(
      `INSERT INTO staff_directory (organization_id,external_id,name,company_name,phone_number,address,language)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (organization_id,external_id) DO NOTHING
       RETURNING external_id,name,company_name,phone_number,address,language`,
      [organizationId, person.id, person.name, person.companyName?.trim() || "ATHULYA", person.phoneNumber, person.address, person.language || "en"],
    );
    const row = rows[0];
    return row ? {
      id: row.external_id, name: row.name, companyName: row.company_name?.trim() || "ATHULYA", phoneNumber: row.phone_number,
      phoneMasked: this.maskPhone(row.phone_number), address: row.address, language: row.language,
      patientName: "Unassigned", patientId: null, dutyStatus: "unassigned", assignmentId: "—", sessionId: "", scheduledStartAt: null, scheduledEndAt: null,
    } : null;
  }

  async updateStaffDirectoryRecord(organizationId, person) {
    const { rows } = await this.pool.query(
      `INSERT INTO staff_directory (organization_id,external_id,name,company_name,phone_number,address,language,active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
       ON CONFLICT (organization_id,external_id) DO UPDATE SET
         name=EXCLUDED.name, company_name=EXCLUDED.company_name, phone_number=EXCLUDED.phone_number, address=EXCLUDED.address,
         language=EXCLUDED.language, active=TRUE, updated_at=NOW()
       RETURNING external_id,name,company_name,phone_number,address,language`,
      [organizationId, person.id, person.name, person.companyName?.trim() || "ATHULYA", person.phoneNumber, person.address, person.language || "en"],
    );
    const row = rows[0];
    return row ? {
      id: row.external_id, name: row.name, companyName: row.company_name?.trim() || "ATHULYA", phoneNumber: row.phone_number,
      phoneMasked: this.maskPhone(row.phone_number), address: row.address, language: row.language,
      patientName: "Unassigned", patientId: null, dutyStatus: "unassigned", assignmentId: "—", sessionId: "", scheduledStartAt: null, scheduledEndAt: null,
    } : null;
  }

  async createPatientDirectoryRecord(organizationId, patient, client = this.pool) {
    const { rows } = await client.query(
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
      patientUhid: row.athulya_patient_uhid || "", branch: row.branch || "",
      language: row.language, assignedStaff: "Unassigned", employeeId: null,
      careCategory: row.care_category || "Not specified", hub: row.hub || "Not specified",
      locationVerification: "not_integrated", status: "unassigned",
    } : null;
  }

  async updatePatientDirectoryRecord(organizationId, patient) {
    const { rows } = await this.pool.query(
      `INSERT INTO patient_directory (organization_id,external_id,name,phone_number,address,language,care_category,hub,active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)
       ON CONFLICT (organization_id,external_id) DO UPDATE SET
         name=EXCLUDED.name, phone_number=EXCLUDED.phone_number, address=EXCLUDED.address,
         language=EXCLUDED.language, care_category=EXCLUDED.care_category, hub=EXCLUDED.hub,
         active=TRUE, updated_at=NOW()
       RETURNING external_id,name,phone_number,address,language,care_category,hub`,
      [organizationId, patient.id, patient.name, patient.phoneNumber || null, patient.address,
        patient.language || "en", patient.careCategory || "", patient.hub || ""],
    );
    const row = rows[0];
    return row ? {
      id: row.external_id, name: row.name, phoneNumber: row.phone_number, address: row.address,
      patientUhid: row.athulya_patient_uhid || "", branch: row.branch || "",
      language: row.language, assignedStaff: "Unassigned", employeeId: null,
      careCategory: row.care_category || "Not specified", hub: row.hub || "Not specified",
      locationVerification: "not_integrated", status: "unassigned",
    } : null;
  }

  async listStaffDirectory(organizationId, { search = "", status = "all", limit = 100 } = {}) {
    const [profiles, sessions] = await Promise.all([
      this.pool.query(
        `SELECT external_id,name,company_name,phone_number,address,language,branch FROM staff_directory
         WHERE organization_id=$1 AND active=TRUE ORDER BY lower(name)`,
        [organizationId],
      ),
      this.listAttendanceSessions(organizationId, { limit: 500 }),
    ]);
    const records = new Map();
    for (const row of profiles.rows) {
      records.set(row.external_id, {
        id: row.external_id, name: row.name, companyName: row.company_name?.trim() || "ATHULYA", branch: row.branch || "", phoneNumber: row.phone_number,
        phoneMasked: this.maskPhone(row.phone_number), address: row.address || "", language: row.language,
        patientName: "Unassigned", patientId: null, dutyStatus: "unassigned", assignmentId: "—", sessionId: "", scheduledStartAt: null, scheduledEndAt: null,
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
        companyName: previous?.companyName?.trim() || person.companyName?.trim() || "ATHULYA",
        branch: previous?.branch || "",
        phoneNumber: previous?.phoneNumber || person.phoneNumber || null,
        phoneMasked: previous?.phoneMasked || this.maskPhone(person.phoneNumber),
        address: previous?.address || person.address || "",
        language: previous?.language || session.language,
        patientName: session.patient.name,
        patientId: session.patient.id,
        dutyStatus: state,
        assignmentId: session.assignmentId,
        sessionId: session.sessionId,
        scheduledStartAt: session.scheduledStartAt,
        scheduledEndAt: session.scheduledEndAt,
      });
    }
    return [...records.values()]
      .filter((record) => (status === "all" || status === record.dutyStatus)
        && (!search || `${record.id} ${record.name} ${record.companyName} ${record.patientName} ${record.address}`.toLowerCase().includes(search.toLowerCase())))
      .slice(0, Math.min(Number(limit) || 100, 500));
  }

  async listPatientDirectory(organizationId, { search = "", status = "all", limit = 100 } = {}) {
    const [profiles, sessions] = await Promise.all([
      this.pool.query(
        `SELECT external_id,name,phone_number,address,language,care_category,hub,athulya_patient_uhid,branch FROM patient_directory
         WHERE organization_id=$1 AND active=TRUE ORDER BY lower(name)`,
        [organizationId],
      ),
      this.listAttendanceSessions(organizationId, { limit: 500 }),
    ]);
    const records = new Map();
    for (const row of profiles.rows) {
      records.set(row.external_id, {
        id: row.external_id, name: row.name, patientUhid: row.athulya_patient_uhid || "", branch: row.branch || "", phoneNumber: row.phone_number, address: row.address || "",
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
        patientUhid: previous?.patientUhid || "",
        branch: previous?.branch || metadata.branch || "",
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
    if (status === "confirmed") {
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
