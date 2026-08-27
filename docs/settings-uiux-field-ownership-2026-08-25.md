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
| `appearanceProfile.density` | `appearanceDensity` | 外观 | 界面密度 / 调整壳层控件间距 | select | `SettingsUiService.state` | `settings.save.execute({ appearanceProfile })` | dirty draft 保留；失败可重试 | legacy projection 已退役（bridge 仅保留防重复包装 guard） | TS Light-DOM Field + Select + service | 已满足；后续仅需保持 artifact/source contract | `typed-primitive-active`; DOM/geometry/interaction/screenshot + artifact Electron evidence |
| `appearanceProfile.radius` | `appearanceRadius` | 外观 | 圆角风格 / 调整页面容器圆角 | select | `SettingsUiService.state` | 同上 | 同上 | legacy projection 已退役（bridge 仅保留防重复包装 guard） | TS Light-DOM Field + Select + service | 已满足；保持 artifact/source contract | `typed-primitive-active`; DOM/geometry/interaction/screenshot Electron evidence |
| `appearanceProfile.typography` | `appearanceTypography` | 外观 | UI 字体 / 选择界面字体风格 | select | typed snapshot | `save.execute` | 保留输入；失败重试 | legacy projection 已退役（guard 保留） | TS Light-DOM Field + Select | 已满足 | `typed-primitive-active`; Electron gate |
| `appearanceProfile.fontScale` | `appearanceFontScale` | 外观 | UI 字号 / 调整壳层文字缩放 | select | typed snapshot | `save.execute` | 同上 | legacy projection 已退役（guard 保留） | TS Light-DOM Field + Select | 已满足 | `typed-primitive-active`; Electron gate |
| `appearanceProfile.contentWidth` | `appearanceContentWidth` | 工作区 | 内容宽度 / 调整工作区最大宽度 | select | typed snapshot | `save.execute` | 同上 | legacy projection 已退役（guard 保留） | TS Light-DOM Field + Select | 已满足 | `typed-primitive-active`; Electron gate |
| `appearanceProfile.surface` | `appearanceSurface` | 外观 | 页面材质 / 选择壳层表面效果 | select | typed snapshot | `save.execute` | 同上 | legacy projection 已退役（guard 保留） | TS Light-DOM Field + Select + ThemeTokenOwner | token legacy reads 仍需后续处理 | `typed-primitive-active`; Electron gate |
| `appearanceProfile.sidebarRowHeight` | `appearanceSidebarRowHeight` / `appearanceSidebarRowHeightValue` | 工作区 | 侧栏行高 / 调整导航行的高度 | range + output | typed snapshot normalized by appearance engine | `save.execute` | range draft 不被外部 snapshot 覆盖；失败重试 | no legacy presentation fallback; global manager retains persistence read | typed Settings field owner + TS Range | 已满足；继续保持 artifact/source contract | `typed-range-active`; Electron gate + 60-cycle stress |
| `appearanceProfile.sidebarAvatarSize` | `appearanceSidebarAvatarSize` / `appearanceSidebarAvatarSizeValue` | 工作区 | 侧栏头像大小 / 调整导航头像尺寸 | range + output | typed snapshot normalized | `save.execute` | 同上 | no legacy presentation fallback; global manager retains persistence read | typed Settings field owner + TS Range | 已满足；继续保持 artifact/source contract | `typed-range-active`; Electron gate + artifact smoke |
| `appearanceProfile.sidebarRadius` | `appearanceSidebarRadiusChoice-*` | 工作区 | 侧栏圆角 / 选择导航项圆角 | choice group | typed snapshot | `save.execute` | choice draft 保留；失败重试 | hidden `#appearanceSidebarRadius` compatibility select 及其镜像（typed owner 反向投影、Appearance Studio 双向回写、manager 兜底读）已于 2026-08-27 全部删除（R2-02E，commit 3b792fcd） | typed Settings field owner + TS Choice primitive | 已满足；Choice 单选组是唯一可见控件 | `stable`; Electron DOM/interaction gate passed |
| `appearanceProfile.customRadius` | `appearanceCustomRadius` / `appearanceCustomRadiusValue` | 外观 | 自定义圆角 / 设置自定义容器圆角 | range + output | typed snapshot | `save.execute` | 同上 | duplicate output projection retired; appearance normalization retained | TS Light-DOM Range + service | 已满足；继续保持 artifact/source contract | `typed-range-active`; Electron gate + artifact smoke |
| `chatFontPreset` | `chatFontPreset` | 外观 | 聊天字体 / 选择聊天文字字体 | select | typed snapshot | `save.execute` | 失败重试；不得改消息 renderer 语义；custom 行显隐由 typed project() 驱动 | mountTypedFieldOwner()（settings-bridge，2026-08-27 R2-02E 批次 11）；通用 projection 行退役 | Settings primitive | 已满足；business key 与字体应用语义保留 | `typed-owner-active`; Electron close-flush 证据（journey 6d） |
| `chatFontCustom` | `chatFontCustom` | 外观 | 自定义聊天字体 / 输入字体名称 | text | typed snapshot | `save.execute` | dirty 保留；错误显示在字段级 | 同上（批次 11） | Settings primitive | 已满足 | `typed-owner-active`; Electron close-flush 证据（journey 6d） |
| `chatCodeFontPreset` | `chatCodeFontPreset` | 外观 | 代码字体 / 选择代码字体 | select | typed snapshot | `save.execute` | 同上；不改代码块渲染结构 | 同上（批次 11） | Settings primitive | 已满足 | `typed-owner-active` |
| `chatCodeFontCustom` | `chatCodeFontCustom` | 外观 | 自定义代码字体 / 输入代码字体名称 | text | typed snapshot | `save.execute` | 同上 | 同上（批次 11） | Settings primitive | 已满足 | `typed-owner-active` |
| `chatDiaryFontPreset` | `chatDiaryFontPreset` | 外观 | 日志字体 / 选择日志字体 | select | typed snapshot | `save.execute` | 同上；不改 diary renderer | 同上（批次 11）；journey 6d 用其覆盖 select 型 preset 的关闭 flush | Settings primitive | 已满足 | `typed-owner-active`; Electron close-flush 证据（journey 6d） |
| `chatDiaryFontCustom` | `chatDiaryFontCustom` | 外观 | 自定义日志字体 / 输入字体名称 | text | typed snapshot | `save.execute` | 同上 | 同上（批次 11） | Settings primitive | 已满足 | `typed-owner-active` |
| `chatToolFontPreset` | `chatToolFontPreset` | 外观 | 工具字体 / 选择工具结果字体 | select | typed snapshot | `save.execute` | 同上；不改工具结果渲染 | 同上（批次 11） | Settings primitive | 已满足 | `typed-owner-active` |
| `chatToolFontCustom` | `chatToolFontCustom` | 外观 | 自定义工具字体 / 输入字体名称 | text | typed snapshot | `save.execute` | 同上；journey 6d 用其覆盖 text 型 custom 的关闭 flush | 同上（批次 11） | Settings primitive | 已满足 | `typed-owner-active`; Electron close-flush 证据（journey 6d） |
| `showHomeVisualBrand` | `showHomeVisualBrand` | 工作区 | 显示首页品牌 / 控制首页品牌图形 | checkbox | typed snapshot | `save.execute` | 失败重试 | legacy slider projection retired | TS Toggle + typed owner | 已满足；保持 artifact/source contract | `typed-toggle-active`; Electron + artifact |
| `userAvatarBorderColor` | `userAvatarBorderColor` / `userAvatarBorderColorText` | 用户身份 | 头像外框颜色 / 保持 color 与文本镜像一致 | color + text pair | typed snapshot | `save.execute({ userAvatarBorderColor })` | 非法文本回滚；失败重试 | legacy projection retired | TS ColorPair + typed owner | 已通过 ColorPair artifact/Settings DOM evidence | `typed-color-pair-active`; Electron + artifact |
| `userName` | `userName` | 用户身份 | 用户名 / 全局显示名称 | text | typed snapshot | `save.execute`（定义级 trimValue+fallback：trim 后空值回填「用户」，对齐 legacy 收集契约） | dirty 保留；失败重试 | 通用 projection 行退役（2026-08-27，R2-02E 批次 15）；manager 兜底读保留（Classic 兼容） | Settings string owner | 已满足；presentationOwner 启动兜底保持 `!typedSettingsProjectionActive` 惰性分支 | `typed-owner-active`; Electron trim/close-flush 证据（journey 6f） |
| `userNameTextColor` | `userNameTextColor` / `userNameTextColorText` | 用户身份 | 名称文字颜色 / color 与文本镜像写同一持久化键 | color + text pair | typed snapshot | `save.execute`（两定义共享单 path；空值回填 #ffffff） | 同 avatar 镜像对范式 | 通用 projection 两行退役（批次 15） | Settings string owner（双 id 共享单键） | 已满足；native 双控件保留为唯一业务源，暂不挂 ColorPair 原语 | `typed-owner-active`; Electron mirror close-flush 证据（journey 6f） |
| `continueWritingPrompt` | `continueWritingPrompt` | 用户身份 | 中键续写提示词 / 编辑默认续写文案 | textarea | typed snapshot | `save.execute`（定义级 trimValue+fallback：trim 后空值回填「请继续」） | dirty 保留；失败重试 | 通用 projection 行退役（批次 15）；迁移后 failure/retry journey 段 6 经 typed 链验证仍全绿 | Settings string owner | 已满足 | `typed-owner-active`; Electron fallback/close-flush 证据（journey 6f） |
| `showHomeVisualTagline` | `showHomeVisualTagline` | 工作区 | 显示首页标语 / 控制首页辅助文案 | checkbox | typed snapshot | `save.execute` | 同上 | legacy slider projection retired | TS Toggle + typed owner | 已满足；保持 artifact/source contract | `typed-toggle-active`; Electron + artifact |
| `homeVisualTagline` | `homeVisualTagline` | 工作区 | 首页标语 / 编辑首页辅助文案 | text | typed snapshot | `save.execute` | dirty 保留；失败重试 | legacy input wrapper retired | TS Input + typed owner | 已满足；保持 artifact/source contract | `typed-input-active`; Electron + artifact |
| `sidebarWidth` | `sidebarWidth`（若存在） | 工作区 | 侧栏宽度 / 调整导航区域宽度 | range/number | typed snapshot + existing settings manager | `save.execute`（需确认 capability） | close flush；超时失效 generation | legacy manager + presentation owner | Settings primitive | 明确 DOM contract 后删除旧 style write | `inventory-only`; command owner 待核验 |
| `sidebarActive` | sidebar toggle（无稳定 global id） | 工作区 | 显示侧栏 / 控制导航区域可见性 | toggle | typed snapshot + event owner | `save.execute`（需确认） | dirty/close flush | event-listeners.js | Settings primitive | 建立稳定 DOM id/name 后删除旧 listener | `inventory-only`; DOM seam 待核验 |
| `sidebarAvatarOnly` | sidebar mode control（无稳定 global id） | 工作区 | 仅显示头像 / 收窄导航显示 | choice/toggle | typed snapshot + event owner | `save.execute`（需确认） | 同上 | event-listeners.js | Settings primitive | 同上 | `inventory-only`; DOM seam 待核验 |
| `enableWideChatLayout` | `chatLayoutModeWide`, `chatLayoutModeNormal` | 工作区 | 宽屏布局 / 使用更宽的聊天工作区 | choice | typed snapshot | `save.execute` | dirty 不被覆盖；失败可重试 | 通用 projection 两行与 presentation 兜底已退役（2026-08-27，R2-02E 批次 7）；manager 持久化读保留（Classic 兼容） | Settings Choice primitive | 已满足；聊天消息内部布局冻结不变 | `typed-owner-active`; Electron dirty/close-flush/retry-attribution + 反向 submit 证据（journey 6c） |
| `networkNotesPaths` | `#networkNotesPathsContainer input[name="networkNotesPath"]`（动态行） | 高级功能 | 网络笔记路径 / 维护 NAS 共享路径列表 | dynamic text rows | typed snapshot | `save.execute`（列表整体为 patch） | 行删除/新增即时纳入草稿；空行按 legacy 语义过滤；dirty 不被覆盖 | 双轨序列化已退役：行投影从通用 consumer 迁入 typed project()，提交唯一经由 typed owner 容器级委托（2026-08-27，R2-02E 批次 13）；legacy manager 收集仅在 owner 未挂载时兜底（Classic 兼容） | Settings primitive + owner list 通道 | 目录浏览器接线的前置条件已就绪；候选 primitive 为线程 A directory-browser（待其达 Candidate active） | `typed-owner-active`; Electron close-flush 证据（journey 6e） |

