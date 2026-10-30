# Relay behind standalone VPS ingress

Relay is independently deployed. Public HTTPS belongs to [vps-infra](https://github.com/affank1020/vps-infra), not Atlas's application repository.

## Request path

~~~text
Browser -> vps-infra Caddy (TLS + the existing Atlas username/password)
        -> private vps_ingress bridge -> relay-gateway:8080
        -> relay:8765 (Pi and OpenRouter)
~~~

The gateway receives only authenticated traffic from the standalone Caddy ingress, replaces the Basic Authorization header with Relay's server-side Bearer token, and forwards to the Relay app. No gateway host port is published. The Relay server remains bound only to VPS loopback for SSH maintenance. Do not add untrusted Docker services to the shared bridge.

## Deploy Relay's gateway (before public ingress cutover)

Retain your private VPS `~/relay/.env` with `RELAY_ACCESS_TOKEN`, `OPENROUTER_API_KEY`, and the free-only model.

~~~bash
cd ~/relay
git pull --ff-only
./scripts/deploy.sh --ingress
./scripts/status.sh
~~~

This ensures the `vps_ingress` bridge exists and starts Relay's gateway privately. Public DNS routing is handled only by the separate `vps-infra` stack; do not attempt to publish this gateway directly.

**Public cutover:** Follow the reviewed [vps-infra migration runbook](https://github.com/affank1020/vps-infra/blob/main/docs/migration.md). The legacy Atlas public Caddy must be moved off ports 80/443 before vps-infra can listen. Atlas's existing Basic Auth and MCP/Node exceptions are preserved.

After the cutover, open `https://relay.affankhan.dev`. It should challenge for the same username/password as Atlas, without prompting for the internal Relay token. `curl -i https://relay.affankhan.dev/` without credentials must return 401. Test an actual free-model chat response after login.

The gateway's port 8080 must stay private, and secrets must never be committed.
## Hosted authentication and login loops

For `https://relay.affankhan.dev`, use the shared VPS username/password only. Browser requests must not include a Bearer Authorization header because it overrides the browser's HTTP Basic credentials and triggers repeated proxy login challenges. The frontend now suppresses the internal access-token prompt for HTTPS-hosted Relay, and shows a retryable gateway error instead. A direct loopback `http://127.0.0.1:8765` connection still requires the Relay API token.

The deploy script now probes `/api/status` through the **internal gateway** and fails if its server-side token injection does not work. Never copy or paste the Relay token into browser debugging output.
