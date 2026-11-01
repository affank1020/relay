# Chat UI

Relay retains the dark, chat-first shell with restrained yellow accents, blocky controls and responsive navigation. Searchable conversations, safe Markdown, streamed output and explicit approvals remain the main interaction.

Models can be switched within an idle conversation. The server rejects switching during work; the client blocks sending until a selection is confirmed and restores the actual selection after rejection. Changing the model does not create a new chat. Pi persists the model change with subsequent execution.

Activity includes source-tool receipts and a loadable Pi session trace. Tasks & agents displays actual child identities, state, usage and results while preserving scroll position and expanded disclosures. SQLite serves these UI projections; Pi owns the underlying transcript and execution.

Skills & integrations exposes reviewed Skills, configured MCP providers and operator-installed Pi extensions. Enabling an integration grants only the configured tool vocabulary; it does not imply that the service is healthy. Executable extensions remain operator-installed trusted code.

Atlas discovery needs no Project selector. Optional pinned context and resource cards are conveniences based on retrieved identities, not execution authority. Atlas links never bypass its own authentication.

Automated Chromium covers model switching, approvals, Skill installation/revocation, task scrolling and child navigation. Hands-on production desktop/mobile and accessibility acceptance remain operator checks. See [verification](verification.md).