## 3. 暂不进入 R2-02C 的兼容字段

以下字段已接入 typed snapshot 或 adapter，但其业务 capability、动态 options、legacy orchestration 尚未形成可删除的单一 owner。本轮只保留兼容路径并记录，不把它们宣布完成：

`vcpServerUrl`、`vcpApiKey`、`fileKey`、`vcpLogUrl`、`vcpLogKey`、`assistantAgent`、`voiceMode`、`speechRecognizerBrowserPath`、`speechRecognizerPagePath`、`voiceLocalSettings.*`、`voiceNetworkSettings.*`、`enableDistributedServer`、`agentMusicControl`、`enableVcpToolInjection`、`enableThoughtChainInjection`、`enableContextSanitizer`、`contextSanitizerDepth`、`enableAiMessageButtons`、`flowlockContinueDelay`、`enableMiddleClickQuickAction`、`middleClickQuickAction`、`enableMiddleClickAdvanced`、`middleClickAdvancedDelay`、`enableRegenerateConfirmation`、`chatPresentationMode`、`enableUserChatBubbleUi`、`showUserMetaInChatBubbleUi`、`chatBubbleMaxWidthWideDefault`、`chatBubbleMaxWidthWideNotifications`、`chatBubbleMaxWidthWideNarrow`、`minChunkBufferSize`、`smoothStreamIntervalMs`、`enableSmoothStreaming`、`topicSummaryModel`。

