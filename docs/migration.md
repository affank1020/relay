# Reconstruction migration and rollback

No production deployment is performed by this branch. Review the final PR and verify acceptance before merging; the existing main deployment workflow is still active.

1. Stop admissions and allow important work to finish. Back up the entire Relay data volume, including SQLite/WAL and `sessions/`, and retain the previous image digest and private environment configuration.
2. Build and test the new image in isolation. Reuse the complete data layout; no transcript or table is destructively migrated. Do not point two running Relay servers at one data volume.
3. Remove obsolete `RELAY_PI_FOUNDATION`, `RELAY_PI_NATIVE_MCP`, `RELAY_PI_SUBAGENTS` and `RELAY_PI_CHILD_MCP` entries. The native path is always active. Remove old `.pi/agents` bridge files from custom deployment mounts. Native MCP tool names replace `mcp_provider_tool` names for new calls.
4. Keep existing capability enablement, reviewed Skills, GitHub/Atlas credentials, approval scope, budget settings and ingress. Pi JSONL remains under `sessions/<conversationId>/`. No credential is sent to the browser.
5. On first start, running/awaiting-approval work, old waiting-child tasks and queued legacy child/join jobs become interrupted. They are never automatically replayed. Ordinary queued root work can resume admission. Pending approvals are rejected; known pre-dispatch GitHub writes become denied. Dispatched/uncertain operations remain available for reconciliation.
6. Verify an ordinary chat, model switching, restart/resume, native tool discovery, parallel child reads, cancellation and approvals. Follow `verification.md`; fixture tests do not replace live acceptance.

Historical tasks, child relationships, events, usage, approvals and old handoff display fields remain readable. No new legacy joins or scheduler children can be created. A reconciled retry creates a new visible conversation; it does not mutate the previous parent's result. Retry old delegated requests as fresh native research if their historical tool names are obsolete.

To roll back, stop the new instance and restore the previous image plus the pre-upgrade data-volume backup. Do not blindly roll back only the image after new native sessions or writes have run: reconcile external effects first. Do not delete production data to resolve a migration problem.
