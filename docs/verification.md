# Reconstruction verification

Executed locally on 2026-11-01. These are author checks, not independent review or deployment approval. The final PR records exact base/head commits.

| Check | Result |
| --- | --- |
| `npm run verify` | 163 passed, zero failures; includes strict TypeScript and production bundles |
| Real Chromium browser suite | 6 passed: model switching/rejection, GitHub approvals, reviewed Skills, task scrolling, child disclosure/navigation |
| Real Pi SDK integration | 6 scenarios: parallel, sequential, external read failure, denied grant, cancellation, Atlas read/resource attribution |
| Session continuation | Same Pi session reopened by a new harness, model changed, history retained and prior MCP effects not replayed |
| Production dependency audit | Zero known vulnerabilities after scoped undici 8.12.2 and minimatch 11.0.1 overrides |
| Production Docker | Node 22 image built; real Pi/MCP suite run with production-only dependencies, network disabled and read-only filesystem |
| Live Qwen + GitHub MCP | Passed with `qwen3-coder:30b`, actual GitHub remote MCP, issues #28 and #29 |

## What is real in the integration suite

`tests/pi-runtime.test.ts` creates actual `ModelRuntime`, `AgentSession`, `DefaultResourceLoader`, MCP and tool-search extensions and JSONL sessions. A local HTTP provider supplies deterministic inference responses; a real MCP SDK HTTP server supplies external data. Pi internals, extension lifecycle, discovery, dispatch, event ordering, result shape, cancellation and persistence are not mocked.

Parallel children overlap their MCP calls, have separate identities/session files and record actual usage and invocation receipts. Sequential mode checks prior result handoff. A source error fails the affected child, an unauthorized tool grant starts no child, and parent cancellation terminates the family. Atlas coverage inspects a real Pi-wrapped structured MCP result and asserts the Node observation reaches the durable child event stream. Custom unit tests cover revoked results and checkout-to-Git resource attribution.

The model-switch API test exercises authentication and active-task rejection. The browser test confirms switching preserves the chat and rejected selections restore server state. Recovery tests preserve historical data while interrupting unfinished work; they do not silently replay effects.

## Live evidence

An isolated compiled Relay backend used the local Ollama endpoint and an existing GitHub credential held only in the child process environment. Its temporary data directory was removed afterward. No production deployment, production data access or GitHub mutation was performed.

The smoke submitted two explicit parallel child assignments with only `mcp__github__issue_read`. Both real children completed, their running intervals overlapped, each produced a successful native read receipt, and the parent included the actual exact issue titles in its synthesis. The final run printed:

```json
{"ok":true,"mode":"pi-native","childRuns":2,"readReceipts":2,"parallel":true,"parentSynthesized":true}
```

Earlier live runs completed both reads but failed the exact-title assertion. A subsequent identical run passed; the final smoke prompt also explicitly asks each child to return its verbatim title. This is evidence of working execution and successful synthesis, not a guarantee of deterministic model compliance. The application does not mark arbitrary research verified merely because its prose claims success.

## Reproduce

```sh
npm ci --include=dev --ignore-scripts
npm run verify
npx playwright install chromium
node --import tsx --test --test-timeout=65000 tests/*.browser.ts
docker build -t relay:check .
```

CI also bundles the real-runtime test and runs it inside the production image. For live GitHub acceptance, start an isolated Relay instance with GitHub configured and enabled, then set `RELAY_SMOKE_URL`, `RELAY_ACCESS_TOKEN` and `RELAY_SMOKE_MODEL_KEY` and run `npm run pi:smoke`. The URL must be HTTPS or loopback HTTP. This creates a test conversation and invokes reads; do not target production casually.

## Unverified acceptance and bounds

- No Relay Atlas service credential or OpenRouter key was available. Credentialed Atlas/Node reads, authorized development-task execution and OpenRouter inference remain unverified. Use `npm run atlas:smoke` for service access, then a real Relay conversation for native parent/child Atlas execution. The service smoke alone does not prove agent orchestration.
- No live GitHub or Atlas write was attempted. Exact approval and uncertain-result behavior are checked with custom policy/API/browser tests.
- Production ingress, private Tailscale access and hands-on desktop/mobile/accessibility behavior were not deployed or manually validated here. CI results are reported separately in the PR.
- Model/tool compliance remains probabilistic. Unknown usage is retained as unknown. Budgets are checked on completed inference receipts and cannot prevent all in-flight overshoot.
- Four concurrent children per parent, eight per turn, two-minute child timeout, one child generation. Child cancellation cancels its owning delegated turn and siblings. No autonomous recurring jobs or automatic cross-conversation memory capture is enabled.
- Operator extensions execute with server authority. Their source and dependencies require review; the model tool allowlist is not a code sandbox.

Migration/rollback instructions are in [migration](migration.md). The original dirty checkout was preserved separately; reconstruction started from fetched main on one dedicated branch.
