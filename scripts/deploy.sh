#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

usage() {
  printf 'Usage: ./scripts/deploy.sh [--ingress] [--no-pull]\n'
  printf '  --ingress  Add private gateway for the Atlas Caddy ingress\n'
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
  if ! docker network inspect relay_ingress >/dev/null 2>&1; then
    docker network create --driver bridge relay_ingress >/dev/null
    echo 'Created shared relay_ingress Docker network.'
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
  echo "Private gateway ready; Atlas Caddy must be updated to enable the public hostname."
else
  echo 'For relay.affankhan.dev use ./scripts/deploy.sh --ingress'
fi