这些字段的 target owner 仍是 `SettingsUiService` + 对应 capability adapter；删除条件是：真实控件通过 typed command 保存、动态 options 有明确 producer、failure/retry/reload/teardown 有 Electron 证据，并且 `settings-bridge.js` 中对应 projection 分支被实际删除。聊天相关字段即使迁移，也不得修改聊天内容 renderer、消息密度、流式策略或持久化。

## 4. R2-02C 验收矩阵

| 条件 | 证据 | 当前 |
| --- | --- | --- |
| 单一 projection owner | `check-settings-source-equivalence.mjs` + DOM inspection | 部分通过（批次 15 收敛）：通用 consumer 仅剩 §3 冻结 40 行 / 38 键；非冻结写入面（userName 簇）已全部迁入 typed owner；惰性 `userUseThemeColorsInChat` 行经查证无 DOM 接缝后随批退役 |
| 单一 save command owner | `tests/global-settings-save.test.mjs` | typed save active；legacy autosave 经批次 15 收敛后仅驱动 §3 冻结字段（论坛凭据、networkNotesPaths、外观/工作区/字体/宽屏与用户名簇均已走 service.save.execute） |
| dirty draft 不被 snapshot 覆盖 | Settings Electron dirty/reopen journey | 已有 focused evidence |
| failure/retry 保留输入 | Settings WA/Electron failure journey | 已通过 |
| timeout late result 无复活 | `tests/uiux-settings-adapter.test.mjs` | 已通过 |
| close flush 或明确失败 | Electron close path | 已按批次闭合（journey 6b/6c：typed 字段 + 论坛凭据 + 宽屏布局，绕过防抖提交） |
| reload durable restore | Settings Electron reload | 已通过 |
| teardown quiescence | 60-cycle + explicit teardown | 已通过 Settings-only |
| legacy projection 删除 | source-equivalence + diff | 外观/工作区批次、enableWideChatLayout、networkNotesPaths 与 userName 簇已删除；余量 = §3 冻结 40 行（责任保留） |
| 混合 listener 增长归因 | lifecycle stress 分层对照 | 已闭合（2026-08-27，R2-02E 批次 8）：Settings-only stress 3 warmup + 20 cycles，listener 643 / lifecycle 资源 366 五 checkpoint 恒定、detached=0，树含批次 6/7 变更 |

