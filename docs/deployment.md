# Deploy Relay through Atlas's existing Caddy ingress

Relay is an **independent** Docker Compose stack on the same VPS. Atlas Caddy already owns HTTPS on host ports 80/443, with Basic Auth on the human-facing UI. Relay uses that same username/password, not a new Cloudflare Access policy or Tunnel.

## Request path

~~~text
Browser HTTPS -> atlas ingress Caddy (TLS + Atlas Basic Auth)
               -> private shared relay_ingress Docker network
               -> relay-gateway:8080 (replaces Authorization with server token)
               -> relay:8765 (Pi/OpenRouter)
~~~

Only Atlas's `ingress` and Relay's `gateway` containers should be members of `relay_ingress`. Relay's API container remains on its private default network, with an optional maintenance port bound to VPS loopback (`127.0.0.1:8765`). The gateway must **never** publish a public or host port: it relies on the Atlas ingress for user authentication. Containers with access to the shared network are trusted, so do not attach unrelated workloads there.

## First deployment

1. Add the DNS-only Cloudflare A record `relay.affankhan.dev` to the same VPS public IP as Atlas (this was configured separately). Do not create a Cloudflare Tunnel. If one was already created, remove its conflicting route.
2. Merge and deploy the Atlas Caddy ingress change, which defines a **separate** `relay.affankhan.dev` Caddy site protected with `ATLAS_ADMIN_USER` and `ATLAS_ADMIN_PASSWORD_HASH`, forwarding to `relay-gateway:8080`. The Atlas GitHub Actions deployment creates the shared network if needed before starting Compose. Until Relay runs, this hostname may return 502, but existing Atlas routes remain unchanged.
3. On the VPS, retain the existing `~/relay/.env` values for `RELAY_ACCESS_TOKEN`, `OPENROUTER_API_KEY`, and a free `RELAY_MODEL=...:free`. **No new Basic Auth or Cloudflare credentials are needed.**
4. Run:

~~~bash
cd ~/relay
git pull --ff-only
./scripts/deploy.sh --ingress
./scripts/status.sh
~~~

You can run step 4 before Atlas deploys if preferred. The Relay script also creates `relay_ingress` if absent. On normal updates, only `./scripts/deploy.sh --ingress` is needed.

## Verify protection and inference

Open `https://relay.affankhan.dev` in a private browser window. Enter **the same Atlas username/password** when challenged. Relay should load without asking for the Relay token a second time. The token is privately injected by the gateway.

From a terminal without HTTP Basic Auth credentials:

~~~bash
curl -i https://relay.affankhan.dev/
~~~

Expected: `401 Unauthorized` with `WWW-Authenticate: Basic`. Any unauthenticated access to the web UI or API means the ingress protection is misconfigured and the hostname should be disabled until fixed.

Check services on the VPS:

~~~bash
cd ~/relay
docker compose -f compose.yaml -f compose.ingress.yaml ps
docker compose -f compose.yaml -f compose.ingress.yaml logs --tail=50 gateway
curl -f http://127.0.0.1:8765/health
~~~

The health endpoint only confirms server startup. Verify a Pi model response by sending a message from the browser. The direct loopback API still requires `RELAY_ACCESS_TOKEN`.

## Security and limitations

- Atlas ingress uses HTTPS and Caddy Basic Auth; Basic Auth is not shared-session SSO, but browsers may reuse or ask for credentials at each hostname.
- The **Atlas** container does not receive `RELAY_ACCESS_TOKEN`. The private gateway replaces the browser's Basic Authorization header before proxying to Relay.
- Never publish gateway port 8080 or attach untrusted containers to `relay_ingress`.
- Caddy TLS certificates are obtained using the existing Atlas ingress mechanism.
- The script uses fast-forward-only Git pull and refuses dirty tracked files.
- Free OpenRouter models can impose quotas and provider-specific data policies.
- Pi shell and filesystem tools are disabled and Atlas MCP integration is not yet implemented.
- Sessions are in memory; restarts lose conversations.
