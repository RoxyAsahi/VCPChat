# Settings UIUX 字段 Ownership Report

> 批次：R2-02C Settings single-owner migration  
> 日期：2026-08-25  
> 状态：inventory baseline；字段尚未全部 single-owner complete  
> 范围：仅用户可见 Settings presentation。persisted key、IPC capability 与业务语义保持不变。

## 1. 约定

`read source` 表示 snapshot 的权威来源；`write command` 表示唯一目标写入入口。`legacy path` 是迁移期仍可执行的 presentation 或 orchestration，不代表第二份 durable state。字段只有在真实控件由 typed service 投影、保存由同一 command owner 发出，且对应 legacy projection 删除后，才能把 `status` 改为 `single-owner-active`。

通用 owner：

- 当前 typed owner：`SettingsUiService`，由 `settings-presentation` / `ui-services` Surface-local scopes 装配；
- 当前 legacy owner：`modules/ui-system/settings-bridge.js` 与 `modules/renderer/mainChatSettingsPresentationOwner.js` 的兼容 projection、dirty/autosave 编排；
- 目标 primitive owner：R2-02C 的 Harness-compatible Light-DOM Settings consumer；不持有 durable state，不直接访问 IPC。

## 2. 优先迁移批次（外观 / 工作区）

| persisted key | legacy DOM id/name | 分类 | 用户标题 / 描述 | 控件 | read source | write command | dirty / error | legacy owner | 目标 owner | 删除条件 | 状态 / 证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `appearanceProfile.density` | `appearanceDensity` | 外观 | 界面密度 / 调整壳层控件间距 | select | `SettingsUiService.state` | `settings.save.execute({ appearanceProfile })` | dirty draft 保留；失败可重试 | settings-bridge projection | Settings primitive + service | 删除对应 projection 与重复 change listener | `typed-projection-active`; WA + Electron Settings |
| `appearanceProfile.radius` | `appearanceRadius` | 外观 | 圆角风格 / 调整页面容器圆角 | select | `SettingsUiService.state` | 同上 | 同上 | settings-bridge projection | 同上 | 同上 | `typed-projection-active`; source equivalence |
| `appearanceProfile.typography` | `appearanceTypography` | 外观 | UI 字体 / 选择界面字体风格 | select | typed snapshot | `save.execute` | 保留输入；失败重试 | settings-bridge + appearance owner | Settings primitive | 删除 legacy projection 分支 | `typed-projection-active`; appearance studio |
| `appearanceProfile.fontScale` | `appearanceFontScale` | 外观 | UI 字号 / 调整壳层文字缩放 | select | typed snapshot | `save.execute` | 同上 | settings-bridge projection | Settings primitive | 同上 | `typed-projection-active` |
| `appearanceProfile.contentWidth` | `appearanceContentWidth` | 工作区 | 内容宽度 / 调整工作区最大宽度 | select | typed snapshot | `save.execute` | 同上 | settings-bridge + presentation owner | Settings primitive | 同上 | `typed-projection-active` |
| `appearanceProfile.surface` | `appearanceSurface` | 外观 | 页面材质 / 选择壳层表面效果 | select | typed snapshot | `save.execute` | 同上 | settings-bridge projection | Settings primitive + ThemeTokenOwner | 删除旧 surface projection 后验收 token | `typed-projection-active`; theme legacy reads remain |
| `appearanceProfile.sidebarRowHeight` | `appearanceSidebarRowHeight` / `appearanceSidebarRowHeightValue` | 工作区 | 侧栏行高 / 调整导航行的高度 | range + output | typed snapshot normalized by appearance engine | `save.execute` | range draft 不被外部 snapshot 覆盖；失败重试 | legacy startup fallback retained; generic typed projection removed | typed Settings field owner | 删除 `mainChatSettingsPresentationOwner` fallback after reload/Classic equivalence evidence | `typed-field-owner-active`; Electron gate + 60-cycle pending |
| `appearanceProfile.sidebarAvatarSize` | `appearanceSidebarAvatarSize` / `appearanceSidebarAvatarSizeValue` | 工作区 | 侧栏头像大小 / 调整导航头像尺寸 | range + output | typed snapshot normalized | `save.execute` | 同上 | legacy startup fallback retained; generic typed projection removed | typed Settings field owner | 同上 | `typed-field-owner-active`; Electron gate passed |
| `appearanceProfile.sidebarRadius` | `appearanceSidebarRadius`, `appearanceSidebarRadiusChoice-*` | 工作区 | 侧栏圆角 / 选择导航项圆角 | choice group | typed snapshot | `save.execute` | choice draft 保留；失败重试 | legacy startup fallback retained; generic typed projection removed | typed Settings field owner | 删除 fallback 与 hidden compatibility projection after equivalence evidence | `typed-field-owner-active`; Electron gate passed |
| `appearanceProfile.customRadius` | `appearanceCustomRadius` / `appearanceCustomRadiusValue` | 外观 | 自定义圆角 / 设置自定义容器圆角 | range + output | typed snapshot | `save.execute` | 同上 | settings-bridge projection | Settings primitive | 删除旧 range listener | `typed-projection-active` |
| `chatFontPreset` | `chatFontPreset` | 外观 | 聊天字体 / 选择聊天文字字体 | select | typed snapshot | `save.execute` | 失败重试；不得改消息 renderer 语义 | settings-bridge + presentation owner | Settings primitive | 删除 legacy projection，保留 business key | `typed-projection-active` |
| `chatFontCustom` | `chatFontCustom` | 外观 | 自定义聊天字体 / 输入字体名称 | text | typed snapshot | `save.execute` | dirty 保留；错误显示在字段级 | settings-bridge projection | Settings primitive | 同上 | `typed-projection-active` |
| `chatCodeFontPreset` | `chatCodeFontPreset` | 外观 | 代码字体 / 选择代码字体 | select | typed snapshot | `save.execute` | 同上；不改代码块渲染结构 | settings-bridge projection | Settings primitive | 同上 | `typed-projection-active` |
| `chatCodeFontCustom` | `chatCodeFontCustom` | 外观 | 自定义代码字体 / 输入代码字体名称 | text | typed snapshot | `save.execute` | 同上 | settings-bridge projection | Settings primitive | 同上 | `typed-projection-active` |
| `chatDiaryFontPreset` | `chatDiaryFontPreset` | 外观 | 日志字体 / 选择日志字体 | select | typed snapshot | `save.execute` | 同上；不改 diary renderer | settings-bridge projection | Settings primitive | 同上 | `typed-projection-active` |
| `chatDiaryFontCustom` | `chatDiaryFontCustom` | 外观 | 自定义日志字体 / 输入字体名称 | text | typed snapshot | `save.execute` | 同上 | settings-bridge projection | Settings primitive | 同上 | `typed-projection-active` |
| `chatToolFontPreset` | `chatToolFontPreset` | 外观 | 工具字体 / 选择工具结果字体 | select | typed snapshot | `save.execute` | 同上；不改工具结果渲染 | settings-bridge projection | Settings primitive | 同上 | `typed-projection-active` |
| `chatToolFontCustom` | `chatToolFontCustom` | 外观 | 自定义工具字体 / 输入字体名称 | text | typed snapshot | `save.execute` | 同上 | settings-bridge projection | Settings primitive | 同上 | `typed-projection-active` |
| `showHomeVisualBrand` | `showHomeVisualBrand` | 工作区 | 显示首页品牌 / 控制首页品牌图形 | checkbox | typed snapshot | `save.execute` | 失败重试 | settings-bridge + presentation owner | Settings primitive | 删除旧 `safeCheck` projection | `typed-projection-active`; Electron |
| `showHomeVisualTagline` | `showHomeVisualTagline` | 工作区 | 显示首页标语 / 控制首页辅助文案 | checkbox | typed snapshot | `save.execute` | 同上 | legacy startup fallback retained; generic typed projection removed | typed Settings field owner | 删除 `mainChatSettingsPresentationOwner` fallback after reload/Classic equivalence evidence | `typed-field-owner-active`; Electron gate passed |
| `homeVisualTagline` | `homeVisualTagline` | 工作区 | 首页标语 / 编辑首页辅助文案 | text | typed snapshot | `save.execute` | dirty 保留；失败重试 | settings-bridge projection | Settings primitive | 删除旧 input projection | `typed-projection-active` |
| `sidebarWidth` | `sidebarWidth`（若存在） | 工作区 | 侧栏宽度 / 调整导航区域宽度 | range/number | typed snapshot + existing settings manager | `save.execute`（需确认 capability） | close flush；超时失效 generation | legacy manager + presentation owner | Settings primitive | 明确 DOM contract 后删除旧 style write | `inventory-only`; command owner 待核验 |
| `sidebarActive` | sidebar toggle（无稳定 global id） | 工作区 | 显示侧栏 / 控制导航区域可见性 | toggle | typed snapshot + event owner | `save.execute`（需确认） | dirty/close flush | event-listeners.js | Settings primitive | 建立稳定 DOM id/name 后删除旧 listener | `inventory-only`; DOM seam 待核验 |
| `sidebarAvatarOnly` | sidebar mode control（无稳定 global id） | 工作区 | 仅显示头像 / 收窄导航显示 | choice/toggle | typed snapshot + event owner | `save.execute`（需确认） | 同上 | event-listeners.js | Settings primitive | 同上 | `inventory-only`; DOM seam 待核验 |
| `enableWideChatLayout` | `chatLayoutModeWide`, `chatLayoutModeNormal` | 工作区 | 宽屏布局 / 使用更宽的聊天工作区 | choice | typed snapshot | `save.execute` | dirty 不被覆盖；失败可重试 | settings-bridge + presentation owner | Settings Choice primitive | 删除重复 radio projection；聊天消息内部布局冻结 | `typed-projection-active`; Electron |

