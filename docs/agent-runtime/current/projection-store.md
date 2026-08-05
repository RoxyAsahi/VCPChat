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
| `workspace_root` | 当前 desired workspace。可在 Session 设置中 CAS 更新；从下一 Turn 起由 Codex 0.146 应用，旧 workspace 引用按 revision 失效。 |
| `state` | created/idle/running/orphaned/archived 等展示状态。 |
| `config_snapshot_json` | model/provider/persona/instructions/permission/sandbox/头像等冻结配置。 |
| `orphaned` | Codex Thread 丢失标记。 |
| timestamps | created/updated/archived。 |

全局助手设置修改后，不静默改变旧 Session 快照。模型、reasoning、权限和 workspace 的当前 Session patch 写入 desired config，并在 Runtime 确认后写入 applied config；身份指令模式变化仍按协议限制要求显式派生 Session。

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

记录 schema/reconcile 状态、`next_source_order`、`mutation_generation`、最后成功对账时间、最后错误和
`activity_json`。schema v6 的 `activity_json` 只持久化 Session-scoped usage provenance/model/provider 与最近
compaction 状态/摘要；无 Thread identity 的 VCPLog/VCPInfo 和 pending Interaction 不进入该字段。
`thread/read` 发出前捕获 generation；若请求期间 live Item/Block 已事务写入 SQLite，对账提交会因
generation 不一致整体跳过，绝不覆盖新投影。下一次后台对账再获取新的权威 snapshot。

## 增量投影

```text
item/started
  -> upsert agent_message
  -> upsert initial block

item/*/delta
  -> locate by sessionId + itemId + ordinal
  -> append/update block in transaction
  -> emit revision-based AgentProjectionPatch

item/completed
  -> replace authoritative final item content/status
  -> emit final patch
```

重复 `item/started` 或 `item/completed` 必须幂等。delta 先于 Item 到达时进入 Main-only 有界缓冲；
Item 建立后按 identity 回放，超时则记录 projection error 并调度 `thread/read`，Renderer 不持有该缓冲。

## Projection V2 合同

- SQLite schema 为 12；schema 12 将旧 Block identity/content 惰性迁移为 canonical schema-2 Block，并在迁移前创建版本备份。Block content/Renderer API 同为 schema 2。
- `blockId = sessionId + itemId + ordinal`，fork Session 即使复用相同 Codex Item ID 也不共享 Block。
- reasoning 只有一个 Block，内容为 `{ summary: string[], content: string[] }`；两个索引空间互不覆盖。
- 已知 Item 进入专用、限长 normalizer。Unknown Item 只保存脱敏 fallback 和协议诊断，不保存 raw Item。
- Main 在 SQLite 事务提交后发 Patch；`projectionRevision` 使用 SQLite mutation generation，不能与 Runtime generation 混用。
- Renderer 仅在 base revision 精确匹配时应用 Patch。跳号、旧 Patch、Thread identity 冲突或外来 Block 均 fail-closed，并触发完整 SQLite reload。
- `sessionsById + blocksById + projectionRevisions` 是跨 Session 唯一投影真相。顶层 `messages/tools` 仅是当前选中 Session 的派生渲染兼容视图，不缓存其他 Session，也不接收 Main 的旧 message patch。
- 工具卡不属于页面级工具集合，而是所属 Turn 中具有稳定 `sourceOrder` 的 Block。Main 对账保留 live 锚点；启动期和首次权威 Projection 读取都会把可识别的旧顶部聚合顺序事务写回。Renderer 只按 Main 顺序渲染，不重新推断位置。

## 打开 Session

1. `read-projection(sessionId)` 只读 SQLite，立即返回。
2. Workbench 同一帧切换选中行，keyed render snapshot。
3. 后台 `read-topic/read-session(reconcile=true)` 调用 `thread/read`。
4. Main 按 `turnId/itemId` 对账。
5. 仅更新变化的 Message/Block，不重建 sidebar/header/composer。

产品 API 与 UI 均使用 canonical Session 命名。旧 Topic IPC/preload/Runtime adapter 已物理删除；数据权威仍由 VChat Session、Codex Thread 与 Projection revision 共同约束。

## Reconcile

对账必须满足：

- Codex 返回的 Item 新增或权威覆盖 Codex-owned projection。
- 重复 Item 不产生重复 Message。
- `thread/read(includeTurns: true)` 未返回的普通 Codex-owned Item 会被事务删除；若同一 Message 还包含
  VChat/ToolBox-owned Block，则保留 Message 和本地 Block，仅删除其中 Codex-owned Block。
- Codex App Server `0.146` 即使返回 `itemsView=full` 也会省略 live event 已产生的 reasoning Item，
  因此“快照缺失”对 reasoning 不具删除权威。SQLite 保留该 reasoning；只有快照显式返回同一 Item
  时，返回的字段才具有覆盖或清空权威。
- 删除规则还要求返回 Thread identity 匹配且所有 Turn 为 `itemsView=full`；partial history 一律 upsert-only。
- 显式空字符串、空数组和 `null` 可以清除旧 Codex 字段；协议未返回的可选字段保留 live event 内容。
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

已覆盖：schema 5 -> 7 migration、WAL、Session CRUD、Item/Block upsert、text/reasoning delta、Codex-owned
权威删除、本地 authority 保留、空值清除、稀疏字段保留、generation barrier、orphan、usage/compaction
Activity 持久化、integrity check、migration backup 和只读 degraded fallback。

仍未覆盖：完整磁盘故障矩阵、完整数据大小 gate、正式 redaction 和长期多版本升级测试。

`better-sqlite3` 固定按 Electron ABI 构建。依赖 SQLite 的命令通过 `scripts/run-electron-node.mjs` 在 `ELECTRON_RUN_AS_NODE=1` 下执行，不允许为了普通 Node 测试反复重编译原生模块并破坏产品 Electron。
