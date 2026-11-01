# Local development

Use Node 22.19+; CI and production use Node 22.

```sh
npm ci --include=dev --ignore-scripts
npm run verify
npx playwright install chromium
node --import tsx --test --test-timeout=65000 tests/*.browser.ts
```

The committed lockfile is shared by Docker and CI. Pi is pinned to 1.4.0. Scoped overrides patch its undici and minimatch dependencies; rerun real-runtime and Docker checks when updating them. Package installation scripts are disabled.

`npm run check` typechecks. `npm run build` produces production bundles. `npm test` builds and tests custom Relay policy, HTTP/UI behavior and real Pi sessions against fixture provider/MCP services. Fixtures do not prove live model or external service behavior. See [verification](verification.md).

For local chat, configure `.env.example` in a private `.env`, set `HOST=127.0.0.1`, build, then run `node --env-file=.env dist/server.js`. Set an OpenRouter API key or a private Ollama endpoint. The local-only configuration selects an available Ollama model by default. No cloud fallback is performed for unavailable local models.

`RELAY_MAX_ACTIVE` must be 1–4. Each admitted root can run up to four independent Pi children. SQLite product metadata and Pi JSONL live inside `RELAY_DATA_DIR` (default `.relay/`). Do not run two servers against one data directory. Back up the entire directory, including SQLite WAL, before deployment.

## UI preview

`npm run dev:ui` opens a fixture-only server at `http://localhost:4173`. It binds to loopback, uses sample data and reloads styling/client changes. It performs no inference or Atlas operations. Restart after changing `scripts/dev-ui.mjs`.

## Atlas

Configure `ATLAS_MCP_URL`, its authorized service token and optionally `ATLAS_WEB_ORIGIN` on the server. Enable the integration in the UI. General discovery needs no selected Project. Atlas owns read authorization; Relay exposes only reviewed read names and projects verified resources from native MCP results.

Named development tasks additionally require `RELAY_ATLAS_DEV_TASKS`, an Atlas-configured checkout/Node task and explicit approval. [mac-dev-tasks.json](mac-dev-tasks.json) is an example bounded command configuration. Check the current Atlas administration contract and Node capabilities before enabling it; old checkout IDs or historical Node status are not authority.

## CI and deployment

Verify checks types, tests, real Chromium, Compose/Caddy configuration and the production image. It also runs real Pi session/MCP fixtures inside the image with production-only dependencies, no external network and a read-only filesystem. PRs do not deploy; merging to main retains the existing CI-gated deployment workflow.

Follow [migration and rollback](migration.md), [deployment](deployment.md) and [automatic deployment](auto-deploy.md). Do not deploy this reconstruction until the owner reviews the final PR and chooses to merge.
