# Codex Agent 架构

## 设计目标

VChat 将 Codex App Server 当作未经修改的黑盒 Agent Runtime。VChat 负责产品 UI、展示数据、VCPToolBox 适配和安全路由，但不复制 Codex 的 Agent loop、上下文管理、rollout、Shell、MCP 或 sandbox。

```text
Renderer: Agent Workbench
  | narrow query/command/event IPC
  v
Electron Main
  +-- CodexRuntimeManager
  |    +-- CodexAppServerTransport ------> codex app-server
  |    +-- ToolboxResponsesAdapter ------> loopback Responses endpoint
  |    |                                      -> ToolBox /v1/chat/completions
  |    +-- ProjectionService ------------> codex-agent-projection.sqlite
  |    +-- ServerRequestRouter
  |
  +-- ToolboxBridgeTransport ------------> vcp-toolbox-bridge.exe
                                             |
                                             +--> VCPToolBox
```

## 三个数据权威

| 数据 | 唯一权威 | VChat 是否持久化 | 规则 |
|---|---|---|---|
| Agent 上下文、Turn、执行、resume | Codex Thread Store | 只保存引用 | SQLite 不得单独恢复或伪造 Codex 上下文。 |
| UI Session/Message/Block 展示 | Agent Projection SQLite | 完整持久化 | 可即时打开；必须可由 `thread/read` 对账或重建。 |
| VCP 工具、插件 catalog、后端审批 | VCPToolBox | 保存最小关联和展示结果 | Bridge 不复制 catalog、不改工具名、不修改审批配置。 |

## Session、Thread、Turn、Item

```text
VChat Session (sessionId)
  1:1 -> Codex Thread (threadId)
           1:N -> Turn (turnId)
                    1:N -> Item (itemId)
                             0:1 -> dynamic tool call (callId)
```

- `sessionId` 是 VChat 数据库和 UI 的稳定主键。
- `threadId` 由 Codex 返回，不能由 VChat 生成或替换。
- `turnId`、`itemId`、`callId` 原样保存和路由。
- 选中 Session 不是 resume；只有创建 Turn、fork 或显式读取时才调用 Runtime。
- 一个 App Server 同时管理多个 Thread。不同 Thread 可以并行 Turn；同一 Thread 的并发限制由 Codex 决定。

## 进程生命周期

### Electron 启动

1. Main 注册窄 Session IPC，但不启动 App Server；旧 Rust Topic 不存在导入或自动迁移入口。
2. 首次 projection-only 请求时打开 Projection SQLite；列表和历史不启动 App Server。
3. 首次 runtime-required 操作（通常是发送）才解析 Codex executable 并启动 App Server。
4. 完成 `initialize -> initialized`，验证能力；首次发送随后 resume 目标 Thread。
5. ToolBox 配置由 settings 事件在后台 latest-wins 更新；工具执行只等待目标配置 generation。
6. ToolBox 设置和 bridge binary 均存在时启动 bridge；否则明确标记 VCP tool unavailable。

### Workbench 打开 Session

1. Renderer 请求 projection-only snapshot。
2. Main 立即读 SQLite 并返回。
3. Renderer keyed render，不等待 Codex。
4. 仅在 App Server 已运行时，Main 后台 `thread/read` 对账；否则等首次 runtime-required 操作再对账。
5. live item notifications 事务写入 SQLite，再发送最小 projection patch。

### 退出与崩溃

- App Server crash：拒绝所有 request waiter，标记 runtime crashed，不自动重放 Turn。
- 下一次 runtime-required 操作按需重启；SQLite 列表、历史和导出始终不依赖重启成功。
- Bridge crash：拒绝所有 dynamic call waiter，未决 VCP 审批 fail-closed。
- Workbench 关闭：原生 Codex UI 审批和本地 VCP 审批 fail-closed；后台无审批 Thread 是否继续由明确策略决定。
- Electron 退出：先关闭审批和 bridge，再停止 App Server 和 SQLite writer。

## Main、Renderer、Bridge 的责任

### Electron Main

- App Server/bridge 进程生命周期。
- JSONL request ID waiter 和 server request response。
- SQLite 唯一 writer、migration 和 reconcile。
- Thread/Turn/Item/call identity 路由。
- 凭据注入和日志脱敏。

Main 不维护第二份 transcript 数组，不根据当前选中 Session 推断事件归属，也不把 SQLite projection 回送给模型。

### Renderer

- 当前选中 Session 的 Message/Block projection。
- 草稿、展开状态、滚动位置、弹窗等页面临时状态。
- 用户动作转成窄 IPC 命令。

Renderer 不访问 SQLite 文件、Codex stdin、ToolBox API Key、VCPLog socket，也不在 localStorage 保存 transcript/approval/tool state。

### Toolbox Bridge

- `/v1/human/tool`、`/v1/interrupt`。
- VCPLog/VCPInfo 协议、重连、限长、去重。
- ToolBox backend approval 请求和响应。
- VCP 结构化资源、warning、异步 task 归一化。

Bridge 不包含 Agent loop、Topic Store、本地 Shell、MCP、第二套插件系统或工具名重写。

## 安全边界

- `codex-native` profile 的原生 Shell/file 使用 Codex sandbox 与原生审批；Nova/ToolBox Session
  默认使用 `toolbox-only`，不把这些 definitions 暴露给模型。
- `vcp_invoke` 是 Nova 模型唯一可见的 dynamic tool。App Server Thread 参数用于
  defense-in-depth，VChat loopback adapter 的精确 allowlist 是最终模型工具面边界。
- Codex native approval id、Codex callId、VChat local approval id、ToolBox approval id 四者独立。
- ToolBox API Key 只进入 Main 的 loopback adapter 与 bridge 子进程环境；Codex 只拿到一次性 loopback capability，不进入 Renderer、SQLite、日志或事件 payload。
- 未知 server request、过期 approval、跨 Thread identity、重复 response 一律 fail-closed。
- 旧 Rust daemon 不作为 fallback；Codex 不可用时显示明确错误。

## Uncertain 操作恢复

- `thread/start` / `thread/fork` 在远端可能成功但本地绑定未提交时进入 `uncertain`。
- 恢复页通过固定 `0.146` `thread/list` schema 列出尚未绑定的 Thread。
- 用户必须明确选择“绑定”或“删除”；VChat 不按标题、时间或当前 Session 自动猜测。
- 绑定与删除都写回原 Saga，禁止自动重放 start/fork。

身份覆盖、旧 Session 迁移和工具过滤的完整规则见
[identity-and-tool-surface.md](identity-and-tool-surface.md)。

## 不在本轮范围

- 修改普通聊天存储或 `start.bat`/VBS。
- 自动迁移旧 Rust Topic。
- fork/vendor Codex。
- 在 VChat 重做 Codex Shell、MCP、rollout、sandbox。
- 将 bridge 注册为 VCP DistributedServer capability node。