## 3. 暂不进入 R2-02C 的兼容字段

以下字段已接入 typed snapshot 或 adapter，但其业务 capability、动态 options、legacy orchestration 尚未形成可删除的单一 owner。本轮只保留兼容路径并记录，不把它们宣布完成：

`vcpServerUrl`、`vcpApiKey`、`fileKey`、`vcpLogUrl`、`vcpLogKey`、`assistantAgent`、`voiceMode`、`speechRecognizerBrowserPath`、`speechRecognizerPagePath`、`voiceLocalSettings.*`、`voiceNetworkSettings.*`、`enableDistributedServer`、`agentMusicControl`、`enableVcpToolInjection`、`enableThoughtChainInjection`、`enableContextSanitizer`、`contextSanitizerDepth`、`enableAiMessageButtons`、`flowlockContinueDelay`、`enableMiddleClickQuickAction`、`middleClickQuickAction`、`enableMiddleClickAdvanced`、`middleClickAdvancedDelay`、`enableRegenerateConfirmation`、`chatPresentationMode`、`enableUserChatBubbleUi`、`showUserMetaInChatBubbleUi`、`chatBubbleMaxWidthWideDefault`、`chatBubbleMaxWidthWideNotifications`、`chatBubbleMaxWidthWideNarrow`、`minChunkBufferSize`、`smoothStreamIntervalMs`、`enableSmoothStreaming`、`topicSummaryModel`。

