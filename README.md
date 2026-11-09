# Outbound attendance calling system

- `backend/` contains the Vobiz, Vertex AI, PostgreSQL, queue, and MinIO service module.
- `frontend/` contains the React + MUI operations UI, using Axios and TanStack React Query.

See [backend/README.md](backend/README.md) for backend integration and setup.

## Local infrastructure and GCP VM setup

Docker Compose runs PostgreSQL and private MinIO storage with persistent volumes.
Copy `.env.docker.example` to `.env`, replace the three local passwords/secrets,
then run:

```sh
docker compose up -d
docker compose ps
docker compose exec -T postgres psql -U attendance -d attendance_calls < backend/migrations/001_attendance_schema.sql
```

The Compose ports bind to `127.0.0.1` so PostgreSQL and MinIO are not exposed to
the public internet. The `minio-init` service creates a private recording bucket
and a separate bucket-scoped application user. Set these in `backend/.env`:

```env
DATABASE_URL=postgres://attendance:YOUR_POSTGRES_PASSWORD@127.0.0.1:5432/attendance_calls
MINIO_ENDPOINT=http://127.0.0.1:9000
MINIO_REGION=us-east-1
MINIO_BUCKET=attendance-recordings
MINIO_ACCESS_KEY=YOUR_MINIO_ACCESS_KEY
MINIO_SECRET_KEY=YOUR_MINIO_SECRET_KEY
```

For a GCP VM, attach a dedicated VM service account with Vertex AI access and
enable the Vertex AI API in the project. The backend uses Application Default
Credentials, so set `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` in
`backend/.env`; do not create or copy a service-account JSON key onto the VM.
Set Vobiz account credentials and the assigned outbound caller ID in the host
application's configuration. Set `PUBLIC_BASE_URL`, `VOBIZ_ANSWER_URL`, and
`VOBIZ_HANGUP_URL` to the VM's public HTTPS host and routes, and allow inbound
HTTPS to the reverse proxy in the GCP firewall.

The backend here is an embeddable Express module, not a complete standalone
server: the host platform must mount the router, provide authenticated
`req.orgId`, supply its organization-scoped Vertex client and backend delivery
adapter, and start the worker with Vobiz/recording/post-call adapters. The
frontend also expects the host API at `/api/call-service`. Finish those host
integrations before expecting Compose to start the application itself. On a VM,
running that host Node process directly on the VM lets Vertex ADC use the
attached service account without mounting credential files into containers.

Useful operations:

```sh
docker compose logs -f postgres minio minio-init
docker compose down                 # preserves named database/object volumes
docker compose down -v              # permanently deletes local database and recordings
```
