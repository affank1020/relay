# Pi-native foundation migration

Relay is a Pi-powered assistant with Atlas awareness, not a second agent framework.
The migration is tracked in [issue #49](https://github.com/affank1020/relay/issues/49).

## Pi-native MCP read transport (experimental)

Relay's original `ConnectionManager` uses its own HTTP MCP transport and
model-visible tool definitions. The new opt-in path delegates read tool discovery,
transport, deferred exposure and execution to Pi's built-in
`createMcpExtension()` + `createToolSearchExtension()`.

Set `RELAY_PI_NATIVE_MCP=1` in the private VPS `~/relay/.env`, and recreate the
Relay container to enable this test path. The default remains **0** while
live acceptance is incomplete. Never place credentials in this repository.

The adapter loads MCP config *only* from Relay's trusted server registry. It
ignores ambient `mcp.json`, untrusted project configurations, and installed
packages. Server tokens are kept in-process. All new provider tools default to
`hidden`; exact allowlisted read names are `deferred`. Pi names them
`mcp__github__issue_read`, unlike the legacy
`mcp_github_issue_read`. Existing child snapshots can still be validated
using the legacy name during the migration.

The Pi `tool_call` hook checks the provider is still enabled, the active
task/run identity and delegated tool grants **before dispatch**. The
`tool_result` hook records completion or failure in SQLite without logging
arguments or response bodies. Abandoned dispatched reads remain uncertain and
require reconciliation rather than automatic replay. Explicitly approved
GitHub *writes* are still delegated to Relay's separate root-only write path
until approvals can be migrated safely.

## Live acceptance before default-on / removing legacy code

1. With native MCP enabled, confirm `tool_search` discovers
   `mcp__github__issue_read` and that it reads the *actual title and body*
   of issues #28 and #29. Do not accept a plausible model answer without an
   execution receipt.
2. Delegate those issues to two independent researcher children, each with
   exactly the native issue-read capability; verify per-child receipts and
   parent synthesis.
3. Disable GitHub midway through a run and verify subsequent tools are denied.
   Test a cancelled child, an offline provider, and restart after an ambiguous
   tool dispatch.
4. Confirm Pi cannot call GitHub create/comment tools without the existing
   explicit approval, and that no ambient shell or filesystem tools appear.
5. Once passing, remove the legacy read-only ConnectionManager HTTP transport,
   old alias translation and duplicated discovery. Retain a minimal permission
   and audit adapter for writes and task lifecycle.

## Pi subagents extension: opt-in initial integration

Relay now installs the **pinned** `@tintinweb/pi-subagents@0.22.1` in
its production image, but **does not execute it by default**.

Set `RELAY_PI_SUBAGENTS=1` in the private VPS `~/relay/.env`, then
recreate the container, to run an early **tool-less** Pi-subagent mode.
It is independent of `RELAY_PI_NATIVE_MCP`. When enabled for a new
root task, Relay's `relay_delegate` tool is omitted and
`relay_pi_delegate` is offered instead: the model cannot call both
delegation schedulers in a single run.

The new `PiSubagentsRpc` adapter speaks the extension's documented v2
in-process event-bus protocol. Its lifecycle includes handshake, spawn,
completion/failure, explicit `stop` on cancellation, and synchronous
`consume` to prevent a redundant parent turn. The parent waits for the
actual Pi child result before continuing. Events carry the current
Relay root task ID and run ID. Child starts/completions are projected as
first-class durable Relay child Tasks & Agents records, with internal
conversation IDs and stable per-run attribution. **Pi**, not Relay,
executes the child; the parent does not schedule a second join inference.
An interrupted parent marks outstanding projections as interrupted and
never silently replays the child.

The caller cannot select another agent type, grant tools, enable context
inheritance, change the working directory, or override the model. The
only permitted type, `relay-isolated`, is shipped in
`.pi/agents/relay-isolated.md`. It disables **all builtin tools**,
Skills, child extensions and nested subagents; `.pi/subagents.json`
suppresses the package's default agent types and scheduled jobs.
These are Pi capability restrictions, **not** a process or network
sandbox: the package's extension code itself runs in the Relay process.

### Acceptance before enabling outside a controlled test

1. Inspect the pinned package source and verify the installed version
   resolves to exactly 0.22.1.
2. On a disposable Relay conversation, delegate analysis of *supplied*
   facts only. Confirm one `relay_pi_delegate` tool invocation,
   one child run, and final parent synthesis with a real completion
   event. Do not test this mode with GitHub/Atlas research tasks.
3. Confirm `Agent`, `SubagentWorkflow`, Bash, filesystem and
   unapproved MCP tools are not available on the parent or child.
4. Cancel a running child and verify Pi receives stop and no
   completion event is incorrectly marked successful.
5. Restart during a child execution; confirm the original Relay task
   is interrupted and never falsely marked complete.
6. Turn the feature flag off and verify the legacy Relay delegation
   remains available for rollback.

### Remaining consolidation work

**Do not remove the old scheduler or enable child GitHub/Atlas tools
yet.** The Pi extension's child sessions are separate SDK sessions
with their own resource loaders and tool gates. They need a verified
child-side allowlist/audit adapter, a cross-session execution receipt,
fully verified restart/resumption semantics and
child-side budget accounting before they can replace Relay's full orchestration.
The task projections are durable observations, not independent resumable
Pi child sessions. Do not represent them as such.
This is tracked in issue #49. The present PR integrates the existing
Pi subagent executor for isolated tool-less work and proves the
handoff protocol; it is **not** the full external-research migration.

## Scoped child MCP research (experimental)

The Pi child research broker adds a third independent rollout switch:

```
RELAY_PI_NATIVE_MCP=1
RELAY_PI_SUBAGENTS=1
RELAY_PI_CHILD_MCP=1
```

**Leave all three disabled in production until the following live test passes.**
No external credentials are copied into child sessions, prompts or transcripts.

The new, reviewed `relay-research` profile uses Pi's existing subagent
scheduler but exposes only the `relay_child_mcp_read` extension tool; it
has no builtin shell/filesystem tools, no Skills, no nested agents, and no
ambient provider connections. The extension is compiled to
`/app/dist/pi-child-mcp-extension.js` and loaded by exact path.

A parent `relay_pi_delegate` call must explicitly enumerate exact
permitted tools, e.g. `["mcp__github__issue_read"]`. Tool grants are
bound to the actual Pi child session ID using the upstream in-process
manager registry, not the model's claimed agent ID. The broker refuses
unknown or unbound sessions, non-allowlisted tool names and writes.
The child requests a read through Pi's in-process event bus; the parent
executes it through `ctx.executeTool()` using Pi's **already-admitted
native MCP tool**. This retains the parent's live cancellation, provider
revocation and durable MCP invocation receipts. Broker read responses
never include the provider token. The child may not report verified
external facts unless a real read completed successfully.

The research profile **is not OS-level isolation**; third-party extension
code remains in the Relay process. Per-child inference usage is not yet
accounted separately, and this bridge's execution receipts are currently
root-attributed nested Pi tool calls rather than independent child audit
rows. No scheduler, transport or token-manager replacement is claimed.

### Credentialed acceptance

1. Confirm GitHub is configured and Pi-native MCP independently retrieves
   `affank1020/relay#28` with `mcp__github__issue_read`.
2. Enable the three flags only in a controlled Relay deployment; restart
   the container. Start two parallel `relay_pi_delegate` research calls,
   each with exactly that read tool, for issues #28 and #29.
3. Require **two real nested tool receipts** and correct, source-grounded
   issue titles/bodies. A plausible summary or model-only claimed citation
   is not evidence.
4. Attempt `mcp__github__create_issue` from a child and verify it is denied
   before dispatch. Disable GitHub or cancel the parent during a child read;
   verify no final verified result is returned.
5. Restart during a child run, verify the durable child state is interrupted
   rather than replayed, and check that there is no shell/FS/native MCP
   direct access in the child.
6. Only after live acceptance, extend the bridge to other explicitly
   approved providers (Atlas included), add child-specific usage/receipt
   association, and remove the old Relay delegation/MCP duplicate code.

This bridge exists to enforce user-specific per-child scopes while letting
Pi own the agent session, tool registry, native MCP transport and scheduler.

## Unified Pi foundation rollout — code-completion PR #54

PR #54 consolidates the remaining production implementation. The single
opt-in switch activates all three existing native Pi paths:

```dotenv
RELAY_PI_FOUNDATION=1
```

The original three individual switches remain compatible but are not needed
when the unified switch is enabled. This must be tested on the final deployed
product before changing the default; **do not infer success from CI alone**.

- **MCP:** Pi's native transport and tool search own general provider reads,
  including the trusted Atlas endpoint. Provider credentials are never given
  to children. Atlas workspace file/Git reads deliberately remain on Relay's
  specialised Gateway because it validates checkout placement and Node
  capabilities before dispatch; Atlas development tasks still require
  user approval. Those existing scoped Gateway reads can be delegated via
  the reviewed parent Pi child bridge.
- **Agents:** The pinned Pi subagents package owns child execution and
  scheduling, while Relay projects its lifecycle into durable Tasks & Agents
  records. The native path never presents the old `relay_delegate` tool in
  the same session.
- **Accounting:** Per-message `subagents:usage` is recorded against each
  child Task, counted against Relay session/global limits, and budget breaches
  abort the owning parent. Nested child MCP success/failure also creates
  a child-attributed invocation receipt. Parent-attributed transport receipts
  are preserved independently.
- **Revocation:** Native Pi MCP revalidates provider and task permission both
  *before dispatch* and *when a result returns*, redacting results if the
  capability was revoked during execution.
- **Dependencies:** The exact Pi subagents version and its transitive graph
  are now retained in `package-lock.json`; the image uses npm ci and no
  unpinned secondary install.
- **Visibility:** `/api/status` exposes `piFoundation` flags without secrets.

### Run final acceptance on the deployed application

With the GitHub integration enabled and working, set `RELAY_PI_FOUNDATION=1`
on the Relay server and recreate the container. Select a *configured* local
Qwen model. To test from within the Relay container (where the access token
is already in the environment):

```sh
RELAY_SMOKE_URL=http://127.0.0.1:8765 \
  RELAY_SMOKE_MODEL_KEY='ollama/qwen3-coder:30b' \
  npm run pi:smoke
```

Use the actual configured Qwen model ID if it differs. The smoke command
creates a disposable conversation, asks for **two parallel Pi research
subagents** reading GitHub issues #28 and #29, and verifies two distinct
successful child read receipts, overlapping child lifetimes, completed
child tasks and both exact titles in the parent's final answer. It prints
only a short verdict, not source bodies or tokens.

Also manually exercise provider revocation, cancellation during a read,
restart recovery, and Atlas child workspace reads. Unit tests cover these
paths in isolation but cannot substitute for live provider acceptance.

The legacy executor and transport are intentionally retained **only as an
opt-out rollback path** until live acceptance proves the migration. A final
source deletion can then remove that fallback without changing the new
Pi code; leaving it compiled is not a claim that redundant source removal
is finished or that live testing already passed.