这些字段的 target owner 仍是 `SettingsUiService` + 对应 capability adapter；删除条件是：真实控件通过 typed command 保存、动态 options 有明确 producer、failure/retry/reload/teardown 有 Electron 证据，并且 `settings-bridge.js` 中对应 projection 分支被实际删除。聊天相关字段即使迁移，也不得修改聊天内容 renderer、消息密度、流式策略或持久化。

## 4. R2-02C 验收矩阵

| 条件 | 证据 | 当前 |
| --- | --- | --- |
| 单一 projection owner | `check-settings-source-equivalence.mjs` + DOM inspection | 部分通过；legacy projection 仍存在 |
| 单一 save command owner | `tests/global-settings-save.test.mjs` | typed save active；legacy autosave 仍在 |
| dirty draft 不被 snapshot 覆盖 | Settings Electron dirty/reopen journey | 已有 focused evidence |
| failure/retry 保留输入 | Settings WA/Electron failure journey | 已通过 |
| timeout late result 无复活 | `tests/uiux-settings-adapter.test.mjs` | 已通过 |
| close flush 或明确失败 | Electron close path | 需按字段批次补证据 |
| reload durable restore | Settings Electron reload | 已通过 |
| teardown quiescence | 60-cycle + explicit teardown | 已通过 Settings-only |
| legacy projection 删除 | source-equivalence + diff | 待 R2-02C 代码切片 |
| 混合 listener 增长归因 | lifecycle stress 分层对照 | 未完成 |

