---
name: attendance-stack-reset
description: Reset the attendance-call-service Docker stack and its persistent data, then recreate the stack and provision a new admin account when the user explicitly requests a full fresh start.
---

# Attendance stack reset and admin setup

Use this skill when the user asks to remove the attendance app's Docker containers and volumes and start fresh with a new admin login. Do not apply it to the separate ChiefVoice backend stack.

## Identify the right deployment

- Confirm the target is the attendance-call-service checkout, not a directory named `chiefvoice` on the `chiefvoice-backend` host.
- The deployment directory must contain `docker-compose.yml`, a real `.env` file, and `backend/scripts/create-web-user.js`.
- Confirm Compose defines `postgres`, `backend-api`, `backend-worker`, `backend-migrate`, and `mock-athulya`. The expected Compose project name is `athulya-attendance`.
- If any check fails, stop before mutation. Do not create `.env` from an example file, guess another host, or run `down --volumes` in the wrong project.

## Destructive operation

This reset permanently removes the Postgres and MinIO contents, including admin and care-manager accounts, integration settings and credentials stored in the database, schedules, call/attendance history, and recordings. It also removes Caddy's persisted certificate/config data. The checkout and `.env` file remain. Explain this immediately before acting and require the user's explicit authorization for the full volume reset in the current task.

When the user authorizes the reset and a suitable remote VM session is available, run `bash skills/attendance-stack-reset/scripts/reset-and-create-admin.sh --check` from the verified attendance app root first. If it passes, run the same script with `--execute`. The script requires an explicit typed confirmation, validates the app checkout and secrets file without printing it, recreates the stack, and prompts privately for new admin credentials. Never run it against production without the user's explicit request to erase all app volumes.

If remote execution is unavailable, provide the script invocation for the user to run on the correct VM. Do not claim the reset or account creation succeeded until the script output confirms it.

## Recovery and verification

- The script's admin creation helper creates an `admin` role account in `DEFAULT_ORGANIZATION_ID`; passwords must be at least 12 characters. The password is passed over standard input, never as a command-line argument or log output.
- On any error after volumes are removed, stop and report the exact failing phase. Do not repeat the wipe. The stack may be recreated and the admin provisioned separately after correcting the issue.
- Confirm the admin provisioning command completed and the API is healthy. If the UI still shows records after the reset, check that automatic sync is disabled and that the UI is connected to this same deployment/database before running another sync.
- The mock Athulya server is separate in-memory fixture data. A future sync can import fixtures again; a volume reset does not delete its fixture source.
