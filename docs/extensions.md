# Adding capabilities

## MCP

GitHub and Atlas have explicit operator configurations in `.env.example`. Enable the configured integration through Skills & integrations. Additional HTTPS services use `RELAY_MCP_PROVIDERS` and an explicit `RELAY_MCP_HOST_ALLOWLIST`; credentials are named environment variables, never browser fields. Only configured read tool names enter a session. Pi supplies actual discovery, schemas, connections and tool execution.

New child-capable source tools need no broker: add the reviewed read name to the provider configuration. The `delegate` schema exposes the parent's admitted read names, and each child receives its requested subset. All writes remain excluded from children.

## Skills

Bundled Skills live in `skills/`. The UI also supports reviewing and installing a single `SKILL.md` from an immutable GitHub commit with a content fingerprint. Installation starts disabled. Pi discovers enabled, validated resources; the bounded `read_skill` tool supplies only the reviewed bytes. Supporting-file packages requiring arbitrary filesystem access need an operator-reviewed extension, rather than silently enabling `read` or shell tools.

## Executable Pi extensions

Install a pinned extension dependency or mount a reviewed extension file into the container. Set, for example:

```dotenv
RELAY_EXTENSION_PATHS=["/extensions/reviewed-extension.js"]
RELAY_EXTENSION_TOOLS=reviewed_tool
```

Paths are absolute and load through Pi's `DefaultResourceLoader`. Tool names must be declared explicitly. The UI displays installed extension names; executable code cannot be installed through a model prompt or browser request. Restart/recreate the application to apply deployment configuration. Errors loading an approved extension must be resolved before relying on its capability.

Extensions have the process's filesystem/network/credential authority. Review their code and dependencies, and keep the Docker read-only filesystem and narrow mounts. The invocation allowlist restricts model tools; it does not constrain arbitrary trusted extension code.

## Memory and proactive work

Pi JSONL and compaction supply per-conversation continuity. No automatic personal-data extraction, shared memory ingestion or recurring job is enabled. A future memory extension must expose inspect/delete controls, explicit connected-data scope and retention, and bounded opt-in background activity. Adding such an extension should not require another agent executor.
