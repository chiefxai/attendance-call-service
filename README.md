# Outbound attendance calling system

- `backend/` contains the Vobiz, Vertex AI, PostgreSQL, queue, and MinIO service module.
- `frontend/` contains the React + MUI operations UI, using Axios and TanStack React Query.

See [backend/README.md](backend/README.md) for backend integration and setup.

## Docker setup on a GCP Linux VM

Docker Compose runs PostgreSQL, private MinIO storage, the API, a one-shot
database migration, and the queue worker. Copy `.env.docker.example` to `.env`,
replace the local passwords, set your GCP project and organization ID, and fill
the Vobiz credentials and public HTTPS callback host. Make `DATABASE_URL` use
the same database password as `POSTGRES_PASSWORD`. Then run:

Generate local secrets with `openssl rand -hex 32`. Use the same generated
PostgreSQL password in `POSTGRES_PASSWORD` and the password part of
`DATABASE_URL`.

```sh
docker compose up --build -d
docker compose ps
docker compose logs -f backend-migrate backend-api backend-worker
```

PostgreSQL and MinIO ports bind to `127.0.0.1`; the API also listens on the
VM's loopback interface. Put an authenticated HTTPS reverse proxy in front of
the API and configure it to forward HTTP and WebSocket upgrades to
`127.0.0.1:3000`. Point Vobiz's answer and status webhooks at the public HTTPS
routes. The reverse proxy must protect operations API routes; Vobiz answer and
status callbacks are validated by Vobiz signatures. The `minio-init` service
creates a private recordings bucket and a bucket-scoped application user.
Only expose HTTPS in the GCP firewall; do not open ports 3000, 5432, 9000, or
9001 to the internet.

The API and worker use Docker host networking on the Linux VM so Vertex AI can
obtain Application Default Credentials from the attached VM service account
without a JSON key. Attach a service account with Vertex AI access and enable
the Vertex AI API in the project. Set `GOOGLE_CLOUD_PROJECT` and
`GOOGLE_CLOUD_LOCATION` in `.env`. Set `ATTENDANCE_BACKEND_URL` and its token
before using completed-session delivery; if unset, delivery jobs retry and
eventually enter the queue's dead-letter state.

Compose runs `backend-migrate` before starting the API and worker.

Useful operations:

```sh
docker compose logs -f backend-api backend-worker
docker compose restart backend-api backend-worker
docker compose down                 # preserves named database/object volumes
docker compose down -v              # permanently deletes database and recordings
```
