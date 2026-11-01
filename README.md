# Relay

Relay is a self-hosted, general-purpose assistant powered by Pi. It combines a chat-first web UI, independent Pi child sessions, approved MCP integrations, reviewed Skills, and Atlas awareness.

Pi owns inference, tool execution and discovery, MCP connections, session transcripts, context and compaction. Relay supplies authentication, bounded web-job admission, approval policy, durable UI projections and Atlas resource views. There is one execution path; no Pi rollout flags or legacy delegation engine.

## Develop

Node 22.19+ is required.

```sh
npm ci --ignore-scripts
npm run verify
```

Set `RELAY_ACCESS_TOKEN` (at least 24 characters), `RELAY_DATA_DIR`, and either `OPENROUTER_API_KEY` or `RELAY_OLLAMA_URL`. See [.env.example](.env.example). Build with `npm run build`, then `npm start`. OpenRouter model IDs retain the explicit `:free` safeguard. Local Ollama models are discovered from the configured private endpoint.

The dark web UI provides streaming chat, model switching within a chat, source-tool activity, a Pi session trace, Tasks & agents, exact write approvals and reviewed Skill/integration controls. Atlas context is optional; the assistant discovers resources as needed.

## Architecture and operation

- [Architecture and ownership](docs/architecture.md)
- [Audit and extension evaluation](docs/architecture-audit.md)
- [Adding capabilities](docs/extensions.md)
- [Migration and rollback](docs/migration.md)
- [Verification and live acceptance](docs/verification.md)
- [Deployment and ingress](docs/deployment.md)
- [Atlas awareness](docs/atlas-awareness.md)

Production data belongs in the persistent `/data` volume. Merging to `main` retains the existing CI-gated deployment workflow; the reconstruction PR must remain unmerged until the owner chooses to deploy.

Hosted access uses the existing VPS Basic Auth gateway, which injects the backend token. Direct localhost access prompts for `RELAY_ACCESS_TOKEN`. Credentials stay server-side.
