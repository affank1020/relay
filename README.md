# Relay

Relay is a self-hosted AI agent control plane. Inference comes from OpenRouter, Pi manages individual agent sessions, and Relay provides the web UI and orchestration boundary.

## Initial MVP

- Responsive web chat with Pi SDK streaming and an OpenRouter-backed model
- Session switcher, basic usage-cost display and health endpoint
- Bearer-protected API, with OpenRouter credentials held exclusively on the server
- Docker Compose deployment bound to VPS loopback
- Agent tools are disabled for this bootstrap; no VPS shell or file access

The initial release is **free-model-only**. OpenRouter free models have request quotas, and free providers may retain or train on submitted prompts, so do not send private code or secrets while testing. The model must be available in Pi's refreshed OpenRouter catalogue.

This is intentionally **chat-only**. Atlas MCP, persistent sessions, budget enforcement, remote execution and multi-agent orchestration come next. Sessions are in memory and are lost on restart.

## Deploy

On the VPS, with Docker Compose installed:

1. Clone https://github.com/affank1020/relay and enter the relay directory.
2. Copy .env.example to .env.
3. Generate a token with: openssl rand -hex 32
4. Put that value in RELAY_ACCESS_TOKEN and set your OPENROUTER_API_KEY in .env.
5. Initially, keep RELAY_MODEL=poolside/laguna-s-2.1:free. Relay rejects models without the :free suffix to prevent accidental paid inference. Check the current model at https://openrouter.ai/collections/free-models.
6. Run: docker compose up -d --build
7. Check: docker compose logs --tail=100 relay
8. Check: curl --fail http://127.0.0.1:8765/health

Before DNS, you can test through SSH port forwarding:

    ssh -L 8765:127.0.0.1:8765 YOUR_USER@YOUR_VPS

Then visit http://127.0.0.1:8765.

## Custom domain

For relay.affankhan.dev, configure a Cloudflare DNS record and add this Caddy block:

    relay.affankhan.dev {
        reverse_proxy 127.0.0.1:8765
    }

**Protect this hostname** with Cloudflare Access restricted to your identity and protect against bypass of Cloudflare at the origin (for example with a Caddy-side authentication check). Never expose an unprotected agent service or transmit the access token without HTTPS. Docker exposes port 8765 only to the VPS loopback interface. Relay's own API token is a second protection layer.

To update: git pull --ff-only && docker compose up -d --build

## Architecture boundary

Relay orchestrates; Pi executes model loops; OpenRouter provides inference; Atlas will provide remotely executed tools through MCP. A future Relay Tool Gateway will turn MCP tool activity into structured UI events in ordinary TypeScript, with no extra model calls. The Pi SDK supports custom tools and events; its default filesystem/shell tools remain disabled until an explicit permission and routing layer is built.

Pi SDK docs: https://pi.dev/docs/latest/sdk