## 5. 下一步

已完成上述外观/工作区批次；后续不再扩大聊天字体或消息布局相关字段。下一候选为 Forum 配置的 `adminUsername` / `adminPassword`：它们已有稳定 DOM id、`ForumConfigUiService` snapshot/command capability 和现有 Electron save/failure 证据，且不触碰聊天 renderer。进入施工前必须先补齐独立的 Light-DOM Input reference 对照、字段级 dirty/autosave owner、snapshot clean projection、失败/重试/timeout/close-flush、reload/teardown 及 generated-artifact smoke；只有这些证据齐全后，才能删除 `settings-bridge.js` 中对应的双轨 projection。若 command owner 或 dirty seam 无法在 Forum service 内闭合，则保持 `inventory-only`，不得以包装旧表单制造进度。

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

Legacy projection retirement（2026-08-26）：`mainChatSettingsPresentationOwner.js` 已删除 Appearance/Home/Radius 首批字段的 safeSet/safeCheck 写入（19 行）。这些字段现在只有 typed Settings field owner 负责可见控件投影；其余未迁移字段和兼容 orchestration 保持不变。Settings Electron gate、source-equivalence、unified-surface 与 UIUX typecheck 通过。

Harness vertical slice（2026-08-26）：`appearanceDensity` 由 `modules/uiux/primitives/field.ts` 与 `select.ts` 以 Light DOM 接管。Select 保留 native `<select>` 作为唯一业务源，拥有 40px/8px/10px 菜单几何、ARIA menu/menuitem、Arrow/Home/End/Escape/outside-dismiss、focus restore 与 scope-owned teardown。Electron Settings gate 已验证 DOM、geometry、交互与截图路径；`node scripts/test-electron-uiux-theme.mjs` 已验证 generated artifact-only Electron primitive contract。该字段对应 legacy projection 已删除，bridge 仅保留防止重复包装的 guard。

