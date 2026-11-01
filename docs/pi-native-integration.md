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

## Pi subagent extension compatibility

Candidate: [@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents),
version 0.22.1 (MIT), compatible in principle with Pi 1.4.0.

**Do not install or load this as an ambient extension on the Relay VPS yet.**
Its default `general-purpose` and `Explore` agent types can grant
filesystem or bash capabilities; its child session resource loader can load
extensions and tools independently of Relay's PiHarness. The existing parent
`tool_call` hook and Relay's SQLite queue do not automatically constrain or
track those new sessions. Loading it alongside `relay_delegate` would also
create two independent schedulers and inconsistent Tasks & Agents state.

The follow-up migration must:
- Pin and verify the package release, including dependency lock integrity.
- Disable default agent types; define narrowly scoped, explicit models/tools
  and disable ambient extension/skill loading for children.
- Prove child MCP read capability admission and cancellation at call-time,
  independently of parent in-process hooks.
- Bridge child spawn/completion/cancel, budgets, restarts and receipts into
  Relay's durable task/run state; **replace**, rather than duplicate, the
  old scheduler when acceptance passes.
- Test two parallel children using actual authorised GitHub issue reads,
  and verify the parent joins their results correctly.

Merely importing the package, or showing a model-generated agent summary,
does not count as finished orchestration.
