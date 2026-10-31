# Tasks & agents workspace

Relay remains chat-first. The flat Tasks & agents navigation item opens a task operations screen without expanding the chat sidebar, changing the selected conversation, or canceling any task.

## Data model and API

This screen uses existing persisted Task, Approval and ExecutionEvent models. It does not create a new agent pool or independent durable agent-run model. A task is a scheduled unit of work; agentRunId may equal its task ID.

All new routes are protected by the existing bearer-token or authenticated ingress and origin checks.

- GET /api/task-console/tasks?limit=50&cursor=<rowid>&state=<state>&conversationId=<id> returns tasks, nextCursor, hasMore and counts. Limits 1–100; descending persisted rowid order. Cursor is exclusive and stable under inserts. Filters are validated server-side. Counts cover all states within the selected conversation filter, regardless of state selection.
- GET /api/task-console/tasks/:id returns task, conversation, children and approvals. Missing conversations return null. Child relationships use persisted parentId. Approval argument previews are bounded and recursively redacted.
- Existing GET /api/sessions/:id/events?after=<sequence> returns 500-event batches with server-ordered cursor. The screen filters events by task ID and does not show model text deltas in activity.
- Existing POST /api/tasks/:id/cancel, POST /api/tasks/:id/retry and POST /api/approvals/:id are the only mutation routes. Retries require an explicit user reconciliation confirmation and reconciled:true. Backend guards remain authoritative.

## Interaction

Status filters, conversation filters, a search of loaded tasks, concise entries, task details, parent/dependency/child links and the source conversation link are available. The initial list is bounded to 50 tasks with cursor pagination. The newest page polls every four seconds while the screen is visible. Existing row elements are reused to maintain keyboard focus; old loaded rows can remain stale until revisited. Mutations always use authoritative task state.

Execution activity loads for the selected task, replayed using the existing event sequence cursor. At most 120 entries are visible at once; further batches are loaded on demand. A selected Node is not labelled as executing: only an event containing executingNodeId displays a reported execution receipt.

Cancel, retry, approve and reject invoke guarded server routes. UI does not assume success until response. Navigation never cancels work. Approval arguments have an explicit redacted disclosure.

## Testing and limitations

The localhost preview is fixture-only and does not demonstrate real Atlas or inference. There are no new permissions, schema migrations, scheduler rewrites or model calls for the console. Parent/child links can point outside the loaded page and are fetched individually. Conversation management and Atlas context are separately owned by issues #18 and #19.

After those branches merge, run the cross-track regression pass documented in coordination issue #21 and verify desktop and mobile browser interactions against reviewed main.
