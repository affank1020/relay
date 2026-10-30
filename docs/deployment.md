# Deploy Relay to relay.affankhan.dev

Relay is designed to run alongside Atlas without touching the Atlas Caddy ingress or its production Compose stack.

## Why a Cloudflare Tunnel?

Atlas's `infra/docker-compose.production.yml` runs Caddy **inside its own ingress container**, which already publishes VPS ports 80 and 443. A second host-level Caddy stanza will not take effect there. Relay therefore offers a dedicated `cloudflared` service which makes an **outbound** connection to Cloudflare, using Docker networking to reach the Relay container. It publishes no additional VPS ports.

Architecture:

~~~text
Browser -> Cloudflare Access -> Cloudflare Tunnel
                                 |
                           cloudflared (Relay stack)
                                 |
                            http://relay:8765
                                 |
                         Pi -> OpenRouter
~~~

Relay still exposes `127.0.0.1:8765` on the VPS for SSH tunnel testing. The Relay HTTP API requires a strong access token, independent of Cloudflare Access.

## One-time VPS setup

Use the existing `~/relay` checkout on the VPS:

~~~bash
cd ~/relay
test -s .env || cp .env.example .env
chmod 600 .env
~~~

Keep the values you've already configured for `RELAY_ACCESS_TOKEN` and `OPENROUTER_API_KEY`. Do **not** paste either one into chat or commit `.env` to the repository. For initial testing, keep the free model `poolside/laguna-s-2.1:free`.

From this point forward use:

~~~bash
./scripts/deploy.sh
./scripts/status.sh
~~~

The deploy script pulls `main` with `--ff-only`, validates the Compose configuration, builds the image, waits for the Relay health check, then verifies the loopback endpoint. It stops rather than overwriting tracked local changes. To build an already checked-out commit, use `./scripts/deploy.sh --no-pull`.

## Cloudflare one-time configuration

**Set up Access before creating the publicly reachable tunnel route.** In the Cloudflare Zero Trust dashboard:

1. Go to **Access -> Applications**, create a **Self-hosted** application for `relay.affankhan.dev`, and add a policy allowing **only your identity** (for example, an allow rule on your verified email). Test that policy in a separate browser session. Never choose an allow-everyone policy.
2. Go to **Networking -> Tunnels**. Create a remotely managed tunnel named `relay-vps`. Select Docker for the connector.
3. Under the tunnel's **Routes**, add a **Published application** for hostname `relay.affankhan.dev`. Set the **Service URL to `http://relay:8765`**, not `http://localhost:8765`: `cloudflared` and Relay are separate containers on the same Compose network. Cloudflare normally creates the CNAME for a published application automatically; resolve any pre-existing conflicting DNS record first.
4. Copy only the **tunnel token** (`eyJ...`) from the connector's installation command. Do not run a separate Cloudflare Docker container command; Relay already provides one.
5. On the VPS, append `TUNNEL_TOKEN=...` to the private `~/relay/.env` file. Keep `.env` readable only by its owner.

Cloudflare's tunnel token is a credential: anyone holding it can connect a replica. Rotate it in Cloudflare if exposed.

Now enable the managed tunnel with:

~~~bash
cd ~/relay
./scripts/deploy.sh --tunnel
docker compose -f compose.yaml -f compose.tunnel.yaml --profile tunnel logs --tail=50 tunnel
~~~

The tunnel's published service URL works because the cloudflared container joins Relay's private Compose network. **No Atlas configuration changes or public firewall openings are required.**

Open https://relay.affankhan.dev from a separate browser or private window. You should first encounter Cloudflare Access authentication, then Relay's own token prompt. If the site can be opened anonymously, fix the Access policy immediately.

## Updating Relay

For a tunnel-enabled deployment:

~~~bash
cd ~/relay
./scripts/deploy.sh --tunnel
~~~

Without Cloudflare Tunnel: `./scripts/deploy.sh`.

Check the service with `./scripts/status.sh`. To diagnose model errors (without printing credentials):

~~~bash
docker compose logs --tail=80 relay
~~~

For tunnel connectivity errors:

~~~bash
docker compose -f compose.yaml -f compose.tunnel.yaml --profile tunnel logs --tail=80 tunnel
~~~

Container restart policies keep both services running across VPS restarts. Deployments are manual for now. This repository does not contain SSH private keys, Cloudflare API tokens, or automatic GitHub Actions deployment credentials.

## Resource and security boundaries

- Only the loopback port is mapped from the Relay container to the VPS.
- The cloudflared service makes outbound connections; no additional inbound host ports are needed.
- The tunnel token is passed only to the cloudflared service, **not** to the Pi process.
- The Pi process runs as an unprivileged user with a read-only root filesystem; only a small writable tmpfs is available.
- Pi's default shell and file tools are disabled. Atlas MCP integration is not yet implemented.
- Model calls are restricted to `:free` model identifiers in this initial version. Free providers may impose usage limits and data-retention policies.
- Conversation sessions are currently in-memory. Upgrades/restarts will lose them until persistence is implemented.

## Future option: share the existing Caddy ingress

If you prefer to route this hostname through Atlas's Caddy instead of using a tunnel, modify Atlas's `infra/Caddyfile.production`, ensure the Atlas ingress container can reach Relay through a reviewed private network, and redeploy the Atlas ingress image. **Do not** just add a new Caddyfile on the VPS host: the Atlas Caddy process runs inside Docker. Keep this as a separate, reviewed infrastructure change.