## 5. 下一步

先从 `appearanceProfile.sidebarRowHeight`、`appearanceProfile.sidebarAvatarSize`、`appearanceProfile.sidebarRadius` 和 `showHomeVisualTagline` 组成一个可回滚批次：它们已有稳定 DOM、typed snapshot 和 Electron 证据，且不要求触碰聊天 renderer。批次必须在同一个 Settings owner 内实现真实控件更新与保存，随后删除 bridge 中仅服务这些字段的 projection/listener，并补齐 close flush 与 teardown 计数。

## 6. 2026-08-25 implementation update

首批字段已进入 `mountTypedFieldOwner()`：

- 输入与 choice 事件标记为 typed-owned，不再进入 legacy `form.requestSubmit()` autosave 链；
- draft 按字段合并，appearance profile 的多字段修改不会互相覆盖；
- snapshot 在 clean form 上投影，dirty/in-flight 时拒绝外部覆盖；
- save、failure/retry、close flush、late-result invalidation 和 owner teardown 走同一 service/owner；
- 通用 typed projection 已删除上述四个字段的重复写入。

Home visual 扩展（2026-08-26）：`showHomeVisualBrand`、`showHomeVisualTagline` 与 `homeVisualTagline` 也已加入同一 typed field owner；通用 projection 不再重复写入，业务 key 与首页视觉行为保持不变。该扩展仍保留 `mainChatSettingsPresentationOwner.js` 的未接管 fallback，待独立 reload/Classic 等价证据后删除。

Radius group 扩展（2026-08-26）：`appearanceProfile.customRadius` 与其 px output 已加入同一 typed field owner；sidebar radius choice 与 custom value 现在共享一个 `appearanceProfile` draft 合并路径，避免两个 legacy projection 分别覆盖圆角设置。

Appearance select group 扩展（2026-08-26）：`appearanceProfile.density`、`radius`、`typography`、`fontScale`、`contentWidth`、`surface` 已加入同一 typed owner，通用 projection 重复写入已删除。Appearance engine 仍是规范化与视觉应用边界；`mainChatSettingsPresentationOwner.js` 的兼容启动 fallback 暂不删除。

仍未 complete：`mainChatSettingsPresentationOwner.js` 中的启动兼容 fallback 尚未删除，需要单独的 reload/Classic/upstream 等价证据后再退役。

2026-08-26 lifecycle 修复：`mountHarnessDisclosures()` 的幂等判断已改为按 container 查找 state record；此前错误使用 `Set.has(container)` 导致每次 refresh 重复注册 header click/keydown。Settings-only listener attribution 从 `589 → 597 → 601` 修复为 `585 → 585 → 585`，managed lifecycle 资源、DOM 和 detached-node 指标保持稳定。该修复属于 shared Settings primitive lifecycle，不改变任何 persisted key、IPC 或业务行为。
