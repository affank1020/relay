#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
echo "Relay container status:"
docker compose -f compose.yaml ps
echo
echo "Local health:"
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8765/health
printf '\n'
if docker ps --format '{{.Names}}' | grep -qE '^relay-tunnel-[0-9]+$'; then
  echo
  echo "Cloudflare Tunnel container:"
  docker ps --filter name=relay-tunnel --format 'table {{.Names}}\t{{.Status}}'
fi
