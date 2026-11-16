# Attendance backend

The backend schedules attendance calls and applies attendance business rules. ChiefVoice is the only telephony and conversational-AI provider.

## Runtime responsibilities

- Express API for assignments, attendance status, users, organization settings, and operational dashboards.
- PostgreSQL repository and durable job queue.
- Worker for scheduled check-in/check-out calls, retry handling, result validation, and attendance delivery.
- ChiefVoice outbound API client.
- Signed ChiefVoice webhook receiver.
- MinIO remains available for retained legacy recording artifacts and existing recording views.

There is no Vobiz media bridge, local Gemini/Vertex runtime, local speech transcription, or local post-call LLM extraction.

## ChiefVoice outbound request

The client sends `POST /v1/calls/outbound` with:

- `channel: "phone"`, `destination`, `caller_id`, and `recording_allowed`
- `live_agent.template_id` and per-call `context`
- `post_call.template_id`, per-call `context`, strict `output_schema`, the built-in time tool, `time_zone`, `time_format`, and `include_live_agent_context`

The live and post-call prompts live in ChiefVoice reusable templates. The service adds assignment, caregiver, patient, schedule, language, organization, attendance session, attempt, and stage context to each call.

## Webhook

Register this public URL in ChiefVoice:

```text
POST https://<public-domain>/api/call-service/webhooks/chiefvoice
```

Set `CHIEFVOICE_WEBHOOK_SECRET` to the webhook signing secret. The current receiver expects HMAC-SHA256 of the exact raw JSON body in `x-chiefvoice-signature` (hex or `sha256=<hex>`). It requires an event identifier (`event_id` or `eventId`) and accepts a call/session identifier in `session_id`, `call_id`, `callId`, or `id`, a call state in `call_status`, `status`, or `state`, and a structured result in `post_call_result`, `postCallResult`, `post_call.result`, or `result`. Result fields may be camelCase or snake_case.

The webhook updates the attempt using provider `chiefvoice`, stores the post-call result, and queues deterministic attendance validation. Repeated callbacks are deduplicated in `chiefvoice_webhook_events` by event ID; result writes and queue jobs also use stable idempotency keys.

## Environment

Required ChiefVoice variables:

```dotenv
CHIEFVOICE_URL=https://chiefvoice.elvoryx.in
CHIEFVOICE_API_KEY=
CHIEFVOICE_LIVE_TEMPLATE_ID=
CHIEFVOICE_POST_CALL_TEMPLATE_ID=
CHIEFVOICE_CALLER_ID=
CHIEFVOICE_TIMEOUT_MS=20000
CHIEFVOICE_WEBHOOK_SECRET=
CHIEFVOICE_WEBHOOK_CALLBACK_URL=https://<public-domain>/api/call-service/webhooks/chiefvoice
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
