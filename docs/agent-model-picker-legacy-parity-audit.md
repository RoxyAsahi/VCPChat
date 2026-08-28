# Agent Model Picker：legacy modal parity 审计

状态：**迁移前审计完成；不得删除 `modelSelectModal`**

范围只限 Agent Settings 的模型选择 presentation。`#agentModel` 原生 input
仍是唯一 canonical 值；`input` / `change`、`saveAgentConfig`、IPC 与 persisted
key 均不在本审计的可变范围内。

## 旧路径的事实边界

旧路径由 `modules/settingsManager.js` 持有：

- `handleOpenModelSelect()` 同时读取缓存模型、热门模型和收藏模型；缓存为空时触发
  `chatAPI.refreshModels()` 并等待重新读取。
- `populateModelList()` 渲染“热门模型 / 收藏模型 / 全部模型”三个有序分区；一个模型
  可同时出现于多个分区。
- 每一行的星标会调用 `chatAPI.toggleFavoriteModel(model.id)`；成功后以相同的
  `currentModelSelectTarget` 重开并重建列表，避免错误写入另一种模型输入。
- `filterModels()` 是即时全文过滤；有搜索词时隐藏分区标题，回到空搜索时恢复分区。
- `handleRefreshModels()` 是用户显式刷新：提供开始、成功、空结果和失败通知，并重新取
  热门/收藏元数据。
- 选择模型写入当前目标 input，发出 `input` / `change`，关闭 modal，并刷新 Agent
  section summary。

新路径由 `modules/ui-system/settings-bridge.js#mountTypedAgentModelPicker()`
挂载生成的 `AgentModelPicker`。它已直接消费相同的缓存、热门、收藏 capability 并只
写回 `#agentModel`，但尚未接管所有 presentation 能力。

## parity 账本

| 能力 | legacy owner / 证据 | 当前 typed picker | 删除 legacy 前的验收条件 |
| --- | --- | --- | --- |
| Canonical model 写入 | `currentModelSelectCallback()`：`#agentModel` + `input/change` | 已有：`onSelect` 写同一 native input | 生产 Electron：选择、重开、reload 后值和 section summary 一致 |
| 缓存为空自动刷新 | `handleOpenModelSelect()` | 已有：`modelOptions()` 在空缓存时 await refresh 后重读 | 断言一次 refresh、abort/close 后晚到结果无写权 |
| 搜索 | `filterModels()` 过滤 DOM rows | 已有 VCP-enhanced PopupSelect 搜索；Harness parity 模式正确关闭搜索 | 真实 Surface 搜索、清空、Escape/reopen 的结果与焦点证据 |
| 热门模型 | 按 `getHotModels()` 顺序独立分区 | 仅 metadata（`热门` detail），**无独立有序分区** | capability 注入后能保留排序、重复展示政策和搜索时的分区收起语义 |
| 收藏模型分区 | 按 `getFavoriteModels()` 顺序独立分区 | 仅 `favorite` 标记，**无独立分区** | capability 注入后能保留排序、重复展示政策和搜索时的分区收起语义 |
| 收藏切换 | 行内星标 → `toggleFavoriteModel()` → 保留原 target 重开 | **缺失** | toggle 成功/失败/close-race；新菜单保持唯一 owner，canonical input 不被误写 |
| 显式刷新 | 按钮 → refresh → 重新取模型/热门/收藏 + 开始/成功/空/失败通知 | **缺失**（仅空缓存自动刷新） | refresh loading、成功、空、失败、close/reopen、generation cancellation 的 Electron 证据 |
| 选择失败提示 | legacy 通知 | Harness-equivalent 路径已有 owner-bound Toast；production enhanced 路径保持现有 canonical 写入 | 保持“catalog load Retry”和“selection failure Toast”分流；不得增加 durable UI state |
| modal close / focus | legacy modal helper | picker 有 Escape / trigger focus restore / dispose | parity consumer 下 close、重开、surface refresh、3-cycle stress 全部通过 |

## 迁移设计约束

1. 把热门、收藏、refresh、toggle 作为注入 capability 传给 picker；不要让 primitive
   import `chatAPI`，也不要让它调用隐藏 legacy modal。
2. 模型列表、热门/收藏元数据和 refresh 结果仅是短生命周期 snapshot；不得创建第二份
   durable model state。
3. 每个 await 均归属 picker child scope，并在 close、reopen、Settings surface replacement
   和 dispose 后失去 commit 权。
4. 收藏点击不是选择：必须阻止 option selection，且成功后只重投影当前 picker owner。
5. 新路径闭合后，先删除 `#openModelSelectBtn` 的 legacy click binding 与
   `modelSelectModal` 的 Agent Settings entry；`topicSummaryModel` 等其他 legacy callers
   未通过独立审计前不得一并删除 modal 模板或 settingsManager helpers。

## 当前结论

`AgentModelPicker` 是 `production-consumer-active`，但不是 legacy modal 的完整替代，
更不是 Stable。缺少热门/收藏分区、收藏 mutation 和显式刷新这三组能力，因此当前仅允许
继续使用双轨路径；任何删除 `modelSelectModal` 或其 `settingsManager` 行为的改动都应被
视为 P0 边界违规。

