# General-purpose Skills and MCP (Track A)

Relay is a general-purpose assistant. Neither Atlas nor GitHub is required to start a chat.

## Trusted Skills

The first implementation includes reviewed, text-only Relay-native Skills at
skills/prepare-pr/SKILL.md and skills/code-reviewer/SKILL.md. They are compatible
Pi Skills, **not** transplants of ChatGPT plugin skills, and carry no executable
extensions. The registry validates the package path, frontmatter and content
bounds; exposes source, version, SHA-256 revision and load failure; and keeps
both disabled until the user enables them in Skills & integrations.

The Pi resource loader receives only explicitly enabled Skill paths and filters
every discovered resource against that exact allowlist. Unreviewed Pi, user or
project Skill discovery cannot become active merely by appearing on disk.
Built-in tools, extensions, prompt templates and context file discovery remain
disabled. Enabling Skill instructions never grants tools.

Enable/disable preferences persist atomically under
RELAY_DATA_DIR/capabilities.json (0600). Updates are server-authenticated.
A task loads its current authorised Skill set when it begins. Child tasks
load their own current authorised set rather than inheriting arbitrary parent
credentials or a free-form instruction that grants capabilities. An explicit
Git-package installation flow with revision pinning, human review and revocation
is reserved for a follow-up: arbitrary repository URLs cannot be installed by
the model or the UI.

## MCP

The built-in GitHub provider uses the official Streamable HTTP endpoint:
https://api.githubcopilot.com/mcp/

Set RELAY_GITHUB_TOKEN to a read-scoped personal access token **on the server**
only, then enable GitHub through Skills & integrations. No credential is returned
by the API, browser, tool receipt or log. Keep token scope as narrow as possible,
and grant private repository access only if you intend the model to see it.

Other providers must be installed by an operator with RELAY_MCP_PROVIDERS,
a JSON array of reviewed provider configurations, such as:

    [{"id":"docs","label":"Documentation","url":"https://mcp.example.com/mcp",
      "tokenEnv":"RELAY_MCP_TOKEN_DOCS","readTools":["search_documents","get_document"]}]

Add mcp.example.com to RELAY_MCP_HOST_ALLOWLIST and supply the token in
RELAY_MCP_TOKEN_DOCS. HTTPS only, no credentials/query strings in URLs,
no browser-configured endpoints, redirects blocked. IDs/tool names and per-server
tool inventory are bounded. Extra providers must use recognised read verbs.
External servers and schema metadata remain untrusted: an operator must
review each provider's actual side-effect behaviour before allowing it.

At runtime, Relay admits only exact configured read tools from live discovery;
schema checks and revocation are enforced again on invocation. No automatic
MCP write or new Skill installation is implemented. GitHub mutation will require
a separate explicit user approval and auditable policy in a later slice.

Receipts use provider, invocation, task and current run identity, lifecycle and
safe timestamps. Generic event payloads do not include arguments, results or
tokens. Atlas's gateway remains separate and retains its established checks.
This v1 adapter intentionally does not change the durable ExecutionEvent schema
owned by the orchestration workstream. A read invocation is not automatically
replayed after an ambiguous network failure. See coordination issue #31.

## Testing and limitations

npm run verify covers TypeScript, build and tests. Tests include real Pi resource
loading without inference, persistence/revocation, forged configuration,
offline providers and redaction. GitHub CI verifies the production container.
A live credentialed GitHub MCP smoke needs an operator-owned token and a
user-selected read-only repository; fixtures alone do not establish that.

Current omissions: remote Git installation/review, explicit write approval,
per-agent scoped grants beyond global opt-in, live remote credential validation,
MCP provider reconnect/health beyond discovery status and conversation memory.

## ChatGPT parity gap inventory

| Area | State | Next useful increment |
| --- | --- | --- |
| Normal chat, persisted sessions, rename/delete | Implemented | Resume/reconnect robustness tracked in #25 |
| Hosted/local model choices | Implemented baseline | More model policies and provider resilience |
| Skills | Bundled opt-in text Skills in this slice | Reviewed version-pinned Git packages |
| MCP | Restricted server-side read adapters in this slice | Explicit GitHub write approval |
| Memory/preferences | Missing | Separate, source-attributed user-controlled store |
| Attachments and file handling | Missing | Upload/storage, content validation and deletion |
| Multimodal input | Missing | Image/audio paths with clear retention |
| Web search/deep research | Missing | Explicit source citations and safe browsing provider |
| Mobile accessibility | Partial | Keyboard/touch/browser QA |
| Agent orchestration | Separate track #29 | Parent-child joins and durable run IDs |
| Atlas Awareness | Separate track #30 | Evidence-backed contextual observations |

No claim is made that this slice alone reaches full ChatGPT parity.

Because Relay intentionally exposes no general filesystem reader to Pi, the
validated instructions of each enabled Skill are included in the trusted
agent prompt, while the Pi resource loader still verifies the Skill metadata.
The `loaded` event means instructions were made available, **not** that a
particular Skill was used or that any underlying action succeeded.

## Read-only MCP failure and deletion semantics

A remote MCP `isError` response or an oversized response means the request
returned; the invocation is recorded as a known `failed_read`. A connection
loss or timeout after dispatch is `uncertain` and Relay does not retry the
request automatically. Transport failures close and invalidate the connection
so **the next** discovery can establish a new MCP session.

A conversation can be deleted after known read failures. If the only remaining
blockers are uncertain MCP reads, the delete dialog presents an explicit
acknowledgement; the authenticated POST
`/api/sessions/:id/reconcile-mcp-reads` with `{"confirmed":true}` retires
those read-only invocation ledger entries, preserving an audit event, after
which the user can delete the conversation. The endpoint rejects running,
interrupted or unknown operations and never reconciles Atlas tool actions or
unclassified invocation records. This acknowledges uncertain *read receipts*,
not successful execution, and it does not silently reissue a tool call.
