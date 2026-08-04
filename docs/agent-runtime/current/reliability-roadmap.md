# Codex Agent Reliability Roadmap

Status: **R7-R10 live receipt retained; R12 implemented/working-tree; not product complete**

This document is the source of truth for R7-R10. Codex App Server remains a pinned `0.146.x` black box and the only enabled execution profile is `toolbox-only`. VCPToolBox is not modified.

## R7: Profile, Session, and IPC

- `AgentProfile` is a template with a monotonically increasing revision.
- `SessionConfigSnapshot` freezes profile identity at Session creation.
- Profile avatar assets are immutable revisioned files. Updating an avatar advances the Profile revision; existing Sessions keep the avatar URL frozen in their snapshot.
- Materialized Threads allow model, permission, reasoning, personality and workspace changes for the next Turn through Codex 0.146 settings update.
- VChat prompt changes reload an idle Thread with the same threadId; active Turns defer the reload. VChat-to-Codex-managed transition creates a derived Session after confirmation.
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
- `uncertain` and `failed` inputs are exposed in the Session-scoped queue. Only an explicit user action can create a replacement send identity or discard the record.
- Fault injection covers crash before `turn/start`, lost transport during RPC, and ACK before SQLite acceptance commit. Ambiguous transport loss becomes `uncertain`, never retryable `failed`.
- Restart is demand-driven with bounded backoff. Interrupted Turns are not replayed.
- Interaction capacity is a hard fail-closed bound even when every entry is pending; transport exit rejects all old-generation waiters immediately.
- Opening Workbench or selecting a Session never eagerly starts App Server; first send or an explicit recovery scan is runtime-required.

## R9: Projection and Saga

- Codex-owned Items absent from `thread/read(includeTurns: true)` are deleted transactionally with their Blocks. A Message that also contains VChat/ToolBox-owned Blocks is retained and only its stale Codex Blocks are removed.
- Explicit empty/null snapshot fields can clear old content. Omitted optional fields preserve newer live data.
- Reconciliation uses a mutation generation barrier and retries a bounded number of times.
- Thread start/fork/archive/unarchive/delete use `agent_operations` states: `prepared`, `dispatching`, `remote-applied`, `completed`, `uncertain`, `failed`.
- Known-Thread archive/unarchive/delete operations resume idempotently on the next App Server generation; start/fork remain explicit human recovery because an unreturned Thread ID is not safe to guess.
- SQLite failure may enter read-only degraded mode. Lists, projection reads, and export remain available; every runtime/Codex mutation is rejected before App Server transport construction or RPC.
- Writable and read-only startup both run integrity checks; constructor failures close SQLite handles before fallback or shutdown.
- Saga reports split state. It does not claim cross-process ACID.
- On a fresh App Server generation, stale `prepared` start/fork operations become `failed`, stale `dispatching` operations become `uncertain`, and `remote-applied` operations remain explicit recovery work. None are remotely replayed.
- Uncertain or remote-applied start/fork recovery uses explicit `thread/list` candidates. A recorded Thread ID cannot be rebound to another Thread; only a user-confirmed bind/delete action resolves the Saga.

## R10: Privacy and Governance

- Normal deletion is archive. Permanent deletion requires an archived, idle Session with no approval or queued/uncertain input.
- Permanent deletion calls `thread/delete`, removes the SQLite projection, and retains only hashed deletion receipt identity.
- Projection export is explicit JSON or Markdown through Main.
- Archived Sessions remain projection-only, composer-disabled, and can be restored, exported, or permanently deleted under the safety preconditions.
- Workspace operations use bounded general/search schedulers and cancellable request IDs.
- The maintained Workspace path policy lives under `modules/codex-runtime/`; archived Pi/Rust imports are compatibility re-exports only.
- Agent Renderer is an independent product implementation. Main-chat and Agent share security/golden fixtures only.
- Renderer-only pre-Turn rows disable deferred Markdown processing so the main-chat thinking skeleton cannot be overwritten after paint.
- Agent IPC uses the central registry. Governance fails when any Handler references an undefined channel, and Runtime status has no global attachment field.
- Archived Pi/Rust scripts are explicitly namespaced, excluded from Codex product packaging, and the Rust workflow is manual-only.
- Electron recovery covers concurrent Session identity, Renderer reload, demand restart, archive/restore/permanent delete, pending-interaction blocking, and forced read-only degraded mode.
- Hermetic Electron runs isolate Chromium `userData` and disable unrelated main-chat CDS startup, so a live VChat process cannot stall the recovery gate.
- Real ToolBox/Nova tests remain a manual release gate and must never run in credential-free CI.

## Verification Receipt