Interaction evidence（2026-08-26）：`tests/uiux-primitives.test.mjs` 新增独立序列，覆盖 portal 打开、初始 focus、ArrowDown/End 键盘导航、选项提交与 native source 同步、outside-dismiss、Escape focus restore，以及 dispose 后 tabindex/aria-hidden/DOM 恢复；另有 snapshot sync isolation 测试证明投影不会触发业务 change，且 dispose 后不再响应；源码平面 `npm run test:uiux` 20/20 通过。外部 snapshot 投影通过非业务 `vcp-uiux-sync` 事件刷新 Select trigger，避免伪造 change/autosave。
Range ownership update（2026-08-26）：`appearanceSidebarAvatarSize`、`appearanceSidebarRowHeight`、`appearanceCustomRadius` 的 output projection 已从 `appearance-studio.js` 移除，统一由 TS Range primitive 负责；appearance engine 仅保留值规范化、联动约束与视觉语义应用，避免重复写 output。

## 7. R2-02E thread-B ledger update（2026-08-27）

第一批六字段验收完成：`sidebarRowHeight`、`sidebarAvatarSize`、`customRadius` 保持 `typed-range-active` 且无待删 legacy；`showHomeVisualBrand`、`showHomeVisualTagline` 保持 `typed-toggle-active` 且无待删 legacy；`sidebarRadius` 的删除条件已闭合并晋级 `stable`（见第 2 节该行更新，证据链与提交号记录于 uiux-production-surface-adoption-handoff.md 批次 1-4）。

Forum `adminUsername`/`adminPassword` 的 dirty/autosave seam 已收口：论坛输入不再驱动 legacy whole-form submit，保存唯一经由 ForumConfigUiService.save.execute；presentationOwner 的 loadForumConfig 镜像投影已删除。manager 兜底仅在 typed owner 未挂载时执行，属 Classic 兼容责任，保留。Electron journey 已含 seam 反向证据。

`sidebarWidth`、`sidebarActive`、`sidebarAvatarOnly` 评估结论（2026-08-27）：三者没有 Settings 表单 DOM seam——由 shell 拖拽手柄/切换按钮直接驱动并即时持久化（event-listeners.js `saveSidebarState`、uiManager.js resizer），不属于「Settings Surface 单一 owner」模型可收编的字段；维持 `inventory-only`，不得为迁移而新建表单控件或改写 shell 行为。

