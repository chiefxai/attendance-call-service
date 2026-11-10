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

`CALL_MAX_CONSECUTIVE_NO_ANSWER` defaults to 5. After five consecutive
unanswered attempts for a stage, the service stops dialing that stage and
records its status as `not_answered`. An answered call resets that streak if
the employee requests a later callback. The host app can read
`GET /assignments/:id/status`; its check-in and check-out results include a
`flag: "not_answered"` when that limit is reached.

`POST /assignments` accepts employee and patient details, agent, language,
caller ID, and scheduled shift times. It schedules employee calls at check-in
and check-out in one database transaction with the session record.

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
through `transcribe_call`, `extract_intent`, and `evaluate_attendance`. Once
both stages are confirmed, the service queues a POST to `ATTENDANCE_BACKEND_URL`
with the session, call attempts, and transcripts. The request uses
`ATTENDANCE_BACKEND_TOKEN` as a Bearer token when configured and includes an
`Idempotency-Key` so the receiving platform can safely handle retries. Failed
requests stay in the durable queue and retry. The receiver can use the service
API key to fetch logs and recordings from the artifacts routes. It clears only
the active cache entry after successful delivery; PostgreSQL history remains
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

All stored data is organization-scoped. Calls are initiated only from
assignment sessions and target the employee phone number; patient calling is
left for a future workflow extension.


## Inbound patient calls (Vobiz)

Inbound calls use the Vertex AI Live audio runtime but have a dedicated patient-support agent persona, independent from the outbound employee attendance prompt. The handler validates the Vobiz request signature, performs an exact organization-scoped patient phone lookup, supplies only the matched patient context to the agent, records the caller and agent audio, and queues transcription after the call. The agent introduces itself as Athulya patient support and never describes an incoming patient call as attendance verification. Configure its name, optional voice override, and additional patient-support instructions with `INBOUND_PATIENT_AGENT_NAME`, `INBOUND_PATIENT_AGENT_VOICE`, and `INBOUND_PATIENT_AGENT_PROMPT`. Without a voice override, it uses the voice associated with the patient's language profile. The background worker stores the transcript and applies the configured retention period.

Configure a Vobiz Voice Application:

- **Answer URL (POST):** `https://<your-public-domain>/api/call-service/incoming/answer`
- **Hangup URL (POST):** `https://<your-public-domain>/api/call-service/webhooks/call-status`
- **Fallback Answer URL:** leave blank until a separate fallback flow is required.
- Link the inbound Vobiz phone number to this Voice Application.

The Answer URL is a provider callback: application API-key authentication is bypassed only for that route, while Vobiz signature validation remains mandatory. The APIs `GET /api/call-service/incoming-calls`, `GET /api/call-service/incoming-calls/:id`, and `GET /api/call-service/incoming-calls/:id/recording` require the normal authenticated organization context.

Set `DATA_RETENTION_DAYS=90`, `RETENTION_SCAN_INTERVAL_MS=3600000`, and `INBOUND_RECORDING_MAX_BYTES=52428800` in the service environment as needed. The worker deletes expired recording objects and inbound call rows.
