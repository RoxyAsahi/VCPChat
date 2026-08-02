# Codex Agent Reliability Roadmap

Status: **implemented** (working tree, not yet hermetic receipt)

This document is the source of truth for R7-R10. Codex App Server remains a pinned `0.146.x` black box and the only enabled execution profile is `toolbox-only`. VCPToolBox is not modified.

## R7: Profile, Session, and IPC

- `AgentProfile` is a template with a monotonically increasing revision.
- `SessionConfigSnapshot` freezes profile identity at Session creation.
- Materialized Threads allow model and permission changes for the next Turn. Prompt and workspace changes create a new Session.
- Session setting writes use `expectedConfigRevision` compare-and-swap.
- Projection-only IPC never starts App Server and never waits for ToolBox configuration.
- ToolBox settings are applied by a latest-wins generation drain.
- Renderer selection is `selectedSessionId`; process state is `activeRuntimes: Map`.

## R8: Runtime and Durable Input

- Each App Server spawn has a new runtime generation.
- Approval and interaction responses must match the originating generation.
- Terminal interaction records have TTL and capacity bounds and are cleared fail-closed on stop/crash/authority change.
- Follow-up input states are `queued`, `dispatching`, `accepted`, `uncertain`, or `failed`.
- Only `queued` input is automatically dispatched. A crash-window `dispatching` input is verified with `thread/read`; it is never automatically replayed.
- Restart is demand-driven with bounded backoff. Interrupted Turns are not replayed.
- Opening Workbench or selecting a Session never eagerly starts App Server; first send or an explicit recovery scan is runtime-required.

## R9: Projection and Saga

- Codex-owned Items absent from `thread/read(includeTurns: true)` are deleted transactionally with their Blocks.
- Explicit empty/null snapshot fields can clear old content. Omitted optional fields preserve newer live data.
- Reconciliation uses a mutation generation barrier and retries a bounded number of times.
- Thread start/fork/archive/unarchive/delete use `agent_operations` states: `prepared`, `dispatching`, `remote-applied`, `completed`, `uncertain`, `failed`.
- SQLite failure may enter read-only degraded mode. Lists, projection reads, and export remain available; mutations are rejected.
- Saga reports split state. It does not claim cross-process ACID.
- Uncertain start/fork recovery uses explicit `thread/list` candidates. Only a user-confirmed bind/delete action resolves the Saga.

## R10: Privacy and Governance

- Normal deletion is archive. Permanent deletion requires an archived, idle Session with no approval or queued/uncertain input.
- Permanent deletion calls `thread/delete`, removes the SQLite projection, and retains only hashed deletion receipt identity.
- Projection export is explicit JSON or Markdown through Main.
- Archived Sessions remain projection-only, composer-disabled, and can be restored, exported, or permanently deleted under the safety preconditions.
- Workspace operations use bounded general/search schedulers and cancellable request IDs.
- Agent Renderer is an independent product implementation. Main-chat and Agent share security/golden fixtures only.
- Real ToolBox/Nova tests remain a manual release gate and must never run in credential-free CI.

## Authority Boundary

| Concern | Authority |
| --- | --- |
| Context, Turn execution, resume | Codex Thread Store |
| Durable display projection | VChat Agent SQLite |
| Profile template | VChat `CodexAgents` catalog |
| Session configuration | Frozen SQLite Session snapshot + CAS revision |
| VCP tools and backend approval | VCPToolBox through the bridge |
| Selected view | Renderer `selectedSessionId` |
| Runtime activity | Main `activeRuntimes` projection |
