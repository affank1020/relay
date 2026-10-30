#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
docker compose -f compose.yaml ps
echo
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8765/health
printf '\n'
if docker ps --format '{{.Names}}' | grep -qE '^relay-gateway-[0-9]+$'; then
  docker compose -f compose.yaml -f compose.ingress.yaml ps gateway
fi
