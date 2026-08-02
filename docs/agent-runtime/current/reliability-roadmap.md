# Codex Agent Reliability Roadmap

Status: **live** for the R7-R10 reliability scope; **not product complete**

This document is the source of truth for R7-R10. Codex App Server remains a pinned `0.146.x` black box and the only enabled execution profile is `toolbox-only`. VCPToolBox is not modified.

## R7: Profile, Session, and IPC

- `AgentProfile` is a template with a monotonically increasing revision.
- `SessionConfigSnapshot` freezes profile identity at Session creation.
- Profile avatar assets are immutable revisioned files. Updating an avatar advances the Profile revision; existing Sessions keep the avatar URL frozen in their snapshot.
- Materialized Threads allow model and permission changes for the next Turn. Prompt and workspace changes create a new Session.
- Before Thread materialization, prompt and workspace remain editable under Session config CAS. Agent identity is fixed once the Session exists.
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
- Fault injection covers crash before `turn/start`, lost transport during RPC, and ACK before SQLite acceptance commit. Ambiguous transport loss becomes `uncertain`, never retryable `failed`.
- Restart is demand-driven with bounded backoff. Interrupted Turns are not replayed.
- Opening Workbench or selecting a Session never eagerly starts App Server; first send or an explicit recovery scan is runtime-required.

## R9: Projection and Saga

- Codex-owned Items absent from `thread/read(includeTurns: true)` are deleted transactionally with their Blocks.
- Explicit empty/null snapshot fields can clear old content. Omitted optional fields preserve newer live data.
- Reconciliation uses a mutation generation barrier and retries a bounded number of times.
- Thread start/fork/archive/unarchive/delete use `agent_operations` states: `prepared`, `dispatching`, `remote-applied`, `completed`, `uncertain`, `failed`.
- Known-Thread archive/unarchive/delete operations resume idempotently on the next App Server generation; start/fork remain explicit human recovery because an unreturned Thread ID is not safe to guess.
- SQLite failure may enter read-only degraded mode. Lists, projection reads, and export remain available; mutations are rejected.
- Writable and read-only startup both run integrity checks; constructor failures close SQLite handles before fallback or shutdown.
- Saga reports split state. It does not claim cross-process ACID.
- Uncertain start/fork recovery uses explicit `thread/list` candidates. Only a user-confirmed bind/delete action resolves the Saga.

## R10: Privacy and Governance

- Normal deletion is archive. Permanent deletion requires an archived, idle Session with no approval or queued/uncertain input.
- Permanent deletion calls `thread/delete`, removes the SQLite projection, and retains only hashed deletion receipt identity.
- Projection export is explicit JSON or Markdown through Main.
- Archived Sessions remain projection-only, composer-disabled, and can be restored, exported, or permanently deleted under the safety preconditions.
- Workspace operations use bounded general/search schedulers and cancellable request IDs.
- Agent Renderer is an independent product implementation. Main-chat and Agent share security/golden fixtures only.
- Electron recovery covers concurrent Session identity, Renderer reload, demand restart, archive/restore/permanent delete, pending-interaction blocking, and forced read-only degraded mode.
- Real ToolBox/Nova tests remain a manual release gate and must never run in credential-free CI.

## Verification Receipt

- Functional revision: `261d11ba7577125867a236033a13be58d94ae72d`.
- Committed gates passed: `test:codex-reliability`, `check:ui-system`, `test:codex-ci`, and `test:electron-codex-smoke`.
- On 2026-08-02, `deepseek-v4-flash` passed the real two-Thread gate in one App Server process: both Turns ran concurrently, interrupting A did not affect B, and the two SQLite projections remained isolated.
- The real `vcp_invoke -> FileOperator.ReadFile -> bridge -> Projection` gate passed after a repository-provided DistributedServer node registered FileOperator. The first attempt correctly failed with `Plugin "FileOperator" not found`; no VCPToolBox source or configuration was changed.
- The machine-readable details are in [r7-r10-working-tree.json](receipts/r7-r10-working-tree.json).
- Native Codex approval, ToolBox backend approval replay/exactly-once, VCPInfo/VCPLog reconnect/replay, and rich Electron visual/performance acceptance remain product gates.

### R7 profile identity follow-up

The follow-up implementation freezes Profile name/avatar in `SessionConfigSnapshot`, versions avatar files by Profile revision,
retains durable `threadId` in the Workbench projection, and makes pre-materialization Base Instructions editable under
`expectedConfigRevision`. Materialized prompt/workspace and all existing Session Agent selectors are fail-closed in the UI and
Runtime Manager. Its committed revision and command receipt are recorded in `test-matrix.md`; this section is not a product-ready claim.

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
