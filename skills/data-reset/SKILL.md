---
name: attendance-data-reset
description: Safely clear attendance-call-service data on the Athulya VM. Use when asked to clear, reset, or remove imported attendance, patient, caregiver/staff, or care-manager data. Distinguishes attendance-only resets from directory/account resets and preserves admin accounts and service configuration unless explicitly requested.
---

# Safely reset service data

Use this skill when the user asks to clear or reset data in the production attendance-call service. The VM is not directly accessible from this workspace; provide commands for the user to run there unless an explicitly authorized VM tool is available. Never claim a remote reset succeeded without observing its result.

## 1. Establish scope from the request

- **Attendance-only reset:** clear schedules imported from Athulya, attendance sessions and attempts, transcripts, jobs, call logs, notifications, submissions, and recording objects. Keep patient, staff, care-manager directory rows, care-manager accounts, admin accounts, agents, API keys, settings, and integrations.
- **Directory reset:** clear patient and staff directories plus imported care-manager rows. Remove care-manager login accounts and sessions if the user asks to clear care-manager data. Preserve admin accounts and operational configuration.
- **Full service reset:** do not assume this means deleting credentials, configuration, or storage volumes. Clarify destructive scope if it is not explicit. Never recommend `docker compose down -v` as a shortcut; it can destroy the database and object store indiscriminately.

Do not repeat a scope question already answered in the conversation. State which records and accounts the proposed reset will remove before giving the destructive command.

## 2. Verify deployment and schema

Use the VM checkout and both Compose files used by this deployment:

```sh
cd ~/attendance-call-service-deploy-1ac81d5
sudo docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.vertex-credentials.yml ps
```

Do not print `.env`, credentials, patient/staff rows, call transcripts, or object contents. If table names or relations are uncertain, inspect only table/schema metadata with `\dt`, `\d <table>`, or `information_schema`; do not guess table names or delete by broad patterns.

Known production table names include:

- Attendance/import data: `attendance_sessions`, `attendance_call_attempts`, `attendance_stage_tasks`, `attendance_transcripts`, `attendance_jobs`, `attendance_audit_events`, `outbound_call_slots`, `call_records`, `appointment_call_attempts`, `inbound_calls`, `care_manager_notifications`, `athulya_attendance_submissions`, `athulya_schedule_caregivers`, `athulya_schedules`, `athulya_sync_runs`.
- Directories: `patient_directory`, `staff_directory`, `athulya_care_managers`.
- Web authentication: `web_users`, `web_sessions`.

Confirm these names against the live database before running destructive SQL if a deployment may have changed.

## 3. Stop workers and API before clearing

Use the deployment's Compose configuration:

```sh
sudo docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.vertex-credentials.yml \
  stop backend-api backend-worker
```

This prevents active jobs or syncs from recreating rows during the reset. Keep PostgreSQL and MinIO running.

## 4. Attendance-only reset

After verifying the table list and that the user wants attendance-only cleanup, run the database changes in one transaction. The established dependency-safe order is:

```sql
BEGIN;
TRUNCATE TABLE
  attendance_transcripts,
  attendance_audit_events,
  outbound_call_slots,
  attendance_call_attempts,
  attendance_stage_tasks,
  attendance_sessions,
  attendance_jobs,
  call_records,
  appointment_call_attempts,
  inbound_calls,
  care_manager_notifications,
  athulya_attendance_submissions,
  athulya_schedule_caregivers,
  athulya_schedules,
  athulya_sync_runs
RESTART IDENTITY;
COMMIT;
```

Clear recording objects only if the user included recordings in the requested reset. Use the configured MinIO bucket and the service's recording prefix; verify the exact prefix first. An empty prefix may cause the MinIO client to return a harmless “object does not exist” error. Do not use bucket-wide deletion unless the user explicitly requests it.

## 5. Directory and care-manager reset

For a request that explicitly includes patient, staff/caregiver, and care-manager records, the live schema has these relationships:

- `athulya_care_managers.app_user_id` references `web_users.id` with `ON DELETE SET NULL`.
- `web_sessions.user_id` references `web_users.id` with `ON DELETE CASCADE`.
- `care_manager_notifications.user_id` cascades on user deletion; its care-manager reference becomes null on manager deletion.
- `web_users.role` is constrained to `admin` or `care_manager`.

Thus removing only `athulya_care_managers` leaves care-manager accounts behind. Remove care-manager accounts by role, which cascades their sessions, while preserving admin rows. Remove the directories and manager rows in one transaction:

```sql
BEGIN;
DELETE FROM web_users WHERE role = 'care_manager';
DELETE FROM athulya_care_managers;
DELETE FROM patient_directory;
DELETE FROM staff_directory;
COMMIT;
```

If foreign-key constraints fail, stop and inspect the reported relationship; do not add `CASCADE` blindly. Ensure any attendance records that reference directories have been cleared first. Do not delete `web_users` without the `role = 'care_manager'` condition.

## 6. Run SQL and restart services

Run the reviewed SQL through `psql` inside the Postgres container. Example for a directory reset:

```sh
sudo docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.vertex-credentials.yml \
  exec -T postgres sh -lc \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
BEGIN;
DELETE FROM web_users WHERE role = 'care_manager';
DELETE FROM athulya_care_managers;
DELETE FROM patient_directory;
DELETE FROM staff_directory;
COMMIT;
SQL

sudo docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.vertex-credentials.yml \
  up -d backend-api backend-worker
```

If SQL fails, do not report completion. Restart the stopped services after inspecting the failure. Do not paste personal data or secrets into the conversation.

## 7. Verify without exposing records

Check counts only, not names or phone numbers:

```sh
sudo docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.vertex-credentials.yml \
  exec -T postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT '\''patient_directory'\'', count(*) FROM patient_directory UNION ALL SELECT '\''staff_directory'\'', count(*) FROM staff_directory UNION ALL SELECT '\''athulya_care_managers'\'', count(*) FROM athulya_care_managers UNION ALL SELECT role, count(*) FROM web_users GROUP BY role ORDER BY 1"'

sudo docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.vertex-credentials.yml ps backend-api backend-worker
```

For directory reset, expected counts are zero for patient, staff, and care-manager tables and zero for `care_manager` web users. Admin user count should remain unchanged. Report exactly what was cleared and the verification result.

## Safety rules

- Do not clear production data merely because a previous attempt failed; act only on an explicit reset request.
- Avoid broad `TRUNCATE ... CASCADE`, dropping schemas, deleting Docker volumes, or deleting all `web_users`.
- Do not reveal or request passwords, API tokens, service-account JSON, or `.env` contents.
- Explain that removed care-manager accounts must be reactivated/reprovisioned and existing care-manager sessions are invalidated.
- Keep admin access and settings unless the user explicitly asks to remove them.
