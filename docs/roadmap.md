# Relay — integrated implementation status (30 October 2026)

The initial readiness PR was extended into a single integration change at the owner's request. This supersedes the earlier staged-PR delivery sequence preserved below as historical planning context.

Implemented in source: SQLite conversation/task/event storage with sequence-based replay; Pi harness with limited explicit tools; Atlas MCP Streamable HTTP gateway with a read-only allowlist, correlated event records and approval-gated named development tasks; bounded queued/dependent/delegated tasks; explicit cancellation/reconciliation and cost/token budgets; a basic chat UI with activity inspector and reconnect-friendly message idempotency; and persistent Docker data volume.

Validated: Mac owner reports `npm run verify` passed for the integrated working tree, and GitHub Verify successfully ran on integration commit `90dcf256` (Node 22 typecheck, build, tests, Compose/Caddy and Docker). This does **not** establish production/live Atlas connectivity.

Outstanding verification and product work: actual credentialed Relay→Atlas read-only smoke test (requires an Atlas service token configured on both VPS stacks); Atlas admin configuration of local Mac development tasks; Playwright browser E2E; robust performance/load and restart drills; UI model selection and broader UX refinements; secure paid-provider configuration if ever requested; richer agent-to-agent collaboration and additional mutation workflows. Keep these limitations visible instead of claiming the full long-term product vision is complete.

---

# Atlas-native Relay engineering sequence

## Inspected baseline — 30 October 2026

Relay PR #8 is merged at main 033d0c3; the TypeScript migration is reused.
Relay currently has a streaming Pi/OpenRouter chat, in-memory sessions, a free-model suffix guard,
private bearer API, hosted Basic Auth gateway and independently verified-main deployment.
There is no Relay Atlas gateway, persistent event history, task queue or spending reservation yet.

Open Relay issues #2, #3 and #4 remain the implementation commitments below.
Issue #1's old deployment description conflicts with the newer ingress runbook: preserve the
current Caddy/Basic Auth design; do not reintroduce Cloudflare Access based on that old issue.

Atlas open PRs #61 (backups), #76 (monitoring details), #106 (Portfolio catalog) and issues
#105–#113 were inspected for overlap. None is a prerequisite to this readiness slice.
Keep their storage, monitoring and independent-review work separate.
Atlas's actual contracts distinguish physical checkout IDs from logical Workspaces and return
Node identity on development task results. Linux lacks workspace.dev in the inspected contract.
Development tasks are owner-configured argv executed with shell:false, bounded output and timeout.

## Reviewable delivery sequence

1. **Development readiness (this PR).** Lock dependencies, make tests build their inputs,
   document Mac task setup, establish HTTP authentication/concurrency/failure coverage and
   retain a real compiled Pi startup test. Fix admission races before adding tools.
   Local Atlas task configuration remains an explicit prerequisite, not a claimed completed action.
2. **Read-only gateway (#2).** Use Atlas's actual MCP protocol and discovery schemas. Register
   only explicitly permitted read-only tools; keep credentials server-side. Disable ambient Pi
   extensions/tools before enabling gateway tools. Add versioned correlated events, persisted
   sequence/replay and a small expandable UI activity view. Preserve raw MCP results once per
   invocation; no model call translates events. Test against the real MCP implementation and Pi
   adapter, and perform a separately labelled live read-only smoke when Relay credentials exist.
3. **Conversation reliability and budgets (#3).** Persist conversation metadata, harness state,
   runs and usage with migrations. Add request idempotency, reconnect/restart reconciliation,
   cancellation races and measured/estimated cost labels. Retain free-only configuration.
4. **Orchestration (#4).** Version the small harness-neutral lifecycle contract, implement the real
   Pi adapter, persistent queue, bounded concurrency, dependencies and safe retry classification.
   Scheduling, permission decisions and event mapping stay deterministic.
5. **Authorised workflows and operations.** Add approval-controlled mutations only where Atlas
   supplies capabilities and reconciliation; then richer UI, retention, measured resource tests,
   recovery drills and operational diagnostics.

Each item is a meaningful review boundary. Do not merge or deploy without independent review
and owner approval. Prefer a complete vertical slice over combining all milestones in one diff.

## Decisions and dependencies

Relay owns conversation/task/run/invocation identifiers. Atlas owns resource, checkout, operation
and Node identities. Never infer executing Node from availability or selection; unknown remains
null. Persist execution events separately from transcript text, ordered by a server sequence with
stable event IDs; reconnect replays from a cursor. A task and an agent run are separate because
one task can have retries or handoffs.

Before gateway persistence, compare SQLite WAL on a durable Relay-only volume with a dedicated
Relay database/role on the existing PostgreSQL service. SQLite is the provisional preference for
a single-process, bounded workload (no new database service, easy local tests); PostgreSQL becomes
preferable for multiple workers/replicas or if existing managed backup operations outweigh coupling.
Do not share Atlas tables or credentials. The storage choice is not implemented in this PR;
validate Node 22 driver support, transactional replay, volume ownership and backup/restore first.

The current RelayAgent TypeScript Pick is only an HTTP test seam over Pi, not the promised
versioned harness abstraction. Existing cost reporting is also not budget enforcement.

## Validation gates

Every substantial PR includes targeted unit and real-boundary integration coverage and passes
Verify on its exact head. Add Playwright with the gateway vertical slice for chat, activity,
failure and reconnect paths. Separate deterministic service fixtures from credential-dependent
live smoke tests; neither substitutes for the other. Test rejected tools before dispatch,
duplicate requests/results, missing Node capabilities, redaction, process restart, cancellation,
unsafe retry prevention and bounded queues as those features are introduced.

Measure startup, idle/active memory and database/event growth before changing VPS limits.
No claimed performance improvement without measurements. Production remains independent of the Mac.
