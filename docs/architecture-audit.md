# Pi-native reconstruction

Baseline: `17e0efe` (2026-11-01). This document records the audit and implementation decisions; verification results are recorded separately.

## Findings and ownership

| Subsystem | Baseline problem | Target owner |
| --- | --- | --- |
| Agent loop, inference, compaction | Relay wrapped Pi in task execution and separate continuation inference | Pi AgentSession |
| Child execution | SQLite scheduler plus tintinweb manager, RPC adapter and cross-session bus | Bounded Pi delegation extension creating SDK sessions |
| MCP | Native Pi transport plus generic ConnectionManager plus child-to-parent broker | Pi MCP extension per session; Relay admission hooks |
| Conversations | Pi JSONL plus duplicated text in SQLite | Pi is transcript authority; SQLite holds product metadata and read models |
| Tasks & agents | Multiple execution records, handoff JSON, joins and prompt heuristics | Real session identities, lifecycle and native tool events |
| Atlas | Useful domain observation mixed with execution and project pinning | Optional domain policy and UI above MCP; discovery requires no selector |
| Skills | Reviewed installation, enablement, bounded reader | Keep server trust boundary; Pi resource loading and discovery |
| Providers | ModelRuntime plus model catalog and Ollama proxy | Pi inference/auth; Relay operator endpoint policy and UI catalog |
| HTTP/auth/events | Necessary browser boundary, reconnection and admission | Relay |
| Writes | Explicit operation/repository approval and uncertain dispatch accounting | Relay policy, Pi transport |
| Deployment | Production load paths hard-coded to child bridge, opt-in convergence flags | One installed runtime and one execution path |
| Memory | No established ownership or user controls | Opt-in extension only; no automatic connected-data ingestion |

The reported parallel-research failure is architectural: a child session did not own its source tools. It asked a separate broker to execute a tool in the parent's session. The broker relied on manager identity, scoped event buses, nested result shapes, and completion receipts. The harness then inferred intended orchestration from English regular expressions and failed the root after inference. UI cards could represent completed inference without successful source retrieval.

The existing `pi-child-mcp-cross-session` test manually invokes an extension tool with invented session identity and an injected registry. It never creates Pi sessions, loads native MCP, or performs inference. It cannot establish cross-session behavior.

## Upstream investigation

The installed, pinned Pi 1.4.0 package includes SDK source, declarations, docs and extension examples. `createAgentSession`, `DefaultResourceLoader`, `createMcpExtension`, `createToolSearchExtension`, `SessionManager`, `ModelRuntime`, `bindExtensions`, `subscribe`, `prompt` and `abort` provide the needed primitives. A session has its own extension runtime. Explicit tool modifiers preserve deferred discovery; invocation hooks must still enforce the immutable grant.

The installed `@tintinweb/pi-subagents` 0.22.1 source (`agent-runner.ts`, `cross-extension-rpc.ts`, `index.ts`) and [public RPC contract](https://github.com/tintinweb/pi-subagents/blob/master/docs/rpc.md) show a CLI-oriented manager. RPC strips configuration-root and session ownership fields, and overwrites session-created and tool callbacks. Child MCP configuration comes from the child's resource loader, not the parent's inline factory. Using its public bridge for per-run web permissions therefore requires the adapters Relay accumulated. The global manager slot also makes it an unsuitable identity authority for concurrent independent web sessions.

Pi's [bundled subagent example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent) spawns CLI processes and supports single, parallel and chain modes. Its invocation/environment assumptions need adaptation for a server. [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents/blob/main/docs/agents.md) provides richer workflows and strict child registry checks, but also manages agents, process/artifact lifecycle and ambient configuration. Neither warrants introducing another manager just to create scoped SDK sessions.

Decision: use a small Pi extension for bounded parallel/sequential SDK session composition. It owns no independent inference loop, transport, event bus or durable work queue. Pi executes every parent/child turn and returns child results through its normal tool protocol. Independent work gets independent sessions and MCP clients. Sequential handoffs are explicit untrusted outputs. Background continuation follows the lifetime of the server request job, not the browser connection. Autonomous schedules remain out of scope until an explicit bounded scheduling product is enabled.

[pi-mem](https://github.com/georgebashi/pi-mem) captures and compresses observations; tintinweb also supports agent memory directories. Automatic capture would ingest connected personal data without a reviewed scope and retention UI. Do not enable it by default. Pi sessions and compaction already supply conversation continuity. A future memory extension must expose inspect/delete controls, restrict source scope and disable autonomous writes until the owner opts in.

## Verification standard

Unit tests are appropriate for Relay's permission, budget, resource mapping and HTTP logic. Runtime acceptance uses real Pi sessions and real native MCP clients against fixture HTTP services. Only provider inference responses and external service data are simulated. Live Qwen/OpenRouter and credentialed GitHub/Atlas acceptance must be reported separately, with no inference from fixture success.
