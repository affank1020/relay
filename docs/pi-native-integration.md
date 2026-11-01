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
Relay root task ID and run ID; child sessions are *not yet* separate
durable Relay Tasks & Agents records.

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
durable parent/child identity, controlled restart recovery and
budget accounting before they can replace Relay's full orchestration.
This is tracked in issue #49. The present PR integrates the existing
Pi subagent executor for isolated tool-less work and proves the
handoff protocol; it is **not** the full external-research migration.