- Functional revision: `c0143f64314863c0ef2dbb20ec5019d3860a7c9c`.
- Hermetic test revision: `cc6496f4b236299b14e0d4b7997bd181c126a35e`.
- Live concurrency test revision: `46e2ce419f2727349bde473fdc55327f2ced1bf5`.
- Committed gates passed on Windows x64: `test:codex-ci`, `test:codex-reliability`, `test:electron-codex-smoke`, `check:ui-system`, and `git diff --check`.
- Historical live evidence exists on revision `261d11ba7577125867a236033a13be58d94ae72d`: `deepseek-v4-flash` passed two-Thread concurrency/cancel isolation and `vcp_invoke -> FileOperator.ReadFile -> bridge -> Projection` without modifying VCPToolBox.
- Current live verification passed Nova identity/reasoning/restart/fork/interrupt, two concurrent long-form Threads with A interrupted and B completing an 8,558-character assistant response, exactly one `vcp_invoke -> FileOperator.ReadFile` call, Projection isolation, and VCPLog/VCPInfo observer connection. VCPToolBox was not modified by this work.
- The machine-readable details are in [r7-r10-working-tree.json](receipts/r7-r10-working-tree.json).
- Native Codex approval, ToolBox backend approval replay/exactly-once, VCPInfo/VCPLog reconnect/replay, and rich Electron visual/performance acceptance remain product gates.

### R7 profile identity follow-up

The follow-up implementation freezes Profile name/avatar in `SessionConfigSnapshot`, versions avatar files by Profile revision,
retains durable `threadId` in the Workbench projection, and makes pre-materialization Base Instructions editable under
`expectedConfigRevision`. Materialized prompt/workspace and all existing Session Agent selectors are fail-closed in the UI and
Runtime Manager. Its committed revision and command receipt are recorded in `test-matrix.md`; this section is not a product-ready claim.

### R8 runtime/input follow-up

The follow-up adds hard pending-interaction capacity enforcement, Session-scoped persistent input recovery actions, a new
`clientUserMessageId` for explicit resend, durable `interrupted/unconfirmed` crash state, waiter cleanup on process exit, and
bounded restart-backoff assertions. The queue UI is isolated in `agent-workbench-queue.js`; it does not infer a current
attachment or permit automatic replay.

### R9 projection/Saga follow-up

Revision `a13a3410e09252aeabfcb4c160d8d974df4582a5` closes three audit gaps: authority-aware snapshot deletion,
pre-transport read-only mutation rejection, and explicit recovery of acknowledged-but-unbound start/fork operations. Fault
injection proves that a crash after `thread/start` or `thread/fork` ACK does not issue a replacement remote mutation.

## R15 Turn 控制可靠性（working-tree）

- Retry/edit 使用 `thread/fork(beforeTurnId)`，普通分支使用 `lastTurnId`；fork Session 在权威 `turn/started` 前保持 starting，不显示 steering 控件。
- `turn/steer`、follow-up、interrupt 都要求精确 `sessionId + turnId`；steer 另带 `submissionId`，in-flight 重复提交只共享同一 Promise。
- follow-up 记录 `kind/submissionId/targetTurnId`，只在匹配目标 Turn 完成且 Main 确认 Thread idle 后 drain；同文本不同 submission 可显式排队多次。
- interrupt 将 App Server、Responses、Bridge 和该 Turn 的审批/交互作为独立取消通道；App Server 失败时结果为 uncertain，不能伪造已停止。
- Runtime 与 Renderer 的迟到 `turn/completed` 都必须匹配当前 active Turn；旧 Turn 事件只能落入旧投影，不能清除新 Turn 的 activeTurnId。
- R15 hermetic 证据：`npm run test:codex-runtime-turn-service` 覆盖 steer 并发幂等、相同文本双 follow-up、unknown 不 drain、跨 Turn 拒绝和 interrupt fan-out；`npm run test:agent-composer-state` 通过。
- 2026-08-04 live 部分收据：固定 Codex 0.146.0 + 未修改 ToolBox，以 `deepseek-v4-flash` 运行 `VCP_CODEX_LIVE=1 npm run test:codex-concurrent-live`，双 Session 长 Turn、A 中止/B 完成、cancel isolation 和 projection isolation 通过；steer/follow-up live 与完整 Electron Workbench 仍待。
- 当前整体 Workbench 回归仍受并行设置页工作树影响；没有同一 commit 的完整 Electron、steer/follow-up 和 backend approval 收据前，状态保持 `working-tree`，不升级为 live/product。

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

## R16 Codex 0.146 Adapter 与 Projection V2（implemented / working-tree）

- `thread/status/changed(idle)` 不再提前结束 active Turn；只有匹配的 `turn/completed` 最终收口。
- settings apply 保存 target revision/generation/规范字段，只有匹配 `thread/settings/updated` 才确认；发送 barrier 不再被无关通知解除。
- reconcile 校验 Thread ID 与 `itemsView`；partial history 不能删除，ToolBox/VChat authority 始终保留。
- reasoning 使用独立 `summary[]/content[]`，Unknown Item 有界脱敏，delta-before-Item 使用 Main-only 有界缓冲。
- Renderer 统一为 `sessionsById/blocksById/projectionRevisions`，Main 只发 revision Patch；A→B→A 与 revision-gap 均由同一 SQLite Projection 恢复。
- 0.146 fork 返回的 `thread.sessionId` 若存在必须等于新 Thread ID；版本升级必须重新验证，不能沿用该假设。

Hermetic 已通过 `test:codex-projection-v2` 与 `test:codex-adapter-invariants`。完整 governance 当前仍被既有
CSS/composition/repository 行数和 timer registration 基线阻止。Electron recovery 已通过 projection isolation、
reload 和 demand restart；完整 smoke 在设置 Select helper 超时，交互式 A→B→A 与 live ToolBox 仍未完成，
因此不得升级为 live/product。
