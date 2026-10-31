# Atlas awareness in Relay

Relay displays optional Atlas context only from successful, structured and allowlisted read receipts. A regular conversation requires no Atlas project selection. Checkout, Node, Git, project, store, record and Code Reviews observations contain identity/aggregate data; raw record data, file bytes, MCP text and credentials are not copied into the observation events.

## Read-only navigation

Set **ATLAS_WEB_ORIGIN** to an operator-trusted Atlas Web **origin**, for example \`https://atlas.example.com\`. The setting is separate from \`ATLAS_MCP_URL\`; it is used only to generate links from verified resource IDs. It cannot carry a username/password, path, query or fragment. The only permitted plaintext HTTP origins are \`localhost\`, \`127.0.0.1\` and \`[::1]\` for local development. If absent, no Atlas Web links are rendered.

Routes are based on the actual Atlas Web hash router (see \`apps/web/src/App.tsx\` in Atlas):
- Project: \`#/projects/{projectId}\`
- Store and record: \`#/projects/{projectId}/stores/{storeId}/records\`; Atlas does **not** support directly opening a specific record by URL.
- Checkout: \`#/projects/{projectId}/workspaces\` when an authoritative project association is known; otherwise \`#/workspaces\`. No checkout-specific deep-link claim.
- Node: \`#/nodes\` (the Nodes page, not a Node-specific hash route).
- Code Reviews: \`#/applications/code-reviews\`; verified GitHub PR links remain separate.

The setting is exposed to the authenticated Relay frontend through \`/api/status\` only when an Atlas transport is configured. It never contains a credential and is not derived from untrusted MCP output. Link clicks navigate normally in a new tab; they never dispatch a privileged tool or skip Atlas sign-in.

## Operator credentialed smoke

This is **not** an automatic startup probe. On a configured Relay host with the existing read-only service token, run:

\`\`\`sh
npm run atlas:smoke
\`\`\`

Requires \`ATLAS_MCP_URL\` and \`ATLAS_MCP_TOKEN\` as usual. Optionally set \`ATLAS_SMOKE_PROJECT_ID\` to an authorised project UUID for a specific \`get_project\` identity check. The smoke checks:

1. Authenticated MCP discovery with no duplicate tool names.
2. An admitted \`get_atlas_status\` structured read (mandatory).
3. An optional specific \`get_project\` read, if explicitly configured and advertised.
4. \`code_reviews_overview\` **only if the service advertises it**, with a validated project UUID and nonnegative counts.

It prints only bounded status and counts: no URLs, tokens, raw tool responses, record content, project names or private findings. It neither invokes write tools nor changes permissions. A nonadvertised Code Reviews operation is reported as \`not_advertised\`, **not** as successful integration. Never confuse a developer's interactive Atlas MCP access with Relay's production service-credential capabilities.

## Outstanding acceptance

The Atlas service credential currently restricts the read catalogue. Enabling Code Reviews reads for Relay requires a separately reviewed Atlas authorization change; it must not happen implicitly in this workstream. A passing fixture suite is not evidence of a credentialed deployment smoke. After deploying with \`ATLAS_WEB_ORIGIN\` and running the credentialed smoke, manually verify desktop/mobile UI links, offline and reassigned Nodes, child agent run attribution after orchestration merges, browser reconnect, and separate authentication on opening Atlas Web.
