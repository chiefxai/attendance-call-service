# Attendance calling frontend

React + TypeScript app using MUI for UI components, Axios for backend requests,
TanStack React Query for server state, and React Router for page navigation.

## Run locally

```sh
npm install
cp .env.example .env.local
npm run dev
```

## Deploy with Docker Compose on the GCP VM

The root `docker-compose.yml` builds the frontend into an Nginx image. Nginx
serves the single-page app on the VM loopback port `4173`; Caddy serves it at
`https://<hostname>/` and proxies `/api/*` and `/healthz` to the backend. No
frontend API origin is needed because the browser uses same-origin requests.
After pulling project changes on the VM, run `./scripts/deploy-vm.sh
calls.elvoryx.in` from the repository root to rebuild and restart the stack.

Vite proxies `/api/call-service` to `VITE_BACKEND_ORIGIN` (defaults to
`http://localhost:3000`). The browser client sends same-origin cookies so the
host application's authenticated organization context can reach the backend.
The UI reads `/dashboard/summary`, `/assignments`, `/staff`, `/patients`,
`/supervision-queue`, `/attendance/ledger`, `/call-center`, and `/agents`, and
posts or patches assignments and agent settings through the same API.

## Current pages

- Operations overview: live attendance metrics, call pipeline, and recent assignments
- Attendance management: organization-scoped session filters and CSV export
- Duty schedules: saved assignments and scheduled check-in/check-out times
- AI call center: active provider calls, durable retries, and API-backed agent configuration
- Exceptions: live not-answered and review statuses
- Supervision queue: prioritized no-answer, verification, and check-out review
- Approved attendance ledger: completed sessions and backend delivery state
- Staff records: staff derived from assignments with masked contact values
- Patient records: patients derived from assignments without live GPS data
- Verification engine: seven-point policy view with unavailable integrations called out
- New assignment: schedule check-in/check-out calls for an employee
- Session status: live check-in/check-out state, reported times, and
  `not_answered` exception flags
- Agents: live agent list from the backend

Page components live in `src/pages/`. Staff and patient records are derived
from attendance assignments rather than separate master directories. Recording
history and transcript browsing still need dedicated backend endpoints.
