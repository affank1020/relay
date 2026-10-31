# Local development

Relay is developed on the Mac, not in the production VPS checkout.
PR #8 is merged; this branch starts from main `033d0c318599ef375b172b3f67759fd1efdeaf4d`.

## Install and validate

Use Node 22.19+ (CI and production use Node 22), with npm on PATH:

```sh
npm ci --include=dev --ignore-scripts --no-audit --no-fund
npm run verify
```

The committed lockfile is shared by Docker and CI. Update it deliberately with dependency changes.
`npm run check` / `npm run typecheck` typecheck; `npm run build` creates dist;
`npm test` builds first, then tests the generated browser, HTTP application and compiled real Pi server.
Tests use dummy credentials and do not prompt an external model. Pi startup can refresh its public model catalog.
HTTP fixtures simulate agent responses/failures; they do not prove live inference or Atlas integration.
Browser auth tests execute the bundle in a DOM fixture; they are not Playwright end-to-end tests.

For interactive local chat, configure the variables in .env.example in your shell
(or use Node's --env-file option with a private local .env), build, and start:
`node --env-file=.env dist/server.js`.
Use HOST=127.0.0.1 for local-only access. Never copy production secrets into test fixtures.
RELAY_MAX_ACTIVE must be an integer from 1 to 4; invalid values fail startup.
Conversation metadata, task lifecycle, approvals and execution events now persist in a Relay-only SQLite file inside RELAY_DATA_DIR (default `.relay/`). Pi session files are stored beneath the same directory and the Docker configuration mounts a dedicated `relay_data` volume. Active work at restart is marked interrupted and requires reconciliation before retrying. Back up this volume before deployments and do not share its database with Atlas.

## UI-only localhost preview

For styling and chat-layout iteration without configuring an Atlas MCP token,
Ollama, Pi or production credentials:

```sh
npm ci --include=dev --ignore-scripts --no-audit --no-fund
npm run dev:ui
```

Open `http://localhost:4173`. The server binds to `127.0.0.1` only, uses
**sample** conversations/model choices/Atlas receipts (no actual inference or
Atlas operations), and reloads when `public/index.html`, `public/style.css`,
or bundled `src/client.ts` changes. Restart after editing `scripts/dev-ui.mjs`.
Stop with Ctrl+C. This preview is not a production backend or a security smoke test.

## Atlas Mac execution

- Node: Affans-MacBook-Pro-2.local, ID fe7984f9-c7fb-42fd-ac89-4480bc9734a2.
- Checkout: Relay (Mac), ID 59c7c5ad-a3c0-4667-913d-66285303ea51.
- Logical Workspace: 2c8c679b-2376-4655-8025-467eb0ee3a54.
- Root: /Users/affankhan/Documents/GitRepos/relay.

Use workspace file/Git tools for supported operations. Atlas currently requires atlas/* feature
branches; no arbitrary remote command endpoint is needed. Dependency installation and fetching/fast-forwarding
main currently need a trusted local operator because the Workspace tools do not expose them.

At inspection, workspace_list_dev_tasks returned an empty list. The reviewed configuration
[mac-dev-tasks.json](mac-dev-tasks.json) defines bounded check/typecheck/build/test/verify argv,
with no secrets passed through. These execute repository code, so review the checkout before running.

### One-time administrator setup

1. Install dependencies locally using the command above.
2. On the Atlas Server's trusted administrative environment, use its existing
   scripts/configure-workspace-dev-tasks.mjs with a copy of docs/mac-dev-tasks.json:
   `node scripts/configure-workspace-dev-tasks.mjs 59c7c5ad-a3c0-4667-913d-66285303ea51 /absolute/path/mac-dev-tasks.json`.
   Run from the Atlas repository, with its normal private DATABASE_URL configuration.
   Do not put that database credential in Relay or in a tool payload.
3. **Current blocker:** the inspected Atlas script joins an active Project, but Relay (Mac)
   has projectId=null. Before step 2, the owner must select and link the intended active
   Atlas Project using link_workspace_project, or Atlas must add support for projectless
   administrative task configuration. Do not invent a Project association or change the SQL ad hoc.
4. Ensure npm and Node are available on the Mac Node service PATH (interactive nvm PATH
   may differ). If needed, set the JSON executable to the owner's installed absolute npm path.
5. Call workspace_list_dev_tasks for the checkout; then workspace_run_dev_task with task=verify.
   Record returned nodeId, exitCode, success, timedOut and truncation flags. Listing or selecting
   a Node is not proof that it executed tests.

Atlas also has optional ATLAS_NODE_AUTO_SCRIPTS=1 discovery in inspected source. It is off by
default and broader than this Workspace; do not enable it globally just to avoid setup.
Until configuration is available, local terminal checks and GitHub Verify are the explicit fallback.

## CI and production

Verify retains typechecking, tests, TypeScript-only source checks, Compose/Caddy validation
and Docker build. A PR never deploys. Existing reviewed-main deployment, Basic Auth, token
injection, private networking and resource limits remain in place.
See [deployment](deployment.md) and [automatic deployment](auto-deploy.md) for rollback.
This change has no database migration; rollback uses the existing image/source procedure.

## Atlas MCP development integration (new)

Set `ATLAS_MCP_URL` and `ATLAS_MCP_TOKEN` **on the Relay server only** after obtaining an Atlas-authorized credential. Never put the token in public files or browser storage. Without the URL, Relay can chat but reports Atlas as not configured. Read-only tool calls are explicitly allowlisted; `workspace_run_dev_task` additionally requires a per-checkout task name in `RELAY_ATLAS_DEV_TASKS` (a JSON map), Atlas Node capability support, and a user approval. The Atlas owner must still configure the Node-side named development tasks. A green fixture test does not prove live credentials or operations; perform a separately recorded read-only smoke test before relying on the integration.

## Known verification limits

The integrated branch has CI coverage for compilation, HTTP fixtures, Pi SDK startup, scheduler behaviour and real MCP protocol fixtures. Playwright browser-level E2E tests, a credentialed live Atlas→Relay smoke test, detailed VPS load measurements and production rollback rehearsal have not been completed. Do not describe those as passed. The legacy `src/application.ts` tests cover the previous HTTP seam; the current production HTTP server lives in `src/platform.ts`.

## Relay → Atlas MCP service token (no Auth0 app required)

Relay is just another client of the existing Atlas MCP server. ChatGPT keeps
using Auth0 OAuth, while Relay authenticates with an independently generated,
high-entropy bearer token that never leaves the VPS application environments.

1. Generate one 32-byte random hex token on your trusted Mac/VPS:
   `openssl rand -hex 32`. Keep it out of chat, screenshots and command history.
2. Compute its SHA-256 digest using `printf '%s' "$token" | shasum -a 256`
   on macOS or `sha256sum` on Linux, without adding a newline.
3. In Atlas's private `~/atlas-deploy/infra/production.env`, set
   `ATLAS_MCP_RELAY_TOKEN_SHA256=<digest>` and deploy the Atlas service-token PR
   first. Keep the existing human Auth0 credentials unchanged.
4. In Relay's private `~/relay/.env`, set:

```dotenv
ATLAS_MCP_URL=https://atlas.affankhan.dev/mcp
ATLAS_MCP_TOKEN=YOUR_64_CHARACTER_RANDOM_HEX_TOKEN
```

5. Deploy Relay via `./scripts/deploy.sh --ingress --no-pull`.
   Use `docker compose -f compose.yaml -f compose.ingress.yaml config --quiet`
   to verify env interpolation without printing the token.
6. Smoke-test a real read-only `get_atlas_status` from the Relay chat.
   Confirm an Atlas mutation is not in the service-account tool catalogue.

Atlas compares the token's hash in constant time, and scopes this service
credential to server-enforced read-only MCP tools. Development task execution
and all mutations stay denied even if Relay's own client is modified.
Do not disable Auth0 for ChatGPT or expand Atlas permissions for an initial test.
Rotate both private settings and redeploy if the raw token is exposed.

## Chat management V1: rename, delete and schema V2

The production `src/platform.ts` API uses authenticated, same-origin
`PATCH /api/sessions/:id` with exactly `{"title":"..."}` (1–120 trimmed
characters, no control characters) and returns `200 {"session":...}`.
`DELETE /api/sessions/:id` returns `204` only after database and Pi
session-directory cleanup, `404` if absent and `409` for any active,
interrupted, dependent, awaiting-approval or uncertain invocation. Do not
silently cancel agents to permit deletion. Deletion can respond `503` after
the DB commit if filesystem cleanup fails; the chat is no longer visible and
a durable cleanup tombstone is retried on the next process start. The client
shows this failure without claiming a successful full purge.

**Schema migration:** Relay upgrades `PRAGMA user_version` from 1 to 2 in
one SQLite transaction. It adds a content-free `retired_usage` ledger and
`pending_session_deletions` table. A deleted conversation's entire task
usage is retired once in that transaction; global USD/token/unknown-usage
budget accounting is cumulative even after deletion and restart. Local
per-chat totals do not include retired usage. The delete transaction removes
tasks, event text, approval arguments and tool invocation results, then
records a cleanup tombstone. Pi session `.jsonl` directories are removed
without following symlinks. Pending tombstones never make history reappear.

**Predeployment backup:** stop Relay so no writer is active, and back up the
*entire* `RELAY_DATA_DIR` volume, including `relay.sqlite`, the optional
`-wal`/`-shm` files and the `sessions/` tree. Alternatively use SQLite's
`.backup` operation for the database plus a separate session-directory
backup while the service is stopped. Keep the backup access-controlled since
it contains private prompts and transcripts. Record the backup location,
validate that it can be restored and then deploy the V2 image. Do not just
copy a live WAL database file.

**Rollback:** V1 binaries deliberately refuse to open a V2 database.
Rollback therefore requires stopping Relay and restoring the full
pre-migration database *and* matching session backup before starting the V1
image. This restores old chat history and means any V2-era changes will be
lost. A permanent delete is not otherwise reversible. A same-schema V2
image rollback needs no database downgrade.

Verification: `npm run verify` exercises engine/store/HTTP fixtures;
GitHub Verify also runs deployment checks. Browser preview tests are
fixtures, not a production deletion or provider/Atlas integration test.
