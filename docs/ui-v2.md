# Relay UI V2 — chat-first foundation

Relay's first UI V2 milestone prioritises a readable conversation view, lightweight navigation and Atlas/agent context supporting the chat — not a second dashboard.

## Implemented in PR #15

- Responsive dark-mode shell, mobile navigation, new-chat shortcut, searchable conversations.
- Provider/model selection remains pinned to new conversations. OpenRouter and Ollama safety rules remain unchanged.
- Safe Markdown: headings, paragraphs, emphasis, links, lists, blockquotes, inline code and fenced code with copy. Untrusted model text never becomes HTML; link protocols are HTTP(S) only.
- Atlas status/projects/workspaces starter prompts fill the composer but do not dispatch any tool until Send is pressed.
- Recent tasks and agents are collapsible. A separate activity inspector displays real deterministic events, not model-generated summaries.
- Atlas tool invocations appear as compact receipts adjacent to the assistant's response, based on Atlas gateway events, not inferred from generated text.
- Approval and reconciliation safeguards are unchanged. Backend persistence, Atlas MCP access controls and authentication are unchanged.

## Follow-up iterations, out of scope for this PR

- A project/workspace context picker, populated from a strictly read-only Atlas API, with server-side ID validation and session persistence.
- More useful structured tool result summaries, verified Atlas resource deep links, and Node placement details.
- Truly incremental streaming rendering; a dedicated agent/task orchestration view; and bounded model availability checks for Ollama status.
- Playwright browser screenshots, accessibility/keyboard and narrow-viewport validation in a real browser.

## Safety and acceptance

- Atlas configured status is not an online/healthy check; only execution receipts confirm tool use.
- Model output is always untrusted and never inserted as HTML. Starter prompts cannot silently trigger tools.
- Preserve request idempotency, explicit retry reconciliation, server-side Atlas permissions, Basic Auth and protected API routes.
- The activity panel preserves native expanded state during polling and replays deterministic events.
- No database migration, new ingress or credential scope changes. Production visual QA remains to be done.
