# Agent Projection SQLite

## 定位

`codex-agent-projection.sqlite` 是完整、持久的 UI 展示数据库，但不是 Agent 上下文数据库。删除该数据库会丢失 VChat 的即时展示和本地 Session 元数据，但 Codex Thread 仍是执行/上下文权威；只剩 SQLite 而没有 Codex Thread 时，只能只读显示，不能继续对话。

数据库位于 Electron user data/settings 同级目录。它独立于普通聊天数据和旧 `agent-runtime.sqlite`，不复活 Pi Runtime Repository。

## 写入模型

- Electron Main 的 Projection Service 是唯一 writer。
- Renderer 通过窄 IPC 读取 snapshot 和接收 patch。
- 使用 `better-sqlite3`、WAL、显式 migration、prepared statement 和 transaction。
- App Server notification 先事务写库，成功后才通知 Renderer。
- `localStorage` 只保存最后选中的 `sessionId`，不保存 transcript、Turn、tool、approval 或附件内容。

## Schema

### `agent_sessions`

| 字段 | 含义 |
|---|---|
| `session_id` | VChat 稳定主键。 |
| `codex_thread_id` | Codex 返回的 Thread id，可在尚未启动 Thread 时为空。 |
| `agent_id` | VChat 助手身份。 |
| `title` | VChat Session 标题。 |
| `workspace_root` | 冻结工作目录。 |
| `state` | created/idle/running/orphaned/archived 等展示状态。 |
| `config_snapshot_json` | model/provider/persona/instructions/permission/sandbox/头像等冻结配置。 |
| `orphaned` | Codex Thread 丢失标记。 |
| timestamps | created/updated/archived。 |

全局助手设置修改后，不静默改变旧 Session 快照。显式“用新设置创建分支”应通过 `thread/fork` 创建新 Session。

### `agent_messages`

一条 Codex Item 对应一条规范 Message 记录：

- `message_id`：VChat projection 主键；
- `session_id`、`codex_thread_id`、`codex_turn_id`、`codex_item_id`；
- `role`、`status`；
- `source_order`：SQLite 本地稳定展示顺序；
- timestamps。

`source_order` 不是 Codex sequence，不得用于伪造协议水位。`session_id + codex_item_id` 必须幂等。

### `agent_blocks`

Block 以 `message_id + ordinal` 排序。首轮种类：

- `message`：user/assistant text；
- `reasoning`：summary/detail；
- `tool`：command/file/MCP/dynamic tool/web search；
- `attachment`：图片、音频、文件和 URL；
- `approval`：只保存展示状态和外部 identity，不保存权限秘密；
- `observation`：plan、compaction、VCPInfo；
- `error`：可展示、已脱敏错误。

Block content 使用 JSON，必须有大小上限、资源 descriptor 和脱敏规则。大 Base64、原始 VCPLog payload、API Key 不得入库。

### `projection_state`

记录 schema/reconcile 状态、`next_source_order`、`mutation_generation`、最后成功对账时间和最后错误。`thread/read` 发出前捕获 generation；若请求期间 live Item/Block 已事务写入 SQLite，对账提交会因 generation 不一致整体跳过，绝不删除或覆盖新投影。下一次后台对账再获取新的权威 snapshot。

## 增量投影

```text
item/started
  -> upsert agent_message
  -> upsert initial block

item/*/delta
  -> locate by sessionId + itemId + ordinal
  -> append/update block in transaction
  -> emit projectionMessage patch

item/completed
  -> replace authoritative final item content/status
  -> emit final patch
```

重复 `item/started` 或 `item/completed` 必须幂等。delta 到达但 Item 不存在时不能猜测 identity；应记录 projection error，并由下一次 `thread/read` 修复。

## 打开 Session

1. `read-projection(sessionId)` 只读 SQLite，立即返回。
2. Workbench 同一帧切换选中行，keyed render snapshot。
3. 后台 `read-topic/read-session(reconcile=true)` 调用 `thread/read`。
4. Main 按 `turnId/itemId` 对账。
5. 仅更新变化的 Message/Block，不重建 sidebar/header/composer。

当前兼容 API 仍使用部分 Topic 命名；语义已经是 VChat Session。后续必须清理 IPC/UI 命名，但不得因此改变数据权威。

## Reconcile

对账必须满足：

- Codex 返回的 Item 新增或覆盖 projection。
- 重复 Item 不产生重复 Message。
- 本地存在、Codex 不存在的 Item 不能静默保留为可继续上下文；需要 generation 标记或完整重建。
- 对账期间收到 live delta 时，通过 barrier/generation 避免旧 snapshot 覆盖新 delta。
- 成功后清空 `last_error` 并记录时间。
- 失败后保留旧 projection，显示“未对账”，不清空历史。

## Orphan 与故障

- `thread/read` 明确 not found：标记 orphaned，只读保留历史。
- 网络/进程临时失败：标记 sync error，不立即 orphan。
- SQLite migration 失败：禁止 writer 启动，提供只读/备份诊断，不自动删库。
- 磁盘满或 transaction 失败：不向 Renderer 发“已完成” patch。
- 删除 Session：先归档；永久删除和 Codex Thread archive/delete 必须独立确认。

## 当前已覆盖与缺口

已覆盖：migration、WAL、Session CRUD、Item/Block upsert、text delta、基础 reconcile、orphan、临时数据库测试。

当前 `thread/read` reconcile 会在单个 SQLite 事务中 upsert 权威 Item，并删除 Codex Thread 已不存在的旧投影 Item，避免幽灵消息；v2 schema 的 generation gate 会在 live 更新竞态时跳过整次旧 snapshot。仍未覆盖：没有 source offset 的重复 delta、复杂乱序 delta、磁盘故障、数据大小 gate、正式 redaction、归档/删除策略和长期数据库升级测试。

`better-sqlite3` 固定按 Electron ABI 构建。依赖 SQLite 的命令通过 `scripts/run-electron-node.mjs` 在 `ELECTRON_RUN_AS_NODE=1` 下执行，不允许为了普通 Node 测试反复重编译原生模块并破坏产品 Electron。
