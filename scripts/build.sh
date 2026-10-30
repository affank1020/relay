#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
# Only TypeScript is authored. JavaScript is generated into ignored dist/.
rm -rf dist
mkdir -p dist/public
./node_modules/.bin/esbuild src/server.ts --platform=node --format=esm --target=node22 --packages=external --outfile=dist/server.js
./node_modules/.bin/esbuild src/healthcheck.ts --platform=node --format=esm --target=node22 --outfile=dist/healthcheck.js
./node_modules/.bin/esbuild src/client.ts --platform=browser --format=iife --target=es2022 --outfile=dist/public/app.js
cp public/index.html public/style.css dist/public/
