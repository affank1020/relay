#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

usage() {
  printf 'Usage: ./scripts/deploy.sh [--tunnel] [--no-pull]\n'
  printf '  --tunnel   Enable Caddy Basic Auth + Cloudflare Tunnel (requires credentials and TUNNEL_TOKEN in .env)\n'
  printf '  --no-pull  Deploy checked-out code without git pull\n'
}

with_tunnel=false
pull=true
for arg in "$@"; do
  case "$arg" in
    --tunnel) with_tunnel=true ;;
    --no-pull) pull=false ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

for command in docker git curl; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
docker compose version >/dev/null
test -s .env || { echo "Missing .env; copy .env.example and configure credentials first." >&2; exit 1; }

# Never deploy a dirty checkout or overwrite an operator's changes.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Refusing deployment: tracked files contain local changes." >&2
  exit 1
fi

if "$pull"; then
  git pull --ff-only origin main
fi

compose=(docker compose -f compose.yaml)
if "$with_tunnel"; then
  compose+=(-f compose.tunnel.yaml --profile tunnel)
fi

# The -q flag avoids printing credentials interpolated from .env.
"${compose[@]}" config --quiet
echo "Deploying Relay commit $(git rev-parse --short HEAD)..."
"${compose[@]}" up -d --build --wait

# Verify host loopback independently of Docker health status.
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8765/health
printf '\n'
"${compose[@]}" ps
echo "Relay deployment healthy."
if ! "$with_tunnel"; then
  echo "For relay.affankhan.dev, follow docs/deployment.md then run ./scripts/deploy.sh --tunnel"
fi
