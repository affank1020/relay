# Relay

Relay is a separate self-hosted AI agent control plane built on Pi and OpenRouter.

## Development

Relay is TypeScript-only at source level; `npm run check && npm run build && npm test` validates the compiled Node and browser bundles. See [TypeScript development](docs/typescript.md).

## Current MVP

- Streaming web chat, in-memory sessions and basic cost reporting.
- Free-only OpenRouter model safeguard (models must end in `:free`).
- Strong internal API bearer token and disabled Pi shell/file tools.
- VPS deployment with health checks and resource limits.
- **Standalone vps-infra HTTPS Caddy ingress with the existing Atlas Basic Auth credentials**, without a Cloudflare Tunnel or extra public port.

The public hostname `https://relay.affankhan.dev` uses **the same username/password as Atlas**. The vps-infra Caddy ingress authenticates the browser, then forwards requests across a small shared Docker network to Relay's private gateway. The gateway substitutes the Relay backend token without sending that token to the browser or the Atlas ingress.

## Automatic deployment

Merges into `main` trigger [Relay's GitHub Actions deployment](docs/auto-deploy.md) **after Verify CI passes**, independently of Atlas. One-time Relay GitHub deployment secrets are required; see the runbook. No VPS timer or manual deploy command is needed for future releases after configuration.

## Deployment

On the VPS, retain the existing private `~/relay/.env`:

~~~bash
cd ~/relay
git pull --ff-only
./scripts/deploy.sh --ingress
./scripts/status.sh
~~~

The first explicit pull is only needed to get the updated script; subsequent runs pull `main` automatically. The script ensures the shared `vps_ingress` network exists. The separate vps-infra repository contains the staged public-ingress cutover and rollback; do not deploy the public proxy until the migration preflight has passed.

Cloudflare only needs the DNS A record for `relay` pointing to the same VPS as Atlas. **Do not create a Cloudflare Tunnel or Access application for Relay.**

See [deployment documentation](docs/deployment.md) for deployment order, verification and security notes.

Atlas MCP orchestration, persistence, budgets and multi-agent execution are forthcoming. Don't send private data to free model providers without reviewing their policies.

**Hosted authentication:** `https://relay.affankhan.dev` needs only the shared VPS Basic Auth username/password. The private gateway injects `RELAY_ACCESS_TOKEN`; do not enter that token into the hosted browser. Direct `http://127.0.0.1:8765` access still prompts for the separate API token.
