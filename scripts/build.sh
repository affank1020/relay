#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
# Only TypeScript is authored. JavaScript is generated into ignored dist/.
rm -rf dist
mkdir -p dist/public
./node_modules/.bin/esbuild src/server.ts --bundle --platform=node --format=esm --target=node22 --packages=external --outfile=dist/server.js
./node_modules/.bin/esbuild src/healthcheck.ts --platform=node --format=esm --target=node22 --outfile=dist/healthcheck.js
# Child Pi subagent extension is loaded from an exact reviewed absolute path.
./node_modules/.bin/esbuild src/pi-child-mcp-extension.ts --bundle --platform=node --format=esm --target=node22 --packages=external --outfile=dist/pi-child-mcp-extension.js
# Standalone operator smoke: bundled TS sources with external runtime dependencies.
# The production image contains dist/ but intentionally excludes tsx/dev tools.
./node_modules/.bin/esbuild scripts/atlas-smoke.ts --bundle --platform=node --format=esm --target=node22 --packages=external --outfile=dist/atlas-smoke.js
./node_modules/.bin/esbuild scripts/pi-smoke.ts --bundle --platform=node --format=esm --target=node22 --packages=external --outfile=dist/pi-smoke.js
./node_modules/.bin/esbuild src/client.ts --bundle --platform=browser --format=iife --target=es2022 --outfile=dist/public/app.js
cp public/index.html public/style.css dist/public/
