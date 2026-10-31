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
For each inference, the server also limits the **aggregate enabled Skill text**
to a conservative fraction of the selected model's actual context window,
reserving space for the model's output, ordinary prompt and chat history.
Admitted Skill text is charged by UTF-8 bytes, not an optimistic average
tokens-per-character estimate. Oversized Skills are skipped (not truncated)
for that inference, and the activity stream records `skill/skipped_context`
with the Skill name; skipped Skills are never advertised as loaded. Users
can disable Skills or select a model with a larger window. There is no fixed
16 KiB instruction ceiling: a reviewed 20–32 KiB Skill can be admitted by a
sufficiently large-context model. A skipped Skill remains installed and
enabled for future runs that have sufficient context.
The limit cannot prevent otherwise normal chats from continuing.

A task loads its current authorised Skill set when it begins. Child tasks
load their own current authorised set rather than inheriting arbitrary parent
credentials or a free-form instruction that grants capabilities. The next slice adds a **reviewed, revision-pinned GitHub Skill workflow**:
open Skills & integrations → Install reviewed GitHub Skill, enter repository
owner/name, exact 40-hex commit SHA, and the path to SKILL.md. Relay fetches
that single public file through the fixed GitHub API endpoint, without tokens,
redirects, mutable branch names, archive extraction or executable packages.
Preview displays **all raw Skill instructions as text**, the exact source and
SHA-256 fingerprint. Installing requires a separate acknowledgement of the
reviewed bytes, saves an immutable snapshot to RELAY_DATA_DIR/trusted-git-skills
and starts it **disabled**. The user must explicitly enable it afterward.

A preview token is single-use, expires after ten minutes and is lost on server
restart; preview itself does not change persistent capabilities. At most eight
reviewed Git Skills may be installed; duplicate names (including bundled ones)
are denied. Enabling rechecks the file and digest; a missing, modified or
symlinked snapshot fails closed even if the persisted enabled flag is true.
Remove revokes authority in capabilities.json *before* cleaning up package bytes.
There is no automatic upstream refresh: a changed GitHub commit or revision
requires a new explicit preview/approval.

Only SKILL.md text is installed; related code, extensions, scripts, extra assets,
custom tools and elevated permissions are **never** imported. Approved Skill
instructions can still influence the model, so inspect the preview carefully;
GitHub hosting and a pinned SHA are not substitutes for trusting the author.
This is initially **public GitHub** only. It does not fetch private repos using
a PAT or permit the agent to install a Skill itself.

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

Current omissions: private Git Skill imports, explicit write approval,
per-agent scoped grants beyond global opt-in, live remote credential validation,
MCP provider reconnect/health beyond discovery status and conversation memory.

## ChatGPT parity gap inventory

| Area | State | Next useful increment |
| --- | --- | --- |
| Normal chat, persisted sessions, rename/delete | Implemented | Resume/reconnect robustness tracked in #25 |
| Hosted/local model choices | Implemented baseline | More model policies and provider resilience |
| Skills | Bundled opt-in text Skills + reviewed immutable public GitHub snapshots | Private/internal sources, granular scope grants |
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
request automatically. Failed sessions are removed from the shared connection
cache, but their transport closes only after all already-active agent requests
settle. The next discovery can establish a new MCP session without interrupting
unrelated in-flight requests.

A conversation can be deleted after known read failures. If the only remaining
blockers are uncertain MCP reads, the delete dialog presents an explicit
acknowledgement; the authenticated POST
`/api/sessions/:id/reconcile-mcp-reads` with `{"confirmed":true}` retires
those read-only invocation ledger entries, writing a reconciliation event while
the conversation exists, after which the user can delete the conversation. The
normal deletion erases conversation events, but a minimal retained ledger row
persists the number of acknowledged reads and the acknowledgement timestamp,
without the transcript, arguments, tool output, or invocation IDs. The endpoint rejects running,
interrupted or unknown operations and never reconciles Atlas tool actions or
unclassified invocation records. This acknowledges uncertain *read receipts*,
not successful execution, and it does not silently reissue a tool call.


## GitHub write approvals (issue creation and issue/PR comments)

GitHub mutation is **disabled by default**, regardless of the credential's scope.
An operator must configure a minimally scoped RELAY_GITHUB_TOKEN and set
RELAY_GITHUB_WRITE_REPOS to up to eight exact comma-separated owner/repo entries.
No wildcard, browser endpoint, organization-wide or model-provided permission
is accepted. The user must also enable GitHub under Skills & integrations.

Only GitHub's discovered create_issue and add_issue_comment MCP tools are
eligible. The server rechecks exact repository, operation, argument shape,
body/title limits and current integration enablement on invocation and after
approval. No other GitHub mutations, and no third-party provider mutations,
are admitted. Only root agent sessions can receive these write tools; children
and inference-only join continuations do not inherit mutation permissions.

For every operation, the task pauses and the existing authenticated approval
interface shows the exact repository, issue number/title and content. No
lasting grant is established. A rejected, cancelled or revoked operation
before dispatch is recorded as denied_before_dispatch and never sent; this
known terminal denial does not prevent chat deletion. Approved requests are
marked dispatched before calling GitHub. A successful returned response
produces a terminal receipt without persisting raw response content in event
telemetry. A transport timeout, provider error, cancellation or ambiguous
outcome after dispatch is *uncertain*: no automatic replay or retry. Such
records block conversation deletion and require operator investigation of the
actual GitHub issue before any further action. No automatic write-side-effect
reconciliation is provided in this slice.

Production credential smoke is **not** implied by fixture tests. Verify with a
restricted test repository and a deliberately scoped operator credential.
