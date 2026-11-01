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

Children inherit the **parent's selected model** by default, including an Ollama
Qwen model. The optional `modelKey` override is offered to the Pi tool as an
enum of exact, currently configured Relay model keys, such as
`ollama/qwen3-coder:30b`, plus the current local model's exact Ollama ID
as a shorthand. Arbitrary display names are not accepted. For compatibility,
a child may supply the raw Ollama model ID only when it matches the exact
selected local parent model: it is interpreted as **inheritance**, never as
a provider switch. Invalid, unknown or unauthorised model requests still fail
closed, without switching to cloud inference. If the local provider goes
offline or a model is removed, the harness reports that availability problem
rather than silently choosing another provider.

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

## B3: Inline subagent progress (chat-first)

Normal chat snapshots include a bounded `agents` projection keyed by visible
root task ID. It is derived solely from persisted parent/child task relationships:
role, run ID, state, dependencies, model allocation when known, usage and the
latest persisted tool status. Child conversations, full transcripts, tool
arguments, private model context and approval arguments are not included.
The projection never relies on the model describing an action as completed.

Each reply has a compact expandable agent summary; opening it reveals the child
tree, genuine queued/running/waiting/terminal states, limited task descriptions
and clearly marked *agent-reported, unverified* handoff summaries. A Details
action opens that exact task in the existing Tasks & Agents console (including
its complete trace, controls and approval decisions). No project picker or
new task dashboard is required.

The expansion uses stable keyed DOM rows and survives streaming and snapshot
updates; a server snapshot is authoritative and missing/replayed lifecycle
events cannot invent workers. Persisted tasks reconstruct the tree after reload
or restart. Legacy servers without the projection fall back to the earlier
event-only disclosure during a rolling deployment. Unbounded child logs and
raw internal transcripts remain available only through authenticated task
inspection, not the inline chat snapshot.

## B4: Descendant budget accounting and final acceptance

Delegated token/cost ceilings now apply to the **entire nested agent subtree**,
including children, siblings and inference-only join continuations. Spend
reported by one child reduces the entire subtree's remaining allowance. Before
admission or dispatch, the scheduler includes measured/estimated usage and
active per-run USD reservations, and fails closed on unknown usage or missing
ancestry. Live usage callbacks cancel the active run when the aggregate limit
is reached. Exactly spent USD is exhausted even with a zero reservation.
When a shared delegated ceiling is exhausted by a live receipt, Relay
immediately aborts **all active descendants** of every exhausted ancestor,
including concurrently running siblings with no fresh usage yet. Unrelated
root tasks remain unaffected. A coordinator cannot bypass its limit by
spawning independent child conversations. This is best-effort containment
around provider usage
receipts, **not a prepaid hard cap**: a provider may incur in-flight cost before
reporting tokens or price, so real billing can exceed these ceilings.

### Acceptance matrix

- Automated: non-Atlas two-worker fan-out/fan-in, dependency handling,
  structured and plain-text handoff, persisted IDs, restart interruption,
  cancellation propagation, capability isolation, usage ledgers, nested
  aggregate token/cost exhaustion (including exact USD equality and concurrent
  sibling cancellation without a second receipt), and rendering of child state
  after reload.
- Automated with actual Pi SDK **without inference credentials**: restrictive
  session initialization and cancellation. These tests verify the adapter
  contract but do not demonstrate a provider completing an AI response.
- Browser CI: task console and inline subagent inspection, streaming and
  reconnect UI, approvals, and separate GitHub/Skills browser suites.
- **Not yet credentialed / deployed acceptance:** Real Pi-powered parent
  delegates two agents, they call an authorised MCP provider, receive and
  synthesise verifiable tool results, and the UI survives reload/reconnect.
  Test a restarted in-flight provider, failed or offline local model, and an
  approval held while unrelated work progresses on a real deployment.
  Record the deployed commit, model, provider, timestamps, task/run IDs,
  observed tool receipts and actual outcomes before marking this complete.

## Deferred extensions

User-editable/Skill-backed profile manifests, explicit per-child Skills,
prepaid provider cost reservations, general-purpose durable side-effect
reconciliation across all connectors, and releasing an inference slot for
pending human approvals require separate design and acceptance. Existing
approval waits remain slot-occupying, so a concurrency-1 deployment cannot
serve another inference until the approval resolves or the run is cancelled.
Do **not** represent this as a verified fully unattended orchestration agent.
