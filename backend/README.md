# Outbound call service module

An isolated Express module for Vobiz outbound attendance calls, reusable voice
agent configuration, and Google Vertex AI turn and post-call extraction helpers.
It follows the source platform's separation between telephony, the Vertex AI
client and call agents. Mount it inside the existing authenticated application;
it expects the host to set `req.orgId` after authentication.

## Mount

```js
const express = require("express");
const { createPostgresPool } = require("./postgres-pool");
const { PostgresRepository } = require("./postgres-repository");
const { PostgresJobQueue } = require("./postgres-queue");
const { createCallServiceRouter } = require("./index");

const pool = createPostgresPool();
const repository = new PostgresRepository(pool);
const config = require("./config").loadConfig();
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

## Durable queue and assignment flow

Apply `schema.sql` through your database migration process. `PostgresJobQueue`
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
and check-out. The patient phone may be stored for future use, but is not
dialed. Vobiz status events enqueue `process_call_result`; answered calls flow
through `transcribe_call`, `extract_intent`, and `evaluate_attendance`. Once
both stages are confirmed, the service queues backend delivery. It clears only
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
const { PostgresJobQueue } = require("./postgres-queue");
const { PostgresRepository } = require("./postgres-repository");
const { createAttendanceHandlers } = require("./attendance-workflow");
const { startWorkers } = require("./worker");
const { loadConfig } = require("./config");
const { createMinioRecordingStore } = require("./minio-recordings");
const { createAttendancePostCallAgent, createVertexTranscriber } = require("./vertex-agent");

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
for the post-call jobs.
See `.env.example` for separate phone-call and queue-processing retry settings.
The Vertex helper exposes text response generation, Gemini TTS, recording
transcription, and structured outcome extraction. `minio-recordings.js` imports
Vobiz recordings to a private S3-compatible bucket; configure the provider
recording host allowlist in `VOBIZ_RECORDING_ALLOWED_HOSTS`.

`vertex-agent.js` provides post-call outcome extraction and audio transcription.
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
- `GET /dashboard/summary` for daily attendance, call, concurrency, and queue metrics
- `GET /staff` and `GET /patients` for directory views derived from assignments
- `GET /supervision-queue` for sessions with unanswered or review statuses
- `GET /attendance/ledger` for completed sessions with both stages confirmed
- `GET /call-center` for active provider calls and queued call jobs
- `POST /webhooks/call-status` for signed Vobiz hangup/status events

All stored data is organization-scoped. Calls are initiated only from
assignment sessions and target the employee phone number; patient calling is
left for a future workflow extension.
