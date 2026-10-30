#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

usage() {
  printf 'Usage: ./scripts/deploy.sh [--ingress] [--no-pull]\n'
  printf '  --ingress  Add private gateway for the standalone vps-infra Caddy ingress\n'
  printf '  --no-pull  Deploy this checked-out commit without git pull\n'
}

with_ingress=false
pull=true
for arg in "$@"; do
  case "$arg" in
    --ingress) with_ingress=true ;;
    --no-pull) pull=false ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

for command in docker git curl; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
docker compose version >/dev/null
test -s .env || { echo "Missing .env. Configure credentials from .env.example." >&2; exit 1; }

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Refusing deployment: tracked files have local changes." >&2
  exit 1
fi

if "$pull"; then
  git pull --ff-only origin main
fi

compose=(docker compose -f compose.yaml)
if "$with_ingress"; then
  if ! docker network inspect vps_ingress >/dev/null 2>&1; then
    docker network create --driver bridge vps_ingress >/dev/null
    echo 'Created shared vps_ingress Docker network.'
  fi
  compose+=(-f compose.ingress.yaml)
fi

"${compose[@]}" config --quiet
echo "Deploying Relay commit $(git rev-parse --short HEAD)..."
"${compose[@]}" up -d --build --wait
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8765/health
printf '\n'
"${compose[@]}" ps
echo "Relay healthy."
if "$with_ingress"; then
  # A healthy Relay server is insufficient: verify that the gateway really
  # inserts its server-side API token, without sending secrets to the browser.
  "${compose[@]}" exec -T gateway wget -q -O /dev/null http://127.0.0.1:8080/api/status || {
    echo "Relay internal gateway API auth probe failed; check Caddy token injection." >&2
    exit 1
  }
  echo "Relay gateway API auth probe passed."
  echo "Private gateway ready; standalone vps-infra Caddy serves the public hostname."
else
  echo 'For relay.affankhan.dev use ./scripts/deploy.sh --ingress'
fi