`enableWideChatLayout` 收口（2026-08-27，R2-02E 批次 7）：宽屏布局单选对加入 `mountTypedFieldOwner()` 的 TYPED_FIELD_DEFINITIONS（新增 `inverse-boolean` kind，radio 按 checked 而非 value 取值）；settings-bridge 通用 projection 的 `chatLayoutModeWide/Normal` 两行删除，typed project() 在 clean form 上接管该单选对的快照投影。Electron journey 新增 6c：切换单选即出现 typed dirty 与 owner 标记、全程不触发 legacy `requestSubmit`、关闭模态绕过防抖后布尔草稿由关闭 flush 提交、save-result 归属为 `typed-settings-field-owner`。manager 对该 key 的持久化读保留（Classic 兼容）。提交 `a6d5c208`。

八个字体字段收口（2026-08-27，R2-02E 批次 11；§2 表随行升级为 `typed-owner-active`）：`chatFontPreset`、`chatFontCustom`、`chatCodeFontPreset`、`chatCodeFontCustom`、`chatDiaryFontPreset`、`chatDiaryFontCustom`、`chatToolFontPreset`、`chatToolFontCustom` 全部加入 TYPED_FIELD_DEFINITIONS（kind: string），通用 projection 中对应的 8 行退役；typed project() 接管快照填充与 preset/custom 行显隐。批内发现并修复既有潜在缺陷：`mountHarnessSelects()` 在重复 refresh 时 disconnect 旧 MutationObserver 但因注册表条目残留而不重建，动态 option 替换（如 assistantAgent）从此无人监听——该缺陷被本批引入的双次 enhance 时序必现化；修复为断开时同步删除注册表条目、挂载尾部必然重挂新 observer。Electron journey 新增 6d：preset select + custom text 双字段关闭 flush 提交断言。

验收矩阵残余 legacy 写入面盘点（2026-08-27，R2-02E 批次 14）：线程 A 在 `af281a22` 之后新交付 4 个 directory-browser 提交（draft prefix filtering / draft navigation preview / two-leg landing / landing timing parity），各 checkpoint 状态仍为 `foundation-electron-active`（仍缺同语义 Harness DOM/computed-style/pixel diff 与合法 VCP production consumer），Candidate-active unlock 未满足，按指令转入矩阵盘点。settings-bridge 通用 consumer projection 残余 45 行（settings-bridge.js:159-203）经逐行对照归因为三类：(1) **§3 冻结责任保留**——第 165-203 行共 40 行 / 38 键（vcpServerUrl、vcpApiKey、fileKey、vcpLogUrl/Key、topicSummaryModel、assistantAgent、voiceMode 双 radio、speechRecognizer* 两键、voiceLocal/NetworkSettings 四键、enableDistributedServer、agentMusicControl、注入/清洗/消息按钮组、flowlockContinueDelay、middle-click 组四键、enableRegenerateConfirmation、chatPresentationMode 三 radio、气泡组五键、minChunkBufferSize、smoothStreamIntervalMs、enableSmoothStreaming）全部命中本档 §3 冻结清单，是协议允许的 legacy 链存量，不视为欠账；(2) **唯一非冻结待迁量**——「userName 簇」5 行 / 4 键（userName、userNameTextColor + userNameTextColorText 镜像对、userUseThemeColorsInChat、continueWritingPrompt）；(3) presentationOwner 对 userName 簇的全部 safeSet/safeCheck 写入均位于 `!typedSettingsProjectionActive` 兜底分支（mainChatSettingsPresentationOwner.js:605/609/618/637 一带），typed owner 挂载后惰性，运行时真实写入方只有通用 projection 与 legacy 整表 collect，不存在三重活跃写入。据此把矩阵行 62/63/70 的模糊状态改写为上述精确边界。userName 簇迁移条件登记如下（不在批次 14 施工）：`userNameTextColor` 可复用 `userAvatarBorderColor` 已验证的 color+text 镜像对范式；`continueWritingPrompt` 是 failure/retry journey（矩阵行 65）的证据承载字段，迁移前必须先产出 typed 路径的失败/重试等价证据并迁移该 journey 断言；`userName` 为 string 直迁、`userUseThemeColorsInChat` 为 boolean 直迁。代码面自批次 13 门禁全绿的 180fb5bc 起零变更，本批为 docs-only 审计。

