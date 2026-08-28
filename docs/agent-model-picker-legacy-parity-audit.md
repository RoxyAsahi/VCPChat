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
挂载生成的 `AgentModelPicker`。它直接消费相同的缓存、热门、收藏 capability，只写回
`#agentModel`，并在当前 popup owner 内投影有序分区、收藏和显式刷新；它仍未取得 legacy
modal 的删除资格。

## parity 账本

| 能力 | legacy owner / 证据 | 当前 typed picker | 删除 legacy 前的验收条件 |
| --- | --- | --- | --- |
| Canonical model 写入 | `currentModelSelectCallback()`：`#agentModel` + `input/change` | 已有：`onSelect` 写同一 native input | 生产 Electron：选择、重开、reload 后值和 section summary 一致 |
| 缓存为空自动刷新 | `handleOpenModelSelect()` | 已有：`modelOptions()` 在空缓存时 await refresh 后重读 | 断言一次 refresh、abort/close 后晚到结果无写权 |
| 搜索 | `filterModels()` 过滤 DOM rows | 已有 VCP-enhanced PopupSelect 搜索；Harness parity 模式正确关闭搜索 | 真实 Surface 搜索、清空、Escape/reopen 的结果与焦点证据 |
| 热门模型 | 按 `getHotModels()` 顺序独立分区 | 已实现：以 API 原顺序投影“热门模型”，同一模型仍可在“全部模型”重复出现 | production Electron 用 capability 注入验证排序、重复政策和搜索时标题收起 |
| 收藏模型分区 | 按 `getFavoriteModels()` 顺序独立分区 | 已实现：以 API 原顺序投影“收藏模型”，搜索只收起标题、不改变匹配 rows | production Electron 用 capability 注入验证排序、重复政策和搜索时标题收起 |
| 收藏切换 | 行内星标 → `toggleFavoriteModel()` → 保留原 target 重开 | 已实现：相邻 action button 调 injected capability；成功后仅重投影当前 popup，失败为 owner-bound Toast | toggle 成功/失败/close-race 的 production Electron 证据；canonical input 不被误写 |
| 显式刷新 | 按钮 → refresh → 重新取模型/热门/收藏 + 开始/成功/空/失败通知 | 已实现：popup-local Refresh action；busy/generation/abort 归当前 owner，失败为 owner-bound Toast | refresh 成功、空、失败、close/reopen、generation cancellation 的 production Electron 证据 |
| 选择失败提示 | legacy 通知 | Harness-equivalent 路径已有 owner-bound Toast；production enhanced 路径保持现有 canonical 写入 | 保持“catalog load Retry”和“selection failure Toast”分流；不得增加 durable UI state |
| modal close / focus | legacy modal helper | picker 有 Escape / trigger focus restore / dispose | parity consumer 下 close、重开、surface refresh、3-cycle stress 全部通过 |

### 2026-08-28：injected directory capability 的真实 form 证据

`npm run test:electron-agent-model-picker-directory-parity` 在真实 Electron 的
`agentSettingsForm`、原生 `#agentModel` 和 generated `AgentModelPicker` 上运行。它先释放
该临时会话的 Settings presentation owner，再通过 primitive 的公开 injected capability contract
挂载唯一测试 owner；不会重写不可变的 `window.chatAPI` context bridge，也不更改 IPC、持久化、
legacy modal 或业务 input。

覆盖结果：热门/收藏/全部三组的顺序和重复投影；收藏 mutation 不写 `#agentModel`；refresh 的
`Refreshing…` busy、成功、空列表和 owner-bound failure Toast；打开期间恰好一次
`subscribeUpdated`、关闭时释放；refresh 的迟到成功在 close 和 explicit dispose 后均不重新创建
popup/row，也没有遗留 picker scope。此项是 **真实 production form + generated primitive 的
capability-contract Electron evidence**，不是 `settings-bridge → immutable chatAPI` 真实目录数据
的端到端 IPC 证据，也不构成 `modelSelectModal` 的删除授权。

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
更不是 Stable。热门/收藏分区、收藏 mutation 和显式刷新已经有 source/generated focused 与
capability-contract Electron 成功/失败/close-race evidence；仍缺真实
`settings-bridge → immutable chatAPI` 目录数据的端到端证据，且 `topicSummaryModel` 仍使用
legacy modal。因此当前继续双轨；任何删除 `modelSelectModal`
或其 `settingsManager` 行为的改动都应被视为 P0 边界违规。
