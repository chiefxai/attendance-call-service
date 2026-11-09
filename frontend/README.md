# Attendance calling frontend

React + TypeScript app using MUI for UI components, Axios for backend requests,
TanStack React Query for server state, and React Router for page navigation.

## Run locally

```sh
npm install
cp .env.example .env.local
npm run dev
```

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