userName 簇 typed owner 收口（2026-08-27，R2-02E 批次 15；§2 表随行升级 `typed-owner-active`）：unlock 复查仍未满足（`8247c82a` 之后线程 A 零新提交，DirectoryBrowser 全部 checkpoint 保持 `foundation-electron-active`），按预案转入批次 14 登记的迁移条件评估并完成施工。(1) **语义契约**：legacy 整表收集对 `userName` 为 `trim() || '用户'`、`continueWritingPrompt` 为 `trim() || '请继续'`、颜色键有空值回填，而原 string kind 是裸 `String(raw)`——为消除持久化契约分歧，`readTypedFieldPatch` 新增定义级 `trimValue` / `fallback` 归一化，保存命令线与 legacy 收集产物逐字节等价（含 failure/retry 段落实测）。(2) **镜像对**：`userNameTextColor`/`userNameTextColorText` 两定义共享单 path（复用 avatar pair 范式）；native 双控件保留为唯一业务源，暂不挂 ColorPair 原语——typed 世界 dirty 期间本就不做活体镜像同步，与原行为一致。(3) **journey 兼容性**：`continueWritingPrompt` 是 failure/retry journey 的打字字段，迁移后该段经 typed 链重跑仍全绿（失败归属由状态条监听 vcp-settings-save-result 记录、点击路由到 error 重试）。(4) **修正批次 14 初判**：`userUseThemeColorsInChat` 在 globalSettingsForm 内**不存在任何控件**——main.html 中可见的 `useThemeColorsInChat` 复选框属于 agentSettingsForm（per-agent 配置域），global 键仅在持久化 schema 与兜底读中存在；按 sidebar 三键同类裁定 `inventory-only`，不新增定义、不改 HTML，其惰性通用 projection 行已随批退役并在源码注释中记录查证结论。施工范围：3 键 / 5 定义加入 TYPED_FIELD_DEFINITIONS，typed project() 接管四条投影语句，通用 consumer 前 5 行退役，通用 consumer 从此仅剩 §3 冻结行。journey 新增 6f：未 trim 名称 → trim 后落盘、清空提示词 → 「请继续」回填、文本镜像写入 #123abc 共享单键提交、save-result 归属 typed-settings-field-owner；全轮 19 PASS；八项门禁通过（check:uiux、test:uiux 44/44、artifacts 两项、Electron journey、lifecycle stress listener/lifecycle 五 checkpoint 恒定 detached=0、guard:classic-retirement、source-equivalence legacyClean=true）。

`networkNotesPaths` 动态列表单一 owner 收口（2026-08-27，R2-02E 批次 13；§2 新增该行）：动态路径行无法表达为「一控件一 id」的 TYPED_FIELD_DEFINITIONS 条目，采用等价的容器级 owner 通道——`#networkNotesPathsContainer` 成为 owned unit，input/change 委托覆盖事后添加的行（helper 在 owner 已挂载时为新行预置抑制标记），每次事件重收集整列表进入 pendingPatch 并经 `save.execute` 提交；静默删除行（remove 按钮）现在会主动宣告并触发草稿重收集（旧行为下删除不产生任何 dirty）。行投影从通用 consumer 迁入 typed project()，presentationOwner 的 `!typedSettingsProjectionActive` 兜底保留；legacy manager 的 DOM 收集仅在 typed owner 未挂载面上继续生效（Classic 兼容，当前 Settings 面不再消费它作为提交路径）。journey 6e 覆盖编辑、新增、删除三类交互 + 绕过防抖的关闭 flush 整列表提交 + save-result 归属 typed-settings-field-owner。方法论记录：批次内 toggle 快照探针曾出现跨实例投影竞态假象，影子还原对照实验证明其由 journey 中增删行断言触发的 debounced save 与探针交叠造成，以结算等待收敛（见 handoff §11 批次 13）。
