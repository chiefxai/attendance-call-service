# Attendance backend

The backend schedules attendance calls and applies attendance business rules. ChiefVoice is the only telephony and conversational-AI provider.

## Runtime responsibilities

- Express API for assignments, attendance status, users, organization settings, and operational dashboards.
- PostgreSQL repository and durable job queue.
- Worker for scheduled check-in/check-out calls, retry handling, result validation, and attendance delivery.
- ChiefVoice outbound API client.
- Signed ChiefVoice webhook receiver.
- Durable ChiefVoice call-status and post-call-result polling fallback.
- Private MinIO storage for recordings downloaded from ChiefVoice and the existing recording views.

There is no Vobiz media bridge, local Gemini/Vertex runtime, local speech transcription, or local post-call LLM extraction.

## ChiefVoice outbound request

The client sends `POST /v1/calls/outbound` with bearer API-key authentication (`calls:write`) and an idempotency key. ChiefVoice immediately returns `202 Accepted` with `session_id` and the initial status; the worker persists them and does not wait for the call to finish. The request includes:

- `channel: "phone"`, `destination`, `caller_id`, and `recording_allowed`
- `live_agent.template_id` and per-call `context`
- `post_call.template_id`, per-call `context`, strict `output_schema`, the built-in time tool, `time_zone`, `time_format`, and `include_live_agent_context`

The live and post-call prompts live in ChiefVoice reusable templates. The service selects a pair for each scenario: check-in, check-out, care-manager escalation, check-in/check-out retry, or check-in/check-out follow-up. It adds assignment, caregiver, patient, schedule, language, organization, attendance session, attempt, and stage context to each call, including the flat expected-name/address variables used by these templates.

## Webhook

Register this callback in the same ChiefVoice tenant/key scope (`PUT /v1/webhooks/post-call`, `webhooks:write`):

```text
POST https://calls.elvoryx.in/api/call-service/webhooks/chiefvoice
```

Store the one-time registration response's signing secret in server-side `CHIEFVOICE_WEBHOOK_SECRET`. The receiver expects `X-Chiefvoice-Signature: sha256=<hex>` over HMAC-SHA256 of `timestamp + "." + event_id + "." + exact raw JSON body`; `X-Chiefvoice-Timestamp` must be within five minutes. The event ID and event type headers must match the signed body, which contains `event_id`, `event: "call.analysis.completed"`, `call.session_id`, and structured `result`. Retries are deduplicated by event ID. The API key used by the worker needs `calls:read`, `calls:write`, `webhooks:read`, and `webhooks:write` for the documented polling and integration flows.

The webhook updates the attempt using provider `chiefvoice`, stores the post-call result, and queues deterministic attendance validation and artifact retrieval. The worker polls `GET /v1/calls/{session_id}` and `GET /v1/calls/{session_id}/post-call`, then downloads recordings from `GET /v1/calls/{session_id}/recording` using the same Bearer API key. Recordings are stored in private MinIO under the owning organization/session/attempt; the UI streams them through its authenticated recording route. Transcript text is saved when returned in the call status, post-call result, or webhook envelope. Missing artifacts are retried for a bounded period without logging their contents. Set `CHIEFVOICE_RECORDING_ALLOWED=true` for new calls only when recording is enabled for the ChiefVoice API/account; the default remains off.

## Environment

Required ChiefVoice variables:

```dotenv
CHIEFVOICE_URL=https://chiefvoice.elvoryx.in
CHIEFVOICE_API_KEY=
CHIEFVOICE_TEMPLATE_CHECK_IN_LIVE_ID=
CHIEFVOICE_TEMPLATE_CHECK_IN_POST_CALL_ID=
CHIEFVOICE_TEMPLATE_CHECK_OUT_LIVE_ID=
CHIEFVOICE_TEMPLATE_CHECK_OUT_POST_CALL_ID=
CHIEFVOICE_TEMPLATE_CARE_MANAGER_ESCALATION_LIVE_ID=
CHIEFVOICE_TEMPLATE_CARE_MANAGER_ESCALATION_POST_CALL_ID=
CHIEFVOICE_TEMPLATE_CHECK_IN_RETRY_LIVE_ID=
CHIEFVOICE_TEMPLATE_CHECK_IN_RETRY_POST_CALL_ID=
CHIEFVOICE_TEMPLATE_CHECK_OUT_RETRY_LIVE_ID=
CHIEFVOICE_TEMPLATE_CHECK_OUT_RETRY_POST_CALL_ID=
CHIEFVOICE_TEMPLATE_CHECK_IN_FOLLOW_UP_LIVE_ID=
CHIEFVOICE_TEMPLATE_CHECK_IN_FOLLOW_UP_POST_CALL_ID=
CHIEFVOICE_TEMPLATE_CHECK_OUT_FOLLOW_UP_LIVE_ID=
CHIEFVOICE_TEMPLATE_CHECK_OUT_FOLLOW_UP_POST_CALL_ID=
CHIEFVOICE_CALLER_ID=
ATHULYA_LATE_SCHEDULE_GRACE_MINUTES=2
CHIEFVOICE_TIMEOUT_MS=20000
CHIEFVOICE_RECORDING_ALLOWED=false
CHIEFVOICE_ARTIFACT_POLL_INTERVAL_MS=30000
CHIEFVOICE_ARTIFACT_POLL_MAX_ATTEMPTS=12
CHIEFVOICE_POLL_INITIAL_MS=15000
CHIEFVOICE_POLL_INTERVAL_MS=15000
CHIEFVOICE_POLL_MAX_ATTEMPTS=60
CHIEFVOICE_WEBHOOK_SECRET=
CHIEFVOICE_WEBHOOK_CALLBACK_URL=https://calls.elvoryx.in/api/call-service/webhooks/chiefvoice
```

Also configure `DATABASE_URL`, `DEFAULT_ORGANIZATION_ID`, the storage settings, and the Athulya attendance API credentials as required by the deployment.

## Commands

```bash
npm ci
npm run migrate
npm run start
npm run worker
npm test
```

Run the API and worker as separate processes. Apply migrations before deploying the new worker version.
