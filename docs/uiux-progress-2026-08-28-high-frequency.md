# 高频 Harness 组件接入进度（2026-08-28）

本账本记录本轮可独立审查的高频、非冻结 UI 接入。`production-consumer-active`
只表示真实 Surface 已使用 generated primitive，并不表示 Harness 像素等价或
Stable；后者仍需同引擎 DOM/CSS/交互/截图证据、reload/stress、平台证据及旧
presentation path 删除。

## 已交付切片

| Surface / 节点 | Generated primitive | 业务边界 | Owner / 清债 | 证据 | 状态 |
| --- | --- | --- | --- | --- | --- |
| Agent Settings 数值参数（`agentContextTokenLimit`、`agentMaxOutputTokens`、`agentTopP`、`agentTopK`） | Light-DOM `Input` | 原生 `type=number`、约束、settingsManager 解析、持久化与聊天参数组装不变 | `settings-bridge` presentation scope；旧参数材质、hover/focus/spinner 选择器排除 `.input`（`ce69669a`） | Agent lifecycle stress；source-equivalence；UIUX/artifact gates | `production-consumer-active / visual-equivalence-pending` |
| 侧栏“全局设置”入口 `#globalSettingsBtn` | `Button(outline/sm)` | 原有 `openModal('globalSettingsModal')` 点击命令不变 | Settings presentation scope 单 owner；旧 sidebar/shell action CSS 排除 `.vcp-harness-button`（`df893f32`） | 真实 Electron mount/click/close/teardown；bridge focused test | `production-consumer-active / visual-equivalence-pending` |
| 全局 Settings“添加网络路径” `#addNetworkPathBtn` | `Button(outline/sm)` | 动态路径行创建、typed list dirty/close-flush、IPC/persisted key 不变 | 同一 Settings presentation scope；旧 Settings action CSS 排除 generated Button（`6b2767c8`） | `test-settings-wa-electron.mjs` 断言 class/variant/size/28×14 geometry、添加/删除、close-flush、reload/teardown（`5c08aedb`） | `production-consumer-active / visual-equivalence-pending` |
| 公共 Button | `Button` primitive | 不拥有业务命令；原生 button/type/disabled 保留 | generated artifact 增加统一 `focus-visible` ring（`ed8d389d`） | 44 primitive tests；source/build/artifact gates | `candidate contract improved` |

## 有意保留的 bespoke / 冻结入口

以下节点本轮不套用通用 Button：窗口控制与 32px Dock/icon、侧栏创建/搜索
触发器、通知筛选 checkbox 与 destructive clear、模型刷新与带 hot/favorite
语义的 legacy model modal、话题摘要模型 picker，以及聊天 composer、消息、
思维链、代码块、工具结果和流式显示。它们要么拥有专属几何/状态机，要么位于
冻结业务边界；在同语义 contract 和完整 parity 证据出现前保持原实现。

## 当前验收状态

- `npm run test:uiux`：82 项通过。
- Settings/Notification/App Tray focused tests：18 项通过。
- `npm run check:uiux`、`npm run build:uiux`、`npm run check:uiux:artifacts`：通过。
- `node scripts/check-settings-source-equivalence.mjs`：通过。
- `node scripts/test-settings-wa-electron.mjs`：通过，包含路径按钮 generated
  Button 几何、动态路径 close-flush、reload/reopen 与 owner teardown。
- Agent Settings stress 在 1 warmup + 1 measured 配置通过；3 warmup 运行曾出现
 既有 TTS Voice Select 时序波动，需单独稳定化，不能归因于本轮 Button/Input
 接入。

完整 UI-system/theme 门禁和部分 Visual Forensics 仍受并行工作树中的未归属
改动或既有 Tooltip 断言影响；本账本不把这些未闭合证据升级为 Stable。
