# Relay local inference: Ollama on the MacBook

Relay and its Atlas MCP gateway stay on the VPS. The local Ollama model runs
only when the MacBook is awake and Ollama is started. Conversations explicitly
select a provider; Relay **never silently forwards local requests to OpenRouter**.
The server persists all chat prompts/outputs on the VPS even for local inference.

## MacBook (one-time)

1. Run `ollama list` to discover installed model IDs. Use the exact tag of
   the already-installed Qwen 4B for the first test. Verify Ollama is running:
   `curl --fail http://127.0.0.1:11434/v1/models`.
2. Install and sign in to **Tailscale** on your MacBook. Enable HTTPS Serve
   within your private tailnet when prompted, then run:

   ```sh
   tailscale serve --bg 11434
   tailscale serve status
   ```

   Save the HTTPS hostname printed by the command; it looks like
   `https://<mac-name>.<tailnet-name>.ts.net`. Serve keeps the mapping
   across Tailscale restarts. **Do not use Tailscale Funnel or publicly bind
   Ollama to 0.0.0.0.** Ollama serves the entire API, including model-management
   operations: restrict tailnet grants/ACLs to the VPS and your own admin
   identity, not all tailnet members.

## VPS (one-time)

1. Install Tailscale on the VPS host, sign in to the same tailnet and enable
   `tailscaled` at boot. Ensure private DNS/routing to the Mac works.
2. On the VPS host:

   ```sh
   curl --fail --max-time 10 https://<mac-name>.<tailnet-name>.ts.net/v1/models
   ```

3. Verify it **also works inside the Relay container**. Host DNS and Docker
   DNS may differ, so a host-only success is not sufficient:

   ```sh
   cd ~/relay
   docker compose -f compose.yaml -f compose.ingress.yaml exec -T relay \
      node -e "fetch(process.argv[1],{signal:AbortSignal.timeout(10000)}).then(r=>{console.log('HTTP',r.status);if(!r.ok)process.exitCode=1}).catch(e=>{console.error(e.cause?.code||e.name);process.exitCode=1})" \
      "https://<mac-name>.<tailnet-name>.ts.net/v1/models"
   ```

   If the container cannot reach MagicDNS, inspect the VPS DNS and Tailscale
   routing from Docker rather than making Ollama public.

4. Add to the VPS-only `~/relay/.env`:

   ```dotenv
   RELAY_OLLAMA_URL=https://<mac-name>.<tailnet-name>.ts.net/v1
   RELAY_OLLAMA_MODELS=<exact-4b-id-from-ollama-list>
   ```

   When larger models finish downloading, append the installed IDs
   comma-separated. Do not commit the private tailnet name or credentials.
   The URL validator accepts only tailnet HTTPS and loopback HTTP for
   development. Existing `RELAY_MODEL` and OpenRouter key remain in place.

5. Merge the reviewed Relay PR; automatic deployment does not change
   `.env`. Recreate Relay after the private env update with
   `./scripts/deploy.sh --ingress --no-pull` on the VPS.

## Validation

- Choose `MacBook · <model>` in the Relay model selector. Changing the
  selection creates a **new** conversation, preventing accidental model
  switches in existing Pi session history.
- Ask a basic question, then request read-only Atlas status and project list.
  Confirm actual Atlas tool receipts; 4B models may be weak at tool calling.
- Stop Ollama, send another local request and confirm Relay reports the
  offline state without contacting OpenRouter. Restart Ollama; new local
  requests should recover without restarting Relay.
- Also test Mac sleep/wake. Tailscale may reconnect automatically, but
  **never auto-retry a failed Atlas task** after reconnection because a
  previous operation could have partially succeeded.
- The request-start probe has a bounded timeout; it does not poll models
  in the background. Network loss during inference may still yield a
  generic Pi provider error; that is separate follow-up work.

## Security notes

Ollama local HTTP endpoints have no dedicated API authentication. Treat
Tailscale access controls and the VPS as the trust boundary. Do not publish
port 11434 to the internet. Proxy requests remain server-side and only
configured model keys are exposed to browsers; no user-controlled inference
URLs are accepted. Local inference isn't equivalent to local-only storage,
because the Relay conversation database lives on the VPS.
