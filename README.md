# Relay

Relay is a separate self-hosted AI agent control plane built on Pi and OpenRouter.

## Current MVP

- Streaming web chat, in-memory sessions and basic cost reporting.
- Free-only OpenRouter model safeguard (models must end in `:free`).
- Strong internal API bearer token and disabled Pi shell/file tools.
- VPS deployment with health checks and resource limits.
- **Atlas's existing HTTPS Caddy ingress and HTTP Basic Auth**, without a Cloudflare Tunnel or extra public port.

The public hostname `https://relay.affankhan.dev` uses **the same username/password as Atlas**. Atlas's Caddy ingress authenticates the browser, then forwards requests across a small shared Docker network to Relay's private gateway. The gateway substitutes the Relay backend token without sending that token to the browser or the Atlas ingress.

## Deployment

On the VPS, retain the existing private `~/relay/.env`:

~~~bash
cd ~/relay
git pull --ff-only
./scripts/deploy.sh --ingress
./scripts/status.sh
~~~

The first explicit pull is only needed to get the updated script; subsequent runs pull `main` automatically. The script ensures the shared `relay_ingress` network exists. The Atlas Caddy configuration must also be updated and deployed for public access.

Cloudflare only needs the DNS A record for `relay` pointing to the same VPS as Atlas. **Do not create a Cloudflare Tunnel or Access application for Relay.**

See [deployment documentation](docs/deployment.md) for deployment order, verification and security notes.

Atlas MCP orchestration, persistence, budgets and multi-agent execution are forthcoming. Don't send private data to free model providers without reviewing their policies.
