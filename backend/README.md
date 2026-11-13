# Outbound call service module

An isolated Express module for Vobiz outbound attendance calls, reusable voice
agent configuration, and Google Vertex AI turn and post-call extraction helpers.
It follows the source platform's separation between telephony, the Vertex AI
client and call agents. Mount it inside the existing authenticated application;
it expects the host to set `req.orgId` after authentication.

## Code layout

```text
backend/
├── index.js                         # stable package entry point
├── Dockerfile                       # production Node image
├── migrations/                      # ordered PostgreSQL schema migrations
├── scripts/migrate.js               # idempotent schema migration command
├── src/
│   ├── api/                          # Express routes and request validation
│   ├── agents/                       # Vertex AI call and post-call agents
│   ├── config/                       # environment-backed runtime settings
│   ├── domain/attendance/            # attendance decisions and workflow
│   ├── domain/repository-contract.js # persistence boundary
│   ├── infrastructure/database/      # PostgreSQL pool, repository, queue
│   ├── infrastructure/integrations/  # external attendance delivery client
│   ├── infrastructure/storage/       # MinIO recording adapter
│   ├── infrastructure/telephony/     # Vobiz client and webhook signatures
│   ├── realtime/                     # Vobiz media ↔ Vertex Live bridge
│   ├── workers/                      # queue consumer and worker bootstrap
│   ├── server.js                      # standalone Express API bootstrap
│   └── index.js                      # public module exports
└── package.json
```

Import supported components from the package root (`require("attendance-call-service-module")`).
Implementation files under `src/` are internal and can move independently of
that public entry point.

## Mount

```js
const express = require("express");
const {
  createPostgresPool,
  PostgresRepository,
  PostgresJobQueue,
  createCallServiceRouter,
  loadConfig,
} = require("attendance-call-service-module");

const pool = createPostgresPool();
const repository = new PostgresRepository(pool);
const config = loadConfig();
const queue = new PostgresJobQueue(pool, config.worker);
const callServiceRouter = createCallServiceRouter({
  express, repository, queue, getClientForOrg,
  // Default validation checks Vobiz V2/V3 request signatures with the API token.
});
app.use("/api/call-service", callServiceRouter);

// Attach the module's WebSocket upgrade handler to the same HTTP server.
server.on("upgrade", (request, socket, head) => {
  const handled = callServiceRouter.handleVobizUpgrade(request, socket, head);
  if (!handled) socket.destroy(); // or pass to another WebSocket router
});
```

Keep the module's routes behind your platform's authentication and workspace
permission middleware. The assignment endpoint validates the organization and
active agent before scheduling employee calls.

## Docker runtime

The root `docker-compose.yml` starts PostgreSQL, MinIO, the migration runner,
the standalone API, and a separate queue worker. The API/worker containers use
host networking for GCE VM Application Default Credentials; the API binds to
`127.0.0.1`, so publish it through an authenticated HTTPS reverse proxy that
supports WebSocket upgrades. Keep `/answer` and `/webhooks/call-status` reachable
by Vobiz; the routes validate Vobiz signatures. `DEFAULT_ORGANIZATION_ID`
selects the tenant for standalone API requests. Existing host applications can
continue mounting the Express router and setting `req.orgId` through their own
authentication middleware.

The API and worker use `createAttendanceBackendClient()` for final attendance
delivery. Configure `ATTENDANCE_BACKEND_URL` and `ATTENDANCE_BACKEND_TOKEN`; the
client sends an idempotency key with each request. The Docker worker can start
without that URL, but delivery jobs will retry until it is configured.

## Durable queue and assignment flow

The Compose migration service applies `migrations/001_attendance_schema.sql` before the API or worker starts. For host deployments, apply that migration through your existing migration process. `PostgresJobQueue`
uses row locks with `SKIP LOCKED`, leases, idempotency keys, retries, and
dead-letter state. Run API and worker processes separately. Due check-in and
check-out calls are durable jobs; after a worker crash, a job can be claimed
again after its lease expires.

This service is outbound-only: assignment jobs create calls to the employee
through Vobiz. `MAX_CONCURRENT_CALLS` applies a global cap shared by every
worker replica using PostgreSQL-backed call slots. When the cap is reached,
pending call jobs wait and retry after `CALL_CAPACITY_POLL_MS`; terminal Vobiz
status events release slots. `CALL_SLOT_TTL_MINUTES` is a safety expiry for
lost terminal callbacks. Queue worker concurrency controls background job
processing separately from the number of live provider calls.

