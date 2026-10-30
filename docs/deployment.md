# Deploy Relay with the same browser authentication as Atlas

Relay runs independently from Atlas on the same VPS. Atlas already occupies host ports 80/443 using Caddy inside its Docker ingress. Relay does **not** modify that stack or expose another public port.

## Authentication and network path

~~~text
Browser HTTPS -> Cloudflare Tunnel -> Relay Caddy Basic Auth -> Relay :8765 -> Pi/OpenRouter
                                      |
                         after valid user/password,
                         inject server-side Bearer token
~~~

- The browser shows **one native username/password prompt**, like Atlas.
- Caddy checks the bcrypt password hash before proxying **any** request, including API requests and static files.
- After authentication, Caddy overwrites the upstream Authorization header with the private `RELAY_ACCESS_TOKEN`, preserving Relay's existing API security without asking the browser to enter that token again.
- Caddy and cloudflared both run on Relay's private Docker network. The only published Relay port remains `127.0.0.1:8765` for SSH tunnel testing. Never point the public Cloudflare hostname directly at `relay:8765`.
- The internet-to-Cloudflare leg is HTTPS. Cloudflare Tunnel carries traffic securely to `cloudflared`; Caddy uses HTTP *only within the private Docker network*. Basic Auth must never be exposed over public plain HTTP.

## One-time setup on the VPS

Keep the private `~/relay/.env` with your existing `RELAY_ACCESS_TOKEN`, `OPENROUTER_API_KEY` and the free `:free` model. **Never copy your current credentials into GitHub or chat.**

Add two new settings:

~~~dotenv
RELAY_BASIC_AUTH_USER=your-username
RELAY_BASIC_AUTH_HASH='$2a$14$THE_BCRYPT_HASH_FROM_THE_COMMAND'
~~~

Generate a strong password hash interactively without putting your plaintext password in shell history:

~~~bash
docker run --rm -it caddy:2-alpine caddy hash-password
~~~

Enter your chosen username in `RELAY_BASIC_AUTH_USER`; paste the **resulting hash** as `RELAY_BASIC_AUTH_HASH`, surrounded by single quotes. The single quotes are important: bcrypt hashes contain `$` and unquoted values can be interpolated by Compose.

To edit:

~~~bash
cd ~/relay
nano .env
chmod 600 .env
~~~

You can choose the same credentials as Atlas, but a separate strong password is safer. Atlas's stored hash is managed in a different stack; this Relay configuration remains independent.

## One-time Cloudflare setup

You **do not need a Cloudflare Access application or an Allow policy**. Protection is provided by Relay's own Caddy Basic Auth.

1. Open Cloudflare's dashboard > **Networking > Tunnels** and create a remotely managed tunnel named `relay-vps` (or reuse an existing Relay tunnel).
2. Select the **Docker connector**. Copy the tunnel token from the provided install command, but don't execute that install command: Compose runs cloudflared for you.
3. Under **Routes**, add a **Published application** route:
   - Hostname: **`relay.affankhan.dev`**
   - Type: **HTTP**
   - Service URL: **`http://gateway:8080`**
4. Cloudflare normally creates the DNS CNAME for the hostname when the route is saved. If a conflicting DNS record already exists, remove or adjust that record first.
5. On the VPS, add `TUNNEL_TOKEN=YOUR_TOKEN` to the private `~/relay/.env`.
6. If you previously created a Cloudflare Access application for `relay.affankhan.dev`, remove or disable it **if you want only the single Basic Auth prompt**. Leaving it enabled is also secure, but results in two different logins.

**Important:** Do not use `http://relay:8765` as the tunnel destination; that would bypass Caddy's password gate. A Cloudflare Tunnel published application is normally publicly reachable unless protected by an app-level policy or an origin authentication mechanism; the Caddy proxy is that origin protection here.

## Deploy and verify

~~~bash
cd ~/relay
git pull --ff-only
./scripts/deploy.sh --tunnel
./scripts/status.sh
docker compose -f compose.yaml -f compose.tunnel.yaml logs --tail=40 gateway tunnel
~~~

`deploy.sh` fetches main with `--ff-only` (after its first installation), rebuilds the Node image, waits for the Relay health check, and starts the Caddy gateway and Cloudflare connector. It won't overwrite tracked local changes.

In a private browser window, open **https://relay.affankhan.dev**. You should receive a username/password challenge. After successful login the Relay UI should load **without** its own access-token dialog. Try the first chat message to confirm OpenRouter works.

From a different unauthenticated client:

~~~bash
curl -I https://relay.affankhan.dev/
~~~

Expect `401 Unauthorized` with a `WWW-Authenticate: Basic` header. If it displays the Relay application without a challenge, **disable the public route** and check that the Cloudflare service URL is `http://gateway:8080` and Caddy has loaded the correct configuration.

To inspect the Caddy configuration without echoing secrets:

~~~bash
docker compose -f compose.yaml -f compose.tunnel.yaml exec gateway caddy validate --config /etc/caddy/Caddyfile
~~~

Note: Caddy's validate command may include expanded configuration values in verbose error output; don't paste logs containing credentials or private tokens.

## Subsequent deployments

~~~bash
cd ~/relay
./scripts/deploy.sh --tunnel
~~~

No Cloudflare or Atlas edits needed for normal releases. The script only performs manual deployments for now. Check `./scripts/status.sh` or `docker compose logs --tail=50 relay`.

## Security and limitations

- Relay's internal bearer token remains mandatory for `/api/*` on the loopback endpoint, including when accessed over an SSH tunnel.
- Caddy authenticates every public HTTP request and injects that bearer header only after authentication.
- Do not expose `gateway:8080` or Relay's port 8765 directly to the internet.
- Store your tunnel token, bcrypt hash, API key and internal token exclusively in `.env` on the VPS.
- Basic Auth is single-user protection, not shared SSO, multi-user authorization, MFA or an identity provider.
- Pi's built-in file and shell tools are disabled; future Atlas MCP execution needs its own authorisation.
- Chat sessions remain in-memory and are lost on server restarts.
