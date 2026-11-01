# Tasks & agents workspace

Relay remains chat-first. Tasks & agents opens a separate operations view without switching conversations or interrupting running work.

## API and security

The console reads existing persisted tasks, conversations, approvals and execution events. No new durable agent-run model, scheduler, permissions or migrations are introduced.

- `GET /api/task-console/tasks?limit=50&cursor=<rowid>&state=<state>&conversationId=<id>` returns bounded task previews, total state counts within the conversation, `nextCursor` and `hasMore`. The cursor is an exclusive persisted row ID, stable under later inserts. Limit 1–100; state, conversation and cursor are validated server-side.
- `GET /api/task-console/tasks/:id` returns authoritative full task detail, its source conversation, children and redacted approval previews. Absent source conversations are represented as null.
- Existing `GET /api/sessions/:id/events?after=<sequence>` supplies bounded activity replay for the selected task.
- Existing task cancel/retry and approval endpoints remain the only mutation routes; retries require explicit reconciliation and the backend enforces permissions and state.

## Loading and navigation

The list has **two modes** and **one history cursor**:

1. **Live:** every four seconds, replace the newest 50 rows and counts from the server. No displaced tasks accumulate automatically. The filtered initial page may be empty or contain fewer than 50 tasks.
2. **History:** the first **Load older tasks** action freezes the currently displayed rows, state counts and current exclusive cursor. Each subsequent click loads only earlier rows, without rewinding when agents enqueue more tasks. A lightweight poll checks for updates but does not merge them into the frozen list; the view shows an update notice when the latest first page changes. **Refresh** returns to live mode and reloads from the newest page.

Only rows explicitly loaded by the user can increase the history DOM. A historical page is bounded by the cursor captured before newer tasks arrived. While browsing history, previously loaded rows are deliberately not refreshed against state filters; a filter membership change appears after Refresh. Search applies to already-loaded rows only. Changing the state or conversation filter clears the selected task and starts a new live view.

Task selection is independent of list pagination. Details refresh while visible even in history mode and can continue showing a task that has left the current status filter or was opened through a parent, dependency, child or previous-attempt link. The detail view always uses fresh server state to decide which actions to show; if a refresh fails, action controls are hidden instead of presenting stale controls.

The task timeline scans up to four 500-event pages per foreground refresh, automatically advancing through unrelated conversation events; up to 120 selected-task entries are displayed. Repeated replay failures use one reusable activity error message, cleared after a successful retry. The full persisted task result is available in a scrollable pane. During visible detail refreshes, new result text and usage receipts update existing DOM nodes in place, retaining the user's output scroll position, focused controls and open approval disclosures. State/relationship changes may rebuild controls, while restoring the result scroll position. A selected Node is never represented as an executing Node without an execution receipt.

## Tests and limitations

Automated tests cover live growth across 50/51 tasks, bounded unattended DOM, monotonically descending history cursors under concurrent inserts, frozen history after task-state changes, explicit refresh, stale-response invalidation, selected-task state changes, related-task navigation, and normal mutations, event replay and output rendering. Error → repeated error → recovery activity tests enforce bounded warning DOM. A separate real-Chromium browser regression verifies that the output pane remains scrolled across streaming updates and a Running → Completed structural redraw; it runs in CI after installing the browser.

The local UI preview is fixture-only; it uses the same exclusive rowid cursor semantics as the production API. A history snapshot freezes what has been **loaded**, not a transactionally versioned copy of the database: an older page is filtered using persisted state when the user explicitly requests that page. Pi child tasks are read-only projections of actual SDK sessions. Cancelling a child cancels its owning delegated turn, including siblings; it does not leave an orphaned parent tool call. Hands-on desktop/mobile validation remains an operator acceptance step.