`CALL_MAX_CONSECUTIVE_NO_ANSWER` defaults to 3. After three consecutive
unanswered attempts for a stage, the service stops dialing that stage and
records its status as `not_answered`. The assigned care manager receives an
in-app alert by default. Settings can switch escalation to an automated Vobiz
call. An answered call resets that streak if the employee requests a later callback. The host app can read
`GET /assignments/:id/status`; its check-in and check-out results include a
`flag: "not_answered"` when that limit is reached.

`POST /assignments` accepts employee and patient details, agent, language,
caller ID, and scheduled shift times. It creates separate durable check-in and
check-out tasks, each with its own ID, status, retry history, stage-only agent
context, and platform delivery state. Each task runs independently; neither
waits for nor is canceled by the other. A confirmed stage is POSTed to the host
platform immediately as its own event. The assignment record groups both tasks
for reporting, and its summary is complete only after both tasks are confirmed.

Indian mobile numbers are accepted as 10 digits (`9876543210`), 12 digits with
country code 91 (`919876543210`), or with an explicit `+91` prefix
(`+919876543210`). The service validates Indian mobile numbers (starting with
6–9) and normalizes them to `+91` plus the 10-digit number before storing or
dialing. Staff and employee numbers are required; patient numbers are optional
and are never dialed by the current workflow. Repeating
the same request is idempotent and repairs missing queue entries; changing
assignment details or times requires a new `scheduleVersion` (otherwise the
API returns HTTP 409). The patient phone may be stored for future use, but is not
dialed. Vobiz status events enqueue `process_call_result`; answered calls flow
through `transcribe_call`, `extract_intent`, and `evaluate_attendance`. Once a
stage is confirmed, the service queues a separate POST to
`ATTENDANCE_BACKEND_URL` with that task, its call attempt, and transcript. The request uses
`ATTENDANCE_BACKEND_TOKEN` as a Bearer token when configured and includes an
`Idempotency-Key` so the receiving platform can safely handle retries. Failed
requests stay in the durable queue and retry. The receiver can use the service
API key to fetch logs and recordings from the artifacts routes. PostgreSQL is
the durable task state source, so workers can resume without sticky process memory.
subject to the retention policy.

The live call uses Vertex Gemini Live audio-to-audio. `/answer` returns VobizXML
for a bidirectional 16 kHz L16 stream, and `/media` bridges Vobiz audio frames
to the live Vertex session and sends generated 24 kHz audio back to Vobiz. It
also passes the full session context to the caller agent and supports barge-in
audio clearing and an `end_call` tool. The live audio path is independent of
the post-call queue.

The worker dependencies (`recordings`, `transcriber`, `backend`, and optional
`activeSessionCache`) are adapters supplied by the host service. Keep recording
and transcript content out of queue payloads; jobs carry only record IDs.

Example worker wiring:

```js
const {
  PostgresJobQueue,
  PostgresRepository,
  createAttendanceHandlers,
  startWorkers,
  loadConfig,
  createMinioRecordingStore,
  createAttendancePostCallAgent,
  createVertexTranscriber,
} = require("attendance-call-service-module");

const config = loadConfig();
const repository = new PostgresRepository(pool);
const queue = new PostgresJobQueue(pool, config.worker);
const recordings = createMinioRecordingStore();
const postCallAgent = createAttendancePostCallAgent({ getClientForOrg });
const transcriber = createVertexTranscriber({ getClientForOrg, recordings });
const handlers = createAttendanceHandlers({ repository, queue, vobiz, recordings,
  transcriber, postCallAgent, backend, activeSessionCache, retry: config.callRetry,
  capacity: config.callCapacity });
const workers = startWorkers({ queue, handlers, ...config.worker });
```

`backend` is the Athulya API adapter. It must use the session ID as its
idempotency key. `activeSessionCache` is optional; it is cleared only after
successful backend delivery. No patient call is scheduled by the assignment
flow.

## Environment

Set `DATABASE_URL`, `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN`, `VOBIZ_API_BASE_URL` (optional),
`VOBIZ_ANSWER_URL`, and `VOBIZ_HANGUP_URL` (optional). Configure Google Cloud
ADC for Vertex AI, plus `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`. For
multi-organization deployments, inject the source platform's org-scoped
`getClientForOrg(orgId)` into the router and Vertex helpers rather than sharing
a project client. `PUBLIC_BASE_URL` must be the public HTTPS origin, and
`VOBIZ_STREAM_SECRET` must be a long random secret in production. Configure
`VERTEX_LIVE_AUDIO_MODEL` for the live audio-to-audio model and
`VERTEX_CALL_MODEL`, `VERTEX_TRANSCRIPTION_MODEL`, and `VERTEX_SUMMARY_MODEL`
for the post-call jobs. Transcription defaults to `gemini-3.1-flash-lite` in
the `global` Vertex location; override it with `VERTEX_TRANSCRIPTION_MODEL` and
`VERTEX_TRANSCRIPTION_LOCATION` when needed.
See `.env.example` for separate phone-call and queue-processing retry settings.
The Vertex helper exposes text response generation, Gemini TTS, recording
transcription, and structured outcome extraction. The MinIO recording adapter imports
Vobiz recordings to a private S3-compatible bucket; configure the provider
recording host allowlist in `VOBIZ_RECORDING_ALLOWED_HOSTS`.

