#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

usage() {
  echo "Usage: $0 <public-hostname>" >&2
  echo "Example: $0 calls.example.com" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage
DOMAIN="${1,,}"
if [[ ! "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]; then
  echo "Invalid hostname: $DOMAIN" >&2
  exit 2
fi
[[ -f "$ENV_FILE" ]] || { echo "Missing $ENV_FILE. Copy .env.docker.example to .env and fill the required settings first." >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker is not installed." >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required to safely update .env." >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required for the HTTPS health check." >&2; exit 1; }

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is missing. Install it, then rerun this script." >&2
  exit 1
fi

# Use sudo transparently when the current account cannot access the Docker daemon.
if docker ps >/dev/null 2>&1; then
  compose() { docker compose --env-file "$ENV_FILE" -f "$ROOT_DIR/docker-compose.yml" "$@"; }
else
  compose() { sudo docker compose --env-file "$ENV_FILE" -f "$ROOT_DIR/docker-compose.yml" "$@"; }
fi

python3 - "$ENV_FILE" "$DOMAIN" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
domain = sys.argv[2]
updates = {
    "PUBLIC_DOMAIN": domain,
    "PUBLIC_BASE_URL": f"https://{domain}",
    "VOBIZ_ANSWER_URL": f"https://{domain}/api/call-service/answer",
    "VOBIZ_HANGUP_URL": f"https://{domain}/api/call-service/webhooks/call-status",
}
lines = path.read_text().splitlines()
found = set()
output = []
for line in lines:
    match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=", line)
    key = match.group(1) if match else None
    if key in updates:
        output.append(f"{key}={updates[key]}")
        found.add(key)
    else:
        output.append(line)
for key, value in updates.items():
    if key not in found:
        output.append(f"{key}={value}")
path.write_text("\n".join(output) + "\n")
path.chmod(0o600)
PY

if ! getent ahostsv4 "$DOMAIN" >/dev/null; then
  echo "DNS for $DOMAIN does not resolve yet. Create an A record pointing to this VM's static external IP, wait for DNS propagation, then rerun." >&2
  exit 1
fi

python3 - "$ENV_FILE" <<'PY'
from pathlib import Path
import sys

values = {}
for line in Path(sys.argv[1]).read_text().splitlines():
    if line and not line.lstrip().startswith("#") and "=" in line:
        key, value = line.split("=", 1)
        values[key] = value
required = ["POSTGRES_PASSWORD", "MINIO_ROOT_PASSWORD", "MINIO_SECRET_KEY", "VOBIZ_STREAM_SECRET", "GOOGLE_CLOUD_PROJECT", "DEFAULT_ORGANIZATION_ID", "API_KEY_ADMIN_TOKEN"]
missing = [key for key in required if not values.get(key) or "replace-with" in values[key].lower() or "example-project" in values[key].lower()]
if missing:
    print("Fill these .env values before deployment: " + ", ".join(missing), file=sys.stderr)
    sys.exit(1)
PY

echo "Checking Compose configuration..."
compose config --quiet
echo "Building and starting services..."
if ! compose up --build -d; then
  echo "Deployment failed. Recent service logs:" >&2
  compose logs --tail=100 caddy minio minio-init backend-migrate backend-api backend-worker >&2 || true
  exit 1
fi

echo "Waiting for HTTPS health check at https://$DOMAIN/healthz ..."
for attempt in $(seq 1 60); do
  if curl --silent --show-error --fail --connect-timeout 5 "https://$DOMAIN/healthz" >/dev/null 2>&1; then
    echo "Deployment is healthy: https://$DOMAIN"
    echo "Vobiz answer URL: https://$DOMAIN/api/call-service/answer"
    echo "Vobiz inbound answer URL: https://$DOMAIN/api/call-service/incoming/answer"
    echo "Vobiz status URL: https://$DOMAIN/api/call-service/webhooks/call-status"
    compose ps
    exit 0
  fi
  sleep 5
done

echo "HTTPS health check did not pass. Check that GCP firewall ingress allows TCP 80 and 443 and that DNS points to this VM." >&2
compose ps >&2 || true
compose logs --tail=100 caddy backend-api >&2 || true
exit 1
