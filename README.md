# Relay

Relay is a self-hosted AI agent control plane. **Pi** manages individual agent sessions, **OpenRouter** provides model inference, and Relay owns the web UI and orchestration boundary.

## Current MVP

- Web chat with Pi SDK streaming, a session switcher and basic cost visibility.
- Server-side OpenRouter API key and bearer-protected API.
- Docker Compose deployment with health checks and resource limits.
- Optional Cloudflare Tunnel + Caddy Basic Auth for `https://relay.affankhan.dev`.
- Free-model-only safeguard: model ID must end in `:free`.
- Pi filesystem and shell tools are **disabled** until remote tool routing and permissions are implemented.

Current limitations: conversations are stored only in memory and disappear on restart; Atlas MCP, budgets and multi-agent orchestration are not yet enabled. Do not send private code to free providers until you review their data policies.

## VPS deployment and updates

Already running Relay on the VPS? Keep your existing `.env`, then use:

~~~bash
cd ~/relay
git pull --ff-only
./scripts/deploy.sh
./scripts/status.sh
~~~

The script itself pulls `main` with `--ff-only`; the explicit pull above is only needed to fetch the script on first use.

For the public hostname, configure Caddy Basic Auth credentials and create a Cloudflare Tunnel published route **to `http://gateway:8080`** as described in **[deployment instructions](docs/deployment.md)**. Then set `TUNNEL_TOKEN` in your private `.env` and run:

~~~bash
./scripts/deploy.sh --tunnel
~~~

This avoids editing the existing Atlas Caddy ingress, which runs in Docker and already owns ports 80/443. No new VPS public ports are required. Caddy protects the site with the same kind of username/password prompt as Atlas; Caddy securely injects the internal Relay token for API requests so the browser only logs in once.

The initial dashboard is intentionally chat-only. Tool activity will eventually flow through a Relay gateway using deterministic TypeScript event translation—**no extra model calls** for UI rendering.

See [docs/deployment.md](docs/deployment.md) for one-time Cloudflare setup, security requirements, diagnostics and ongoing updates.

Pi SDK docs: https://pi.dev/docs/latest/sdk
