---
name: deployment-triage
description: Find and fix the root cause of a failed GitHub Actions deployment for the attendance call service. Use for failed or unhealthy main-branch deployments, including build, SSH/IAP, Docker, migration, and HTTPS health-check failures.
---

# Diagnose deployment failures

Use this skill when a deploy workflow fails, stalls, or reports unhealthy services. Start with evidence from the exact run and follow the failure to its source. Do not infer the cause from the final nonzero exit alone.

## Inspect the failed run

1. Read the latest `main` commit and recent runs for `chiefxai/attendance-call-service` using GitHub Actions tools (`actions/runs?per_page=10`). Match the run to the commit the user is deploying.
2. Fetch job summaries, then fetch logs only for failed jobs. Identify the first causal error and the step where it occurred. Include a small amount of surrounding log context; avoid dumping the full runner log into the conversation.
3. Classify the failure before changing anything:
   - GitHub auth, Workload Identity, gcloud, IAP, or SSH setup
   - remote checkout or deployment script
   - Docker build, including frontend TypeScript/Vite errors
   - migration or service startup/health dependency
   - public HTTPS/health check after services start
4. Inspect the workflow/script and only the source files implicated by the logs. Compare against the exact run SHA, not an older local checkout.

## Follow through to the failing layer

- **Build failure:** use the compiler's first actionable error. Reproduce the relevant package build when dependencies are available. Fix the source or build configuration, then confirm the same build succeeds before pushing.
- **IAP/SSH failure:** distinguish authentication from instance permissions, zone/project mismatch, SSH key propagation, and VM reachability. Inspect the workflow's gcloud command and IAM setup. Never print credentials or service-account key contents.
- **Compose/startup failure:** inspect `docker compose ps -a`, then logs for only the failed service and its immediate dependencies (typically `backend-api`, `backend-worker`, `backend-migrate`, `postgres`, `minio`, and `caddy`). Look for the first startup error, not just downstream dependency failures.
- **VM resource or health failure:** inspect `free -h`, `df -h`, `docker stats --no-stream`, container health, and relevant kernel/service logs. Check `curl -fsS https://calls.elvoryx.in/healthz` only after confirming the proxy and API are running.
- **Provider or agent issue:** use targeted time-bounded logs (`--since`, `--timestamps`, `--no-color`) and filter by the service's Vobiz, Vertex, worker, or error prefixes. Redact phone numbers, tokens, and personal caller data from any report.

Useful VM commands (run from the deployment checkout):

```sh
sudo docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.vertex-credentials.yml ps -a

sudo docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.vertex-credentials.yml \
  logs --since=15m --timestamps --no-color backend-api backend-worker backend-migrate

free -h
df -h
sudo docker stats --no-stream
curl -fsS https://calls.elvoryx.in/healthz
```

Never use `cat .env`, print resolved Compose configuration, or dump environment variables while gathering diagnostics. Keep command output focused and redact sensitive values.

## Fix, deploy, and verify

- Make the smallest correction that addresses the observed cause. Preserve unrelated workspace changes.
- If the user asked to fix the deployment, commit and push the correction to `main` with a fast-forward update; this repository's production workflow is main-only. Do not force-push.
- Follow the new workflow run through completion. Verify the build/deploy steps and public health check succeeded before reporting deployment as fixed. If the run fails again, inspect that new run rather than assuming the old root cause remains.
- Report the exact cause, correction, commit and workflow links, checks performed, and remaining failure state. Do not expose secrets or unredacted patient/staff data.