`src/agents/vertex-agent.js` provides post-call outcome extraction and audio transcription.
The live caller uses Vertex Live audio-to-audio, following the source backend's
Vobiz/Vertex integration pattern.

The implementation follows the source platform's `@google/genai` Vertex client
factory and its Vobiz STT → LLM → TTS pipeline. See
[`googleAiClient.js`](https://github.com/chiefxai/crm-backend-test/blob/main/src/ai/googleAiClient.js),
[`vobizPipeline.js`](https://github.com/chiefxai/crm-backend-test/blob/main/src/telephony/vobiz/vobizPipeline.js),
and [`postCallAgents`](https://github.com/chiefxai/crm-backend-test/tree/main/src/ai/postCallAgents).

## Routes

- `GET/POST /agents`, `GET/PATCH/DELETE /agents/:id`
- `GET/POST /campaigns`, `GET /campaigns/:id`
- `POST /answer` for Vobiz's signed call-flow webhook
- WebSocket `/media` for the live Vertex audio-to-audio conversation
- `POST /assignments` to create a scheduled employee check-in/check-out session
- `GET /assignments` to list organization-scoped attendance sessions
- `GET /assignments/:id/status` to read attendance status and not-answered flags
- `GET /assignments/:id/artifacts` to retrieve session details, call attempts, transcripts, and audit logs
- `GET /assignments/:id/recordings/:attemptId` to stream an authorized recording from private MinIO
- `GET /dashboard/summary` for daily attendance, call, concurrency, and queue metrics
- `GET/POST /staff` to list and save organization-scoped staff profiles
- `GET/POST /patients` to list and save organization-scoped patient profiles
- `GET /supervision-queue` for sessions with unanswered or review statuses
- `GET /attendance/ledger` for completed sessions with both stages confirmed
- `GET /call-center` for active provider calls and queued call jobs
- `POST /webhooks/call-status` for signed Vobiz hangup/status events

Staff directory profiles accept an optional `companyName` string (maximum 200 characters) to identify the vendor/provider company; leave it blank for independent staff. It is returned in staff listings and available to enquiry and appointment workflows.

All stored data is organization-scoped. Calls are initiated only from
assignment sessions and target the employee phone number; patient calling is
left for a future workflow extension.


## Inbound patient calls (Vobiz)

Inbound calls use the Vertex AI Live audio runtime but have a dedicated patient-support agent persona, independent from the outbound employee attendance prompt. The handler validates the Vobiz request signature, performs an exact organization-scoped patient phone lookup, supplies only the matched patient context to the agent, records the caller and agent audio, and queues transcription after the call. The agent introduces itself as Athulya patient support and never describes an incoming patient call as attendance verification. Configure its name, optional voice override, and additional patient-support instructions with `INBOUND_PATIENT_AGENT_NAME`, `INBOUND_PATIENT_AGENT_VOICE`, and `INBOUND_PATIENT_AGENT_PROMPT`. Without a voice override, it uses the voice associated with the patient's language profile. The background worker stores the transcript and applies the configured retention period.

After a patient enquiry has a clear activity, requested start time, and staff suggestions, the worker starts the appointment coordinator. This is a separate Vertex Live prompt from both patient support and attendance verification. It calls suggested staff in ranked order, up to the configured unanswered-call limit (3 by default), records each attempt, and advances on no-answer or a clearly declined appointment. A call recording is stored in MinIO and transcribed asynchronously; the post-call extractor requires explicit staff acceptance of the care activity and requested time before the schedule tool can create an attendance session. That session queues the existing check-in and check-out attendance calls. When the call limit is reached, booking status becomes `not_answered` and the assigned care manager is notified or called according to Settings; ambiguous responses become `needs_review`. Configure the optional coordinator persona with `APPOINTMENT_BOOKING_AGENT_NAME`, `APPOINTMENT_BOOKING_AGENT_VOICE`, and `APPOINTMENT_BOOKING_AGENT_PROMPT`.

Configure a Vobiz Voice Application:

- **Answer URL (POST):** `https://<your-public-domain>/api/call-service/incoming/answer`
- **Hangup URL (POST):** `https://<your-public-domain>/api/call-service/webhooks/call-status`
- **Fallback Answer URL:** leave blank until a separate fallback flow is required.
- Link the inbound Vobiz phone number to this Voice Application.

The Answer URL is a provider callback: application API-key authentication is bypassed only for that route, while Vobiz signature validation remains mandatory. The APIs `GET /api/call-service/incoming-calls`, `GET /api/call-service/incoming-calls/:id`, and `GET /api/call-service/incoming-calls/:id/recording` require the normal authenticated organization context.


### Care activity durations and staff suggestions

Configure the activity catalog in **Settings → Care activities**. Each organization can create, edit, and deactivate care activities with a default duration. The patient agent asks for the requested activity and start date/time; it does not ask the caller for duration or an end time. The post-call agent extracts the activity and start time, then the backend applies the configured duration, excludes staff with any overlapping duty, and returns up to 10 suggestions ordered by same district, same state, and other areas. Suggestions include the staff contact and appear in Enquiries for a human to follow up; the system does not assign a staff member automatically. A saved patient address must include the structured state and district fields for location ranking.

The authenticated API is `GET /api/call-service/activities`, `POST /api/call-service/activities`, and `PUT /api/call-service/activities/:id`. Incoming enquiries use the system-controlled `enquiryStatus` values `processing`, `need_review`, `suggestion`, `shortage`, and `resolved`. The post-call pipeline selects the status; arbitrary values are rejected by the database constraint and API writes do not accept status overrides. `POST /api/call-service/incoming-calls/:id/resolve` accepts only `{ "staffId": "..." }`. It allows a suggested staff member or any active staff member in the organization for a shortage enquiry, then records who resolved it. The incoming call list includes this status, extracted activity and requested times, transcript, recording availability, staff suggestions, and resolved staff.

Set `DATA_RETENTION_DAYS=90`, `RETENTION_SCAN_INTERVAL_MS=3600000`, and `INBOUND_RECORDING_MAX_BYTES=52428800` in the service environment as needed. The worker deletes expired recording objects and inbound call rows.

## Athulya workforce integration

The web application supports `admin` and `care_manager` login roles. Existing provisioned accounts remain Admin accounts after migration. Care Managers sign in with their Indian mobile number, can view organization-wide care giver profiles, can view patients assigned to their Care Manager ID through Athulya schedules, and can operate only their scoped assignments; backend authorization prevents them from managing users, application settings, calling agents, API keys, or Athulya credentials. Bulk-provisioned Care Manager accounts receive a temporary password and must change it before using the service. Admin accounts are created from the VM console with `scripts/create-web-user.js`.

The documented schedule source is `GET https://homecare.athulyaliving.net/api/caremanager/clients`, authenticated with the `x-api-key` header. Configure it under **Settings → Athulya integration**. The API key is AES-256-GCM encrypted in PostgreSQL and is never returned by the configuration API. Set `ATHULYA_CREDENTIALS_ENCRYPTION_KEY` to a stable 32-byte hex value before saving the key; losing or rotating this value makes the stored credential unreadable. Generate a key with `openssl rand -hex 32` and keep it in the VM `.env`.

### Local mock platform

The optional `mock-platform` Compose profile provides an Athulya-compatible test API for schedule reads and attendance writes. It is intended for local or staging validation; it is not enabled by the normal Compose startup and the sample schedule is marked `Completed` with no caregiver assignment, so syncing it cannot place a Vobiz call.

Set these values in `.env`:

```dotenv
ATHULYA_MOCK_API_BASE_URL=http://127.0.0.1:4010/api
ATHULYA_MOCK_API_KEY=mock-athulya-api-key
ATHULYA_MOCK_PORT=4010
```

Start the mock API and recreate the application services so they receive the mock URL allowlist:

```sh
docker compose --env-file .env --profile mock-platform up --build -d mock-athulya
docker compose --env-file .env up -d --force-recreate backend-api backend-worker
```

In **Settings → Athulya integration**, enter the mock base URL and key, leave automatic sync disabled, then use **Test connection** and **Sync schedules now**. The mock returns one safe sample schedule for the selected date. To exercise the attendance POST through the same client used by the worker, run:

```sh
docker compose --env-file .env exec -T backend-api node scripts/test-athulya-mock.js
```

The mock accepts `GET /api/caremanager/clients` and `POST /api/check-in-out`. POSTs are stored in memory and can be inspected or cleared using `GET` or `DELETE /mock/submissions` with the mock API key. The listener is bound to `127.0.0.1` on the VM, so it is not exposed as a public service. Remove the profile service when testing is complete with `docker compose --env-file .env --profile mock-platform stop mock-athulya`.

Admin-only endpoints:

- `GET/PUT /api/call-service/integrations/athulya` — read or update settings; a blank `apiKey` leaves the stored key unchanged.
- `POST /api/call-service/integrations/athulya/test` — test the connection and return only the record count.
- `POST /api/call-service/integrations/athulya/sync` — enqueue an asynchronous import for one `scheduleDate` (`YYYY-MM-DD`), optionally scoped to `careManagerId`, `branchId`, or `clientId`. The selected day is sent as identical `from_date` and `to_date` values to Athulya; date ranges are rejected.
- `GET /api/call-service/integrations/athulya/sync-status` — view sync runs and errors.
- `GET /api/call-service/integrations/athulya/attendance-submissions` — view local attendance export state.
- `GET /api/call-service/integrations/athulya/schedules` — view imported schedules.
- `GET/POST /api/call-service/care-managers`, `PUT/PATCH /api/call-service/care-managers/:id`, and `POST /api/call-service/care-managers/:id/reset-password` — manage Care Manager accounts. Password reset revokes their active sessions.
- `POST /api/auth/login` — accepts an Admin email or Care Manager phone number and password.
- `POST /api/auth/change-password` — verifies the current password, saves a new password (minimum 12 characters), and revokes other active sessions.

Schedule sync is idempotent by organization and Athulya schedule identifiers. Each sync requests exactly one scheduled service date and locally discards any returned record whose `schedule_date` is outside that day. After each successful import, the worker creates internal attendance-tracking sessions from eligible imported Athulya schedules (it never creates or changes the source duty schedules) and queues separate check-in and check-out calls at the imported local times. Only pending/scheduled/active/confirmed/approved/assigned/in-progress rows with valid times, an active caregiver phone, an active attendance agent, and a caller ID are queued; canceled/completed rows cancel not-yet-started local attendance sessions. Repeated syncs are idempotent. If a schedule changes after a call attempt has begun, the service avoids duplicate calls and logs that manual review is needed. In the API contract, this is `from_date=YYYY-MM-DD` and `to_date=YYYY-MM-DD` with the same value; conceptually the day runs from midnight on the selected date up to, but not including, midnight the next day. It does not use service allocation dates to select schedules. The service preserves source date values as date-only fields, stores raw response JSON, and updates patient, caregiver, Care Manager, schedule, and caregiver-to-schedule records without deleting records absent from a filtered response. Imported profiles do not overwrite saved patient/staff addresses or language preferences. In Settings, automatic sync can target **everyone**, **one branch**, or **one Care Manager**. Branch and Care Manager scopes are mutually exclusive; when either is selected, other branches or managers are excluded from the request. The worker runs at 12:00 AM and 12:00 PM in `APP_TIMEZONE` (defaults to `Asia/Kolkata`) and requests the date on which that local run occurs. Scheduling state is stored in PostgreSQL and claimed transactionally with the queue, preventing duplicate runs per time slot across worker instances. Automatic sync is off by default. Manual sync requires one schedule date and supports the same all/one-branch/one-Care-Manager selection while the integration is enabled. `ATHULYA_AUTO_SYNC_SCAN_INTERVAL_MS` controls how often the worker checks for due slots (default 60000 ms).

Confirmed check-in and check-out events for imported Athulya schedules are sent separately to `POST /api/check-in-out`. The request contains `schedule_id` (Athulya caregiver schedule primary key), `type` (`check_in` or `check_out`), and `timing` in ISO-8601 with the configured application time-zone offset. The encrypted Athulya API key is sent in the `x-api-key` header. Successful delivery is marked `synced`; transient failures use the durable queue retry policy and remain visible as `retry_scheduled`. Set `ATHULYA_ATTENDANCE_TIMEOUT_MS` to change the per-request timeout (default 15 seconds). The existing configured platform callback is still sent separately with the richer attendance payload.

## Public mock API for integration testing

An admin can enable the test platform server from **Settings → API configuration**. It is exposed under the same HTTPS host at `/api/call-service/test-platform`; no extra public port or DNS record is required. Configure a long random `ATHULYA_MOCK_API_KEY` in the VM `.env` before turning the toggle on. Requests use that value in the `x-api-key` header. The mock returns a completed sample schedule with no assigned caregiver (so it cannot start a Vobiz call), accepts check-in/check-out attendance posts, and provides a submissions view. Test submissions are held in process memory and clear when the mock service restarts. Turning the UI toggle off makes the public proxy routes return 404.
