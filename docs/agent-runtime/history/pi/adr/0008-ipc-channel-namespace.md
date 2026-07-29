# ADR-0008: IPC 通道 `agent-runtime:` 命名空间

- Status: Accepted
- Date: 2026-07-25

## Context

VCPChat 的 IPC 通道统一登记在 [modules/ipc/ipcContracts.js](../../../modules/ipc/ipcContracts.js)（channel/type/owner/request/response schema），既有通道采用 `<domain>:<action>` 命名（如 `flowlock:request`、`desktop-remote:request`）。Agent Runtime 将新增 session/turn/approval/event 等约十个通道，需要与既有通道隔离、可审计、可整体下线。

## Decision

Agent Runtime 全部新通道使用 `agent-runtime:` 前缀命名空间：

- 命令/查询：`agent-runtime:create-session|list-sessions|start-turn|cancel-turn|respond-approval|get-status|start|stop`（已实现）；`close-session`、`get-events`、`driver:probe` 为后续候选。
- 流：`agent-runtime:event`（Main→Renderer 推送统一信封，ADR-0002）、`agent-runtime:get-status`（已实现）。
- 每个通道必须注册进 `ipcContracts.js`（type/owner/request/response schema，AR-COMPAT-005），由静态 lint 强制（ART-024）。
- preload 只暴露按通道逐一命名的窄封装，禁止通用 invoke 转发（AR-SEC-009）。
- 事件类型复用同一前缀（`agent-runtime:session.created` 等），使"通道"与"事件"在命名上同源、在 schema 上分别登记。

## Alternatives

1. **复用既有域（如挂到 `assistant:` 或聊天通道）**：Assistant 模块的语义是既有聊天助手，与 agent session 生命周期不同；混用会破坏 channelRegistry 的 owner 约束——拒绝。
2. **无前缀短名**：与全局通道撞名风险，且无法 lint 隔离——拒绝。
3. **每进程一套命名**：renderer/main/worker 术语漂移——拒绝；worker 内部 stdio 消息不走 IPC 通道，但 kind 命名沿用同域词表。

## Consequences

- 正面：通道清单即攻击面清单（审计 grep `agent-runtime:` 即可）；功能下线=注册表+preload 两处移除；命名纪律与既有约定一致。
- 负面：通道名偏长（可接受）；新增通道有两处登记（ipcContracts + 文档），由 lint 与 checklist 防漂移。

## Compatibility impact

纯新增，不改既有通道。命名遵循 ipcContracts.js 既有 `<domain>:<action>` 约定。

## Security impact

命名空间是 TB1 的执法边界：preload 暴露面、CSP 审计、channelRegistry 权限审查都以该前缀为最小单元；未注册通道在 Main 侧默认拒绝。

## Migration-rollback

回滚=注释注册表条目 + preload 不暴露，通道即死。无持久数据耦合。

## Related requirements and tests

AR-SEC-009, AR-COMPAT-005, AR-FR-007；ART-009, ART-024。
