# Orchestration V2 (first slice)

Relay delegates work through the existing Pi harness and scheduler. No Atlas project selection is required. This is a first, deliberately bounded orchestration slice, not a general distributed worker fabric.

## Durable identities

- `Task.id` is the task / scheduler identity. A retry creates a new task.
- `Task.agentId` identifies the logical agent. An explicit retry or synthesis continuation can retain it.
- `Task.agentRunId` is a distinct UUID for a specific Pi inference attempt. It is never the task ID for newly created tasks.
- `Task.parentId` identifies the delegating task, `dependencies` are already-persisted sibling task IDs, and `continuationOf` identifies an internal synthesis run.
- Old tasks without either identity remain legible as legacy tasks. Existing schema v1 events remain preserved. New events use `schemaVersion:2`, with optional `agentId`, `parentTaskId` and `childTaskId`.

The provider-neutral event model is extended, not replaced. Skills/MCP registration and tool origin are owned by Track A; Atlas resource observations are owned by Track C.

## Execution

`relay_delegate` accepts a prompt, optional sibling dependencies, optional explicit context (at most 2,000 characters), a model key, read-tool names and optional token/cost caps. Four direct children, depth two and the existing global queue/concurrency limits apply. Tool names must be a subset of server-admitted parent read tools. A child defaults to **no external tools**, and the Atlas gateway checks that admission again at invocation. The Pi built-in shell, unrestricted MCP and arbitrary Skills are not enabled by this change.

Each child has its own persisted **internal** conversation and Pi session, so no private transcript is copied. Internal conversations do not appear in the normal chat sidebar or consume the ordinary 1,000-chat cap. Chat-list discovery uses an indexed single-pass child lookup and a single grouped task scan. They remain accessible through task details and their authenticated, read-only session inspection APIs. Legacy child conversations without provenance are recognised through persisted task parent links. The parent waits in `waiting_children` without occupying an inference worker. Once direct children reach terminal states, Relay persists a single inference-only join task in the parent conversation and supplies bounded child outcomes as untrusted evidence. The visible parent reply is augmented by synthesis; the join is not rendered as a synthetic user message.

No child gets permission to perform writes merely by delegation. Atlas development-task approvals remain centrally enforced where the existing gateway admits them (normal root agents only in this slice). Tool receipts are not inferred from prose. Dependents never consume arbitrary cross-conversation data.

## Failure and restart

A running task interrupted by restart is marked `interrupted` and is **not** replayed. Queued tasks can safely start after restart. A join already running at restart is interrupted rather than automatically repeated; the waiting parent also becomes interrupted. Waiting parents with completed or failed children may synthesise their outcomes without rerunning children. Cancellation propagates down direct child relationships. Re-running a failed or interrupted agent requires explicit reconciliation confirmation. A retried child starts an **independent visible conversation**, with a link to its previous attempt and original parent. It never mutates or adds a late result to the original parent's join, even if that join is queued; the original parent synthesis remains unchanged. The retry retains the child's admitted read-only tool snapshot. Failed top-level dependent retries can carry bounded fulfilled dependency results as untrusted data.

## Budget and deletion boundaries

Child and nested-agent usage, including join continuation usage, counts against the originating root conversation's session cap. A child chat deleted after parent synthesis retires its numeric usage to a distinct originating-family ledger, in the same SQLite transaction as the global retirement and transcript purge. Future parent turns still pay for that spending. The family ledger contains no child transcript, output or tool arguments. Deleting a completed root chat also deletes its completed hidden child/grandchild session tree in one SQLite transaction, with each session's retired global usage and durable filesystem-cleanup tombstone preserved. Root deletion then clears the family's retired usage (global retired usage remains). Unfinished, unreconciled, uncertain, or externally referenced work blocks the entire deletion without partially purging data. Child results cannot be deleted while a parent or synthesis still needs them.

## B2 follow-up: scoped MCP child reads and typed handoffs

A parent can now request `relay_delegate({profile, tools, ...})`, using a
data-only profile template (`general`, `researcher`, `reviewer`, or `implementer`).
Profiles affect output guidance only: they cannot expand a model, Skills,
filesystem or tool budget. Child Skills are disabled by default, even if the
user enabled trusted Skills for their main chat.

Non-Atlas, operator-enabled MCP reads (including the GitHub read allowlist)
can be delegated **only by exact tool name** when the parent actually
discovered that read tool. Nested agents may only narrow that set; every
child's current persisted snapshot, execution run and server/provider policy
are checked again immediately before MCP dispatch. No general MCP writes or
unapproved root tool inheritance are introduced. An offline integration yields
no admitted child tools.

A profile asks the child model to return a bounded JSON `relayHandoff` with
summary, reported evidence URLs, reported artifacts and open questions. Relay
accepts only bounded strings and HTTPS URLs without embedded credentials, and
persists an optional `Task.handoff` projection. Invalid/non-JSON answers
fall back to a compact 2,000-character task-detail summary, while parent
synthesis still receives up to 12,000 characters of the plain-text report.
Reports longer than that carry an explicit truncation flag. For nested
children, plain-text synthesis is taken from their terminal join run, not
their earlier preliminary reply. These fields are explicitly
**agent-reported and unverified**; neither the task console nor synthesis
treats their assertions as tool receipts. Nested children populate the
handoff after their own synthesis completes. Existing tasks remain readable.

## What remains

Further slices should add user-editable/Skill-backed profile manifests, explicit per-child Skill admission, robust aggregate cost reservations, external side-effect receipts across additional connectors, approval slot release, richer retry/recovery controls and browser/device QA. This first slice does **not** claim those are delivered. CI fixture tests are not a credentialed multi-agent production smoke.
