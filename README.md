# Outbound attendance calling system

- `backend/` contains the Vobiz, Vertex AI, PostgreSQL, queue, and MinIO service module.
- `frontend/` contains the React + MUI operations UI, using Axios and TanStack React Query.

See [backend/README.md](backend/README.md) for backend integration and setup.

## Deploy on a GCP Linux VM

Docker Compose runs PostgreSQL, private MinIO storage, the API, a one-shot
database migration, the queue worker, the React frontend, and Caddy. Caddy obtains and renews TLS
certificates automatically. Before deployment, reserve a static external IP for
the VM, create a DNS A record for your calling hostname pointing to that IP,
and allow inbound TCP 80 and 443 in the GCP firewall. Do not expose ports 3000,
5432, 9000, or 9001.

Copy `.env.docker.example` to `.env`, replace the local passwords, set your GCP
project and organization ID, and fill the Vobiz credentials. Make
`DATABASE_URL` use the same database password as `POSTGRES_PASSWORD`. Keep the
`.env` file private. Set `VOBIZ_FROM_NUMBER` to your provisioned Vobiz caller ID;
new assignments use it by default, with an optional per-assignment override.
Then, from the project root, run the deployment script
with the hostname from your DNS A record:

```sh
cp .env.docker.example .env
chmod 600 .env
nano .env
chmod +x scripts/deploy-vm.sh
./scripts/deploy-vm.sh calls.example.com
```

The React operations UI is served at `https://<hostname>/`; `/api/*` and
`/healthz` are routed to the backend API. The script writes `PUBLIC_DOMAIN`, `PUBLIC_BASE_URL`, `VOBIZ_ANSWER_URL`, and
`VOBIZ_HANGUP_URL` into `.env`, validates Compose configuration, builds and
starts the services, and checks `https://<hostname>/healthz`. It does not
create DNS records or GCP firewall rules; those must be in place first. Point
Vobiz's answer and status webhooks at the generated HTTPS URLs. Caddy forwards
HTTP and WebSocket upgrades to the API on the VM loopback interface. Operations
API routes must be protected by application authentication; Vobiz callbacks
are validated by Vobiz signatures.

The API and worker use Docker host networking on the Linux VM so Vertex AI can
obtain Application Default Credentials from the attached VM service account
without a JSON key. Attach a service account with Vertex AI access and enable
the Vertex AI API in the project. Set `GOOGLE_CLOUD_PROJECT` and
`GOOGLE_CLOUD_LOCATION` in `.env`. Set `ATTENDANCE_BACKEND_URL` and its token
before using completed-session delivery; if unset, delivery jobs retry and
eventually enter the queue's dead-letter state.

Creating an assignment queues both check-in and check-out in the same session.
The check-out call waits until `scheduledEndAt`; a terminal result for check-in
does not cancel it. The session is `completed` only after both stages are
confirmed. If either stage exhausts its configured retries or needs review, the
session becomes an exception after both stages have settled.

Compose runs `backend-migrate` before starting the API and worker.

Useful operations:

```sh
docker compose logs -f backend-api backend-worker
docker compose restart backend-api backend-worker
docker compose down                 # preserves named database/object volumes
docker compose down -v              # permanently deletes database and recordings
```
