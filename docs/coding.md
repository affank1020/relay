# Atlas coding in Relay (opt-in)

Relay can use Pi's native MCP to read, edit and publish code through Atlas's registered macOS/Linux workspaces. Relay never gains an unrestricted local shell, and only the root Pi session may use the coding tools.

## Operator setup

1. Configure the Atlas MCP URL and server credential, and enable the Atlas integration in Relay.
2. Set `RELAY_ATLAS_CODING_CHECKOUTS` to a comma-separated list of trusted existing checkout UUIDs (up to 12). Obtain the UUIDs through Atlas discovery; this is **not** a GitHub repository name or a filesystem path. Empty means *no* Atlas coding tools.
3. For named tests/builds, configure approved commands on the Atlas checkout and include their exact names in `RELAY_ATLAS_DEV_TASKS` under that checkout UUID. Atlas also enforces its task config; Relay does not accept arbitrary shell strings.
4. Restart Relay after editing its private environment; do not place service tokens in the conversation.

## Expected workflow

- Inspect the GitHub issue, source tree, current checkout status and Node.
- Call `workspace_git_create_worktree` on an allowlisted base, naming an `atlas/*` branch under an Atlas-trusted development root. This asks approval for the exact operation. **Never edit the base checkout.**
- Relay independently verifies the returned newly created checkout ID, Node, repository and branch. Only a verified worktree becomes writable for the **current root turn**.
- Read the target file first, then use SHA-checked `workspace_patch_file`, `workspace_create_file` or `workspace_delete_file`. The first bounded edit/test/commit requires one checkout-scope approval; subsequent operations on that checkout during the same turn do not repeatedly ask for approval.
- Run named test/build tasks if allowlisted, inspect Git status/diff, stage named files and commit.
- Push the `atlas/*` branch and open a draft PR. Each publishing step asks an **exact-arguments** approval; merging and deployment are not exposed.

Every write is checked against current Atlas checkout placement, Node online status, advertised capability and Git branch. Revocation prevents further calls. A write whose result is uncertain is never silently replayed.

## Current boundaries

- Child sessions are read-only and cannot inherit coding authority.
- No arbitrary bash, arbitrary Git mutations, deployments, merges or production execution.
- A derived worktree is automatically admitted only within the same agent turn; for a later turn, add its verified checkout UUID to the operator's coding allowlist and restart Relay. Persisting a narrower user-reviewed grant is follow-up work.
- Named tasks need both Atlas configuration and an exact base-checkout entry in Relay's `RELAY_ATLAS_DEV_TASKS`. With an Atlas Server supporting approved worktree task inheritance, verified worktrees created during the same Pi turn can run the base's named tasks. Older Atlas versions may not inherit tasks, so deploy the corresponding Atlas change first. Future turns require a fresh authorised coding scope.
- Only an operator-provided Atlas checkout can be a starting point; model prose and stale Node status cannot grant authority.
- This is a coding-enablement slice, not proof of live end-to-end acceptance. Before using it for unattended work, test one small real issue through worktree, edit, tests and draft PR, and review the first PR manually.
