#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage:
  bash skills/attendance-stack-reset/scripts/reset-and-create-admin.sh --check
  bash skills/attendance-stack-reset/scripts/reset-and-create-admin.sh --execute

Run from the attendance-call-service deployment root. This deletes this
Compose project's persistent volumes, recreates the app, and provisions a
new admin account. It does not delete Docker images or unrelated projects.
USAGE
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

MODE="${1:-}"
if [[ "$MODE" != "--execute" && "$MODE" != "--check" || "$#" -ne 1 ]]; then
  usage >&2
  exit 2
fi

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ -f docker-compose.yml ]] || fail "Run this from the attendance app deployment directory; docker-compose.yml was not found."
[[ -f .env ]] || fail "The real .env file is missing. Do not substitute an example file."
[[ -f backend/scripts/create-web-user.js ]] || fail "This checkout does not contain the attendance app admin provisioning script."
grep -Eq '^name:[[:space:]]*athulya-attendance[[:space:]]*$' docker-compose.yml || fail "Compose project name is not athulya-attendance; refusing to reset an unknown stack."

if docker info >/dev/null 2>&1; then
  USE_SUDO=0
else
  sudo -v
  sudo -n docker info >/dev/null 2>&1 || fail "Docker is unavailable, including through sudo."
  USE_SUDO=1
fi

compose() {
  if [[ "$USE_SUDO" == "1" ]]; then
    sudo -n docker compose --env-file .env -f docker-compose.yml "$@"
  else
    docker compose --env-file .env -f docker-compose.yml "$@"
  fi
}

compose config --quiet || fail "Compose configuration is invalid; nothing has been removed."

services="$(compose config --services)"
for required_service in postgres backend-api backend-worker backend-migrate mock-athulya; do
  grep -Fxq "$required_service" <<<"$services" || fail "Expected service '$required_service' is missing; refusing to reset this project."
done

for required_mount in postgres_data minio_data caddy_data caddy_config; do
  grep -Eq "^[[:space:]]*-[[:space:]]*${required_mount}:" docker-compose.yml || fail "Expected persistent volume '$required_mount' is missing; refusing to reset this project."
done

if [[ "$MODE" == "--check" ]]; then
  printf 'Preflight passed for the athulya-attendance Compose project. No services or data were changed.\n'
  exit 0
fi

read -r -p "New admin email: " ADMIN_EMAIL
read -r -p "New admin display name: " ADMIN_NAME
read -r -s -p "New admin password (12+ characters): " ADMIN_PASSWORD
printf '\n'
trap 'unset ADMIN_PASSWORD' EXIT

[[ "$ADMIN_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || fail "Enter a valid admin email."
(( ${#ADMIN_PASSWORD} >= 12 && ${#ADMIN_PASSWORD} <= 1024 )) || fail "Password must be between 12 and 1024 characters."
[[ "$ADMIN_PASSWORD" != *$'\n'* ]] || fail "Password cannot contain a newline."

printf '\nThis permanently deletes the athulya-attendance database, recordings, and Caddy certificate/config volumes.\n'
printf 'Type exactly WIPE athulya-attendance to continue: '
IFS= read -r confirmation
[[ "$confirmation" == "WIPE athulya-attendance" ]] || fail "Confirmation did not match; nothing has been removed."

printf '\nRemoving this Compose project and its volumes...\n'
compose down --volumes --remove-orphans

printf '\nRecreating the attendance app...\n'
compose up -d --build

printf 'Waiting for the API health check'
api_ready=0
for _ in $(seq 1 60); do
  if compose exec -T backend-api node -e 'fetch("http://127.0.0.1:"+process.env.PORT+"/healthz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then
    api_ready=1
    break
  fi
  printf '.'
  sleep 2
done
printf '\n'
[[ "$api_ready" == "1" ]] || fail "The API did not become healthy. Volumes are already reset and the stack was recreated; inspect Compose logs, then provision the admin after fixing startup."

printf '%s\n%s\n%s\n' "$ADMIN_EMAIL" "$ADMIN_NAME" "$ADMIN_PASSWORD" |
  compose exec -T backend-api node scripts/create-web-user.js
unset ADMIN_PASSWORD

printf '\nReset complete. Admin provisioning succeeded for %s.\n' "$ADMIN_EMAIL"
printf 'Verify the login in the app before importing fresh mock schedules.\n'
