# VCPChat UI Runtime 2 动态开发路线

> **2026-08-27 Harness 生产接入门禁：** 真实 VCPChat Surface 可以开始试接，但只允许显式白名单。组件 manifest 的 `status` 仅表示 VCP API 稳定性；`harnessMaturity` 表示 Harness 等价证据，`productionEligible` 必须同时满足 `verified-candidate`、真实 VCP consumer、Electron journey、reload/stress 和对应 legacy presentation 删除。旧组件继续保留用于兼容和回归，但组件页按 Harness Verified / Candidate Lab / Legacy Compatibility 解释；当前不把任何控件宣称为全局 Harness Stable。首个真实迁移应从已有、非冻结的 Settings typed consumer 切片开始，LanguageRow 因缺少 locale capability 暂不得接入。
> **2026-08-27 Home tagline slice audit：** `homeVisualTagline` 确认为首个真实 Harness Input 接入候选：既有 persisted key、SettingsUiService typed owner、debounced save/close-flush/retry/reload/teardown 与 Electron 挂载证据均存在，且 legacy generic Input wrapper 已跳过该字段。Harness/VCP Field description/error browser geometry 与 pixel 链本轮复验通过，但这不是 tagline Input 的完整等价证明；`inputFullVisualMatrix` 仍保持 blocked。下一步只补固定 viewport 的 tagline Input default/placeholder/focus/disabled DOM、computed-style、geometry、pixel、generated-artifact Electron smoke，再考虑 `verified-candidate`，不扩大字段迁移。
> **2026-08-27 portable inventory expansion：** 依据 Harness `packages/client` 真源补登记 `DiffBlock`、`JsonTree`、`ProducedFiles`、`PlanChip`。它们目前均为 `inventoried`，没有新增 VCP runtime 或生产 consumer；其中 DiffBlock/JsonTree/ProducedFiles/PlanChip 涉及冻结的 structured message、tool-result、turn-tail 或 composer slot，只允许后续 B4 Candidate Lab 复刻，不能借 inventory 条目解冻聊天生产接入。
> **2026-08-27 Agent Settings slice：** `agentSettingsForm #agentNameInput` 已接入生成的 Light-DOM Input 作为首个 Agent 设置字段切片；原生 input 仍是唯一业务节点，主聊天页 assistant switching 与其余 Agent 字段保持冻结/legacy。当前仅记录为 `production-consumer-active / visual-equivalence-pending`，待 Agent Settings 同引擎状态矩阵、Electron reload/teardown 与 field-specific legacy deletion 证据后再晋级。
> **2026-08-27 Agent model slice：** `agentSettingsForm #agentModel` 现加入同一生成 Light-DOM Input presentation slice；其自由文本 model id、`openModelSelectBtn`、异步 `modelSelectModal` 和 `saveAgentConfig` 语义全部保留。不得将该字段误套成 Select/AgentPreset；模型 picker 另行作为 B2 composite candidate。当前状态为 `production-consumer-active / visual-equivalence-pending`，等待 Agent Settings Input + picker 的同引擎状态、reload/teardown 和 field-specific legacy deletion 证据。
> **2026-08-27 Agent temperature slice：** `agentSettingsForm #agentTemperature` 现加入生成的 Light-DOM Input presentation slice；原生 `type=number`、`min/max/step`、settings manager 数值解析、保存和聊天参数消费全部保留。通用旧 Input enhancer 已跳过该字段。当前状态为 `production-consumer-active / visual-equivalence-pending`，仍需补 number Input 状态矩阵、同引擎 geometry/pixel、Electron reload/teardown 与字段级 legacy CSS/projection 删除证据；不得将其替换为 Range。
> **2026-08-27 Agent numeric parameter cluster：** `agentContextTokenLimit`、`agentMaxOutputTokens`、`agentTopP`、`agentTopK` 现加入同一生成 Light-DOM Input presentation owner；原生 `type=number`、约束、settings manager 解析/默认值、持久化 key 与聊天请求组装全部保留。它们暂记为 `production-consumer-active / visual-equivalence-pending`，待字段级状态矩阵、同引擎 geometry/pixel、Electron reload/teardown 和 legacy selector 删除证据后再晋级；不得改为 Range。
> **2026-08-27 下一施工游标：** Agent 设置的基础 Input 字段已覆盖 name/model/temperature 与常用 numeric cluster；下一切片转为 `B2 Agent model-picker composite contract`。先在 Candidate Lab 复刻 Harness provider/search/favorite/refresh/loading/error/dismiss 与 keyboard/focus/owner 语义，再评估真实 `agentSettingsForm` 接入。现有自由文本 `#agentModel`、`openModelSelectBtn`、异步 modal、IPC、持久化和 `saveAgentConfig` 继续作为 canonical 业务边界；不得用通用 Select 直接替换，也不扩展 DiffBlock 或冻结聊天内容。

> 状态：施工中（目标模式已启动）  
> 建立日期：2026-08-24  
> 适用目录：`/Users/asahi/Documents/Codex/VCPChat-newarchitecture`  
> 对照对象：本机 `deepseek-harness` 的 Client UI / Slot / Theme / lifecycle 机制
> **2026-08-27 当前批次复验：** `npm run test:uiux` 47/47、`node scripts/test-electron-uiux-theme.mjs`、`npm run check:uiux`、`npm run build:uiux`、`npm run check:uiux:artifacts`（72 generated files）、`npm run check:harness-reference`（44 files / 21 contracts）、`npm run check:harness-fixture-matrix`（51 visual / 18 interaction cases）与 `npm run guard:chat-kernel-consumers` 均通过。SettingsDocumentAction Button 的 DOM、geometry、computed-style 合同通过，但严格 ROI pixel diff 仍为 `3.08%` mismatch；Select closed trigger 仍为 `pending-trigger-dimension-mismatch`。本批不晋级 Candidate 为 Stable，不扩大 Settings 字段或通用 renderer。
> **2026-08-27 Electron reproducibility note：** `test-electron-uiux-theme.mjs` 首次运行在 Tooltip/ HoverCard geometry 断言处观察到 `tooltip.style=null`，未产生错误提交；同一工作树立即重跑后完整通过并生成 `vcp-harness-tooltip-hover-card-candidate.json/png`。该 journey 暂继续视为通过，但在扩大 Candidate 证据前仍需关注该 focus/portal 时序的重复稳定性。
> **2026-08-27 LanguageRow Candidate：** 新增 `modules/uiux/primitives/language-row.ts`，复刻 Harness `locale/LanguageRow.tsx` 的 row/title、36px selector、end-aligned Menu portal、unknown-active fallback、loading/disabled projection 与 owner teardown；新增 DOM/geometry/CSS reference contract、generated artifact 和 focused test（48/48）。VCP 当前没有 locale service、persisted UI-language key 或合法 Settings consumer，因此成熟度严格为 `candidate-source-only`，不新增 durable locale state、不接入 Settings bridge/IPC；Harness 同语义 fixture、computed-style/pixel diff 与 Stable 条件仍 pending。
> **2026-08-27 并行批次验收：** Settings name cluster（`userName`、`userNameTextColor`/mirror、`continueWritingPrompt`）已由 typed field owner 接管并通过 close-flush、trim/default/mirror、reload 与 3-cycle teardown 证据；`npm run check:uiux`、`npm run test:uiux`（44/44）、`npm run build:uiux`、`npm run check:uiux:artifacts`（66 generated files）、`npm run test:uiux:artifacts`、`npm run check:harness-reference`、`npm run check:harness-fixture-matrix`、`npm run guard:chat-kernel-consumers` 和 Settings Electron gate 均通过。该批次不改变 R2-02 的成熟度：全量 Settings legacy retirement、Theme legacy reads、packaged/cross-platform evidence 仍未闭合。
> **当前长期目标（2026-08-27 更新）：** 以 Harness 生产源码为真源，在组件库 Candidate Lab 完整复刻可移植控件及其 DOM/CSS/interaction/owner contract；每一个控件先闭合 `source → generated Light DOM → fixed viewport capture → DOM/computed-style/keyboard/pixel report` 等价链，再选择合法、非冻结的 VCP 生产 Surface 接入并删除旧 presentation path。Candidate Lab 不构成生产迁移或公共 API。严禁以字段迁移数量替代等价证据；严禁修改聊天内容、流式、协议、持久化、Plugin Loader、chat manifest、动态壁纸或 Composer 内部。
> **当前施工游标：** `B1-Harness-equivalence-button-select-fixtures`。先建立同语义 Harness production capture 与 VCP generated-artifact capture 的 DOM structural、contract-scoped computed-style/geometry、keyboard/focus、same-engine screenshot/pixel 对照；现有 Select trigger 报告必须保持 `pending-trigger-dimension-mismatch`，因为 Harness 150×28 与 VCP 219×40 尚非同一语义 fixture。对照链闭合前暂停新增 Settings 字段、DirectoryBrowser 状态和通用 renderer 扩展。
> **2026-08-27 Button capture audit：** VCP generated-artifact Button 六态 capture 已通过 `capture:vcp-button-fixture`；尝试从 Harness 真实 web scaffold 捕获 `SettingsDocumentAction` 的 `outline/sm` Button 时，默认 scaffold 不提供可定位的 Settings/Choose workspace 初始化入口，无法在不改变 Harness composition 的前提下到达生产按钮。该跨页 capture 暂记 `blocked-scaffold-entry`，不得用 mock 或单元 fixture 代替；下一次应复用 `settings-chrome.e2e.ts` 的完整 boot 条件后再重试。
> **2026-08-27 WelcomeNotice Button capture（本轮复验）：** `capture:harness-button-welcome-fixture` 已恢复为真实、可执行的 Harness `remote-welcome.e2e.ts` production composition capture（1 passed，不再跳过后消费旧报告）。VCP generated-artifact Candidate fixture 以仅测试用途的 WelcomeNotice consumer projection 对齐 `min-width:120px` 与已解析 primary token；两端 Button ROI 都是 120×36。DOM、语义、geometry 与所登记的 computed-style 合同全部通过（`font-family` 的可选引号按 CSS serialization 规范化）。为使独立 fixture 继承真实 VCP/Harness 的共同页面基线，补齐了现有 `styles/base.css` 已有的灰阶字体抗锯齿规则；严格 RGBA 像素策略现在通过：37/4320 像素不同、0.856%、mean channel delta 0.051，低于 `pixel-policy.json` 的 1%/2 阈值。状态仅为 `candidate-button-roi-pixel-policy-pass`，并非 VCP production equivalence；生产 consumer 和 legacy deletion 仍 pending。
> **2026-08-27 fixture ledger correction：** DirectoryBrowser matrix 已同步实现事实：draft preview/prefix filtering、two-leg target/parent landing（200ms fallback + late upgrade）、nested create 与 300ms slow-scan 均已有 generated-artifact/Electron 证据；成熟度仍为 `foundation-electron-active`，因为 same-semantic Harness diff、合法 VCP production consumer 和 legacy presentation deletion 尚未完成。
> **2026-08-27 SettingsDocumentAction Button capture：** 真实 Harness `settings-chrome.e2e.ts` composition 与 VCP generated Candidate 已分别捕获 `settings-general/document-action/open-document/outline-sm/enabled`；两端均为 94×28、padding `0 10px`、radius `14px`、1px outline、computed-style 合同一致（font-family 仅做可选引号规范化）。当前仍缺 shared-baseline ROI pixel diff、VCP production consumer 与 legacy deletion，因此状态为 capture-active。
> **2026-08-27 SettingsDocumentAction ROI diff：** VCP fixture 注入 Harness 已解析的 `--dsw-alias-border-l2: rgb(229,229,229)` 后，DOM/geometry/computed-style 检查全部通过；同尺寸 94×28 ROI 的严格 RGBA 比较仍失败（288/2632 像素，3.08%，mean channel delta 0.042，超过 1% 像素比例阈值）。该结果归因于跨页面文字/边缘栅格化差异，不能放宽政策或宣称 pixel-equivalent；VCP production consumer 与 legacy deletion 仍 pending。
> **2026-08-27 Select open-menu 重放：** `capture:harness-select-fixtures`（4 tests passed）与 `capture:vcp-select-browser-fixture` 成功重放 `agent-preset-selection/ready/Standard mode/open-selected-hover-menu`；`diff:harness-vcp-geometry` 报告 `cross-page-select-geometry-equivalent`，`diff:harness-vcp-pixels` 报告 `compared; pass=true`。该 pass 仅覆盖 menu ROI 的 open/selected/hover 状态；closed trigger 仍为 `pending-trigger-dimension-mismatch`，busy trigger 仍受 VCP consumer boundary 阻断。
> **2026-08-27 Select keyboard-focus 重放：** `VCP_SELECT_MENU_STATE=focus` 下 Harness/VCP fixture 均成功捕获，`document.activeElement` 两端均为 trigger；geometry 报告 `cross-page-select-geometry-equivalent`，pixel 报告 `compared; pass=true`（约 0.060% differing ratio，mean channel delta 0.0031）。该 pass 仅覆盖 keyboard-open focus 状态，不覆盖 closed trigger 或 busy trigger。
> **2026-08-27 OnboardingSurface Candidate：** 新增 `modules/uiux/primitives/onboarding-surface.ts`，按 Harness `OnboardingSurface.tsx` 复刻 body portal、1100 overlay、80px top mask、stage 与 `#root.inert` 生命周期；content 节点按原始父级/顺序恢复，focused test 验证 open/close/reopen/dispose。Candidate Lab、generated artifact、reference contract、47/47 UIUX tests 与 Electron journey 均通过；Harness pixel fixture、VCP production consumer 和 legacy deletion 仍 pending。
> 上位规范：[vcpchat-harness-uiux-architecture.md](/Users/asahi/Documents/Codex/VCPChat-newarchitecture/docs/vcpchat-harness-uiux-architecture.md)；本文件只负责执行顺序、consumer、证据与删除账本
> **2026-08-27 目标调整（覆盖下方旧施工游标）：** 当前 active slice 为 `B1-Harness-equivalence-button-select-fixtures`。RiskConfirmation、AgentPresetSeat/Row 与其他 B1/B2 控件的 Candidate 均已落库，但下一步优先闭合 Harness/VCP 同语义 DOM、computed-style、geometry、keyboard/focus 与 screenshot/pixel 证据链。现有 UI 组件库继续作为 generated-artifact Candidate fixture host，允许复刻没有 VCP 生产 consumer 的 Harness 控件；展示通过、source-only fixture 或组件数量均不等于生产完成。Field/Select 既有生产证据继续有效，但 Select trigger 当前仍是尺寸不同的语义 fixture，不能晋级等价。权威清单见 [harness-primitive-inventory.md](/Users/asahi/Documents/Codex/VCPChat-newarchitecture/docs/harness-primitive-inventory.md)。
> 最近核验：2026-08-27；R2-00 Composer slice 已达到 complete（仅指已登记的 `mainChatComposition`/standalone history consumers）；R2-01 Overlay/notification slice 已闭合；R2-03 为 semantic-token-projection-active；R2-08 为 scoped-service-assembly-active（仍委托 legacy LifecycleScope，public API 未就绪）；R2-02 为 typed-production-consumer-active（legacy bridge、Classic fallback 与完整 stress 证据仍未闭合）。当前 Candidate Lab 游标为 RiskConfirmation：现有 Select full-state production fixture 的阻断与 legacy deletion 继续作为 R2-02C unresolved ledger，不应被 Candidate 施工覆盖。当前证据按 primitive/state 独立记账，不得把其中任一项写成全 primitive 或全矩阵 pixel equivalence。
> 本轮补充 Harness `Input` reference pack（DOM/geometry），作为下一批 range/choice 之前的 CSS/DOM 基线；尚未将 Input 或 Range 宣布为生产 primitive。
> 2026-08-26：`homeVisualTagline` 已接入 TS Light-DOM Input primitive，保留 native input 与 SettingsUiService 业务链；源码 `npm run test:uiux` 21/21、Settings Electron gate 通过。该字段 legacy input wrapper 已跳过，待 artifact-only Input smoke 与完整 screenshot geometry 证据后再扩大迁移。
> 2026-08-26：generated-only Electron smoke 已覆盖 Input primitive（`vcp-uiux-input-wrap`）的产物加载与 teardown 路径；`node scripts/test-electron-uiux-theme.mjs` 通过。
> 2026-08-26：`appearanceSidebarRadiusChoice` 已接入 TS Choice primitive；Settings Electron gate 已验证 native option count、selected source、option class 与点击切换。legacy startup fallback 仍保留，待 reload/Classic 等价证据后退役。
> 2026-08-26：generated-only Electron smoke 已覆盖 Choice artifact（挂载、native selected source、dispose 路径）；`node scripts/test-electron-uiux-theme.mjs` 通过。
> 2026-08-26：`appearanceSidebarAvatarSize` 已接入 TS Light-DOM Range primitive，native range 仍为唯一业务源，output 同步与 teardown 由 scope 管理；源码 `npm run test:uiux` 23/23、Settings Electron gate 通过。尚未扩大到其他 range 字段。
> 2026-08-26：Range 批次已扩展至 `appearanceSidebarRowHeight` 与 `appearanceCustomRadius`，三字段共用 TS Range contract；Settings Electron gate 验证三字段挂载，源码 UIUX tests 通过。下一步补 generated-only Range smoke 与三字段 legacy projection retirement。
> 2026-08-26：generated-only Electron smoke 已覆盖 Range artifact 的挂载、input→output 同步和 teardown 路径；`node scripts/test-electron-uiux-theme.mjs` 通过。
> 2026-08-26：Range output projection 已从 `appearance-studio.js` 移除，三字段 output 现在由 TS Range primitive 单一 owner 负责；appearance engine 仅保留规范化与语义应用。Settings Electron gate 与 UIUX tests 通过。
> 2026-08-26：Range 批次 source-equivalence 审计通过（legacy rows/inline styles/selectors 均为 0）。`global-settings-manager.js` 对 range 的读取是持久化命令输入，不属于 presentation projection；启动 fallback 仍按 reload/Classic 等价条件保留。
> 2026-08-26：`showHomeVisualBrand` 与 `showHomeVisualTagline` 已接入 TS Toggle primitive；native checkbox 保持业务源，legacy `.slider` presentation 在该字段上隐藏并由 owner teardown 恢复。源码 `npm run test:uiux` 24/24、Settings Electron gate 通过。
> 2026-08-26：generated-only Electron smoke 已覆盖 Toggle artifact 的 checked source、legacy slider 隐藏和 teardown 路径；`node scripts/test-electron-uiux-theme.mjs` 通过。Toggle 双平面证据闭合。
> 2026-08-26：Toggle generated smoke 进一步断言 dispose 后 native checkbox 回到原始 label、legacy slider display 恢复为空；artifact 可逆性闭合。
> 2026-08-26 latest checkpoint：Toggle/Range/Choice/Input/Select/ThemeTokenOwner 全部启用后，Settings Electron gate、generated artifact smoke、60-cycle lifecycle stress 均通过；stress 指标稳定为 listeners 618、resources 341、nodes 8410、detached 0。
> 2026-08-26：ColorPair 接入后再次完成 Settings-only 60-cycle stress；listeners 625、resources 347、nodes 8412，cycle 1→60 稳定且 detached roots/options/icons 为 0。
> 下一候选 `userAvatarBorderColor` 为 color input + text mirror 双控件，已建立 `color-pair.dom.json` / `color-pair.geometry.json` 基线；在单一 source/mirror owner、invalid-text 恢复和双控件 teardown 证据齐全前不接入生产。
> 2026-08-26：ColorPair 已完成 production integration；artifact consistency（34 files）、artifact smoke、Theme Electron journey 与 Settings-only 20-cycle stress 均通过。该双控件现可作为后续 color/text Settings 字段迁移模板。
> 2026-08-26：Settings Electron journey 新增 ColorPair snapshot probe，外部 `userAvatarBorderColor` 更新会同步刷新 color source 与 text mirror；双控件 snapshot ownership 证据闭合。
> 2026-08-26：Settings Electron journey 新增 Home Visual Toggle snapshot probe，验证两个 checkbox 可由外部 snapshot false→true 往返恢复，且不触发聊天业务路径；Toggle ownership 证据闭合，旧 startup fallback 仍按兼容边界保留。
> 2026-08-26：新增 Toggle DOM/geometry reference pack（`toggle.dom.json`、`toggle.geometry.json`），与已通过的 generated-only artifact smoke 对齐。
> 当前 primitive ledger：Field、Select、Input、Range、Choice、Toggle 均已有 TypeScript Light-DOM 实现；已迁移的 Settings 外观/首页字段子集按单一 typed owner 接入，并有源码测试、generated artifact smoke、Electron DOM/geometry/interaction、snapshot/reload 与 Settings-only stress 证据。该证据不代表全量 Settings 或 Harness 等价完成。R2-02C 仍未 complete：Theme legacy reads、剩余未迁移 Settings 字段、Classic fallback 收口和全量 legacy deletion 仍是后续工作；聊天渲染/流式/协议/Plugin Loader 继续冻结。
> 2026-08-26：修正 `check-chat-kernel-consumers.mjs` 依赖扫描为忽略注释文本；`npm run guard:chat-kernel-consumers` 重新通过（17 kernel files），未修改任何聊天运行时代码。
> 2026-08-26 checkpoint：`npm run test:uiux` 25/25、`npm run check:uiux:artifacts`、`npm run guard:chat-kernel-consumers` 全部通过；primitive 与聊天冻结边界保持稳定。
> 2026-08-26：在 ThemeTokenOwner + Toggle/Range/Choice/Input 全部启用后重新完成 Settings-only 60-cycle stress；listeners 618、lifecycle resources 341、nodes 8410 全程稳定，detached roots/options/icons 仍为 0。
> 2026-08-26：ThemeTokenOwner 已落地为 document-level reference counting；多个 ThemePresenter 共存时，单个 presenter dispose 不会恢复/清空仍被其他 presenter 使用的 semantic tokens。`npm run test:uiux` 25/25 通过。
> 2026-08-26：ThemeTokenOwner 变更后的 generated artifact smoke、Electron theme journey、Settings Electron gate 全部通过；主题切换/reload 与 Settings visual contract 未回归。
> 2026-08-26：Settings-only 60-cycle lifecycle stress 通过；cycle-1..60 listeners 620、lifecycle resources 337、nodes 8406、detached roots/options/icons 0，确认 Range/Choice/Input 扩展未引入 listener 或 owner 增长。Range 三字段不存在旧 presentation fallback；仅保留 global-settings-manager 持久化读取。
> 2026-08-26：Classic parity 与 retirement boundary guards 均通过；Range 三字段在旧路径中仅保留 global-settings-manager 的持久化读取和 appearance-studio 的规范化/语义应用，无重复 presentation output 写入。新增 `range.dom.json` / `range.geometry.json` reference contract。
> 最近证据：`node --test tests/chat-surface.test.mjs tests/chat-surface-slots.test.mjs tests/main-chat-surface-adapter.test.mjs tests/chat-plugin-manifest.test.mjs`（19/19）；`npm run test:electron-main-chat-sequences`（next-main-chat-default，24 actions，25 VCP requests，required 1/1）
> R2-01 证据：`node --test tests/overlay-coordinator.test.js tests/escape-dispatcher.test.js tests/notification-menu-controller.test.js`（9/9）；`node scripts/test-ui-system.mjs`；`node scripts/test-settings-wa-electron.mjs`（Settings Harness structure gate passed）。R2-03 证据：`npm run test:uiux` 的 ThemePresenter semantic token/teardown 合同；`node scripts/test-appearance-studio.mjs`。R2-08 证据：`npm run check:uiux`；`npm run test:uiux`（Settings、Theme、scoped registry contracts）；`npm run check:uiux:artifacts`；`npm run test:uiux:artifacts`；`npm run test:electron-uiux:artifacts`（Electron 仅加载 generated browser-entry 并执行 generated Settings adapter save/dispose contract）；`tests/uiux-service-registry.test.mjs`（parent invalidation、reverse unwind、async disposer quiescence）。仍不声明 public runtime ready，因为 UiScope 继续委托 legacy LifecycleScope，且缺完整 packaged artifact/跨平台证据。

## 0. 这份文档的职责

这是一份动态路线账本，不是一次性设计宣言。它只记录四类事实：

1. 当前目标模式与已经进入生产的代码；
2. 每个阶段的真实消费者、退出证据和未闭合风险；
3. 当前施工批次、下一批次和明确非目标；
4. 相对上一版路线的新增、删除和原因。

每次进入新的施工批次，必须同时更新本文件的“状态账本”、对应代码、最小测试和证据链接。计划中的能力不得写成已交付；只有生产消费者、owner、撤销路径和行为证据齐全，才能从 `planned` 变为 `active` 或 `complete`。

## 0.0 当前施工批次：B1 Harness equivalence / Button + Select fixtures

当前状态：`candidate-lab-active`。

- `UI 组件库` 是真实 Electron internal app，继续由 `next:component-showcase` scope 负责 mount/dispose；
- `modules/uiux/generated/browser-entry.js` 提供 TS generated artifact，组件库只调用 Candidate lab mount，不建立第二份 runtime；
- 第一批纳入 Button、Input、Field、Select/Menu；Button 为既有 Candidate，Input 明确标注 Harness 当前没有生产 consumer；
- Menu、Modal、Tooltip/HoverCard、DisclosureRow、StateDot、Toast、RiskConfirmation 与私有 icon contract 已完成各自 Candidate checkpoint；本批只推进 Button/Select 的同语义 Harness 对照，不迁移 Harness 全量 glyph catalog 或创建公共 icon Provider；
- 每个控件必须展示可枚举 states，并建立独立 provenance、DOM/ARIA、geometry/token、interaction、dispose 和 screenshot ledger；
- 生产晋级仍要求真实 VCP consumer、canonical state、legacy deletion、Electron journey 和相应平台证据。

2026-08-27 首批证据：`npm run check:uiux`、`npm run test:uiux`（30/30）、`npm run check:uiux:artifacts`（40 generated files）、`npm run test:uiux:artifacts` 与 `node scripts/test-electron-uiux-theme.mjs` 均通过。Electron generated-artifact journey 已真实挂载 Button 六态、Input、Field、Select/Menu，并验证 Candidate marker 与 teardown 恢复。全量 `test-electron-ui-apps-smoke.mjs` 在到达组件库前等待既有 `vchat-dynamic-wallpaper` frontend plugin readiness 超时，因此当前不将其计作 Harness Lab 整页 Electron pass；脚本内已加入 lab contract，待该外部启动阻断解除后自动覆盖真实 internal-app 路径。

2026-08-27 Menu atom checkpoint：新增独立 `modules/uiux/primitives/menu.ts`，没有复用 Select 的业务 source，也没有增加 durable state。合同覆盖 owner-controlled open/selection、open-only outside/Escape/scroll/resize effects、12px portal clamp、label/separator/footer、multi-selected trailing checks、disabled、danger、submenu、dense/compact 与 awaitable scope teardown。源码 focused test 11/11、42 generated artifact consistency、artifact smoke 和 Electron generated journey 通过；固定 800×600@1x screenshot/geometry 已登记到 `fixtures/vcp/menu.candidate.*`。当前成熟度为 `candidate-interaction-active`，因为还缺 WorkspaceBrowser 同语义 Harness capture 的 DOM/computed-style/pixel diff，也没有 VCP production consumer/legacy deletion，禁止标记 Stable。

2026-08-27 Modal checkpoint：新增独立 `modules/uiux/primitives/modal.ts`，复刻 Harness body portal、mask、standard/headless DOM、`className`/`contentClassName` 生产扩展点、24px card、Escape/mask/close-button 与 close/reopen/dispose。Candidate 不添加 Harness 源码没有的 focus trap/autofocus/restoration；交给 Modal 的已有 body/footer DOM 只在 open 时进入 portal，close 时按逆序锚点恢复原父节点和精确顺序。源码 focused test 12/12、44 generated artifact consistency、artifact smoke 和 Electron journey 通过；固定 800×600@1x standard screenshot/geometry 已登记到 `fixtures/vcp/modal.candidate.*`，headless/三种关闭路径也由 Electron 重放。当前为 `candidate-interaction-active`；同语义 Harness production screenshot/pixel diff、VCP production consumer 与 legacy deletion 仍 pending。

2026-08-27 Tooltip/HoverCard checkpoint：新增独立 `modules/uiux/primitives/tooltip.ts` 与 `hover-card.ts`。Tooltip 保持原 anchor DOM、不添加 wrapper，覆盖 lazy label、hover delay、focus immediate、right/bottom/top、12px viewport clamp、vertical flip、disabled-mid-open 和 dispose；HoverCard 覆盖 500ms 默认 dwell、200ms pointer grace、body portal、scroll/resize/bottom clamp、copy button/selection guard/status feedback、迟到 clipboard epoch 失效和精确 DOM 恢复。源码 focused test 14/14、全量 UIUX 34/34、48 generated artifact consistency、artifact smoke 和 Electron generated journey 通过；固定 800×600@1x geometry/screenshot 已登记到 `fixtures/vcp/tooltip-hover-card.candidate.*`，Lab journey 还真实触发了 bottom→top viewport flip。当前为 `candidate-interaction-active`；同语义 Harness pixel diff、VCP production consumer 与 legacy deletion仍 pending。

2026-08-27 DisclosureRow checkpoint：新增独立 `modules/uiux/primitives/disclosure-row.ts`，保持 owner-controlled `open`，覆盖整行 click/Enter/Space、leading native button、collapsed icon→hover chevron、open chevron、keep/hide collapsed content、forced-open non-expandable、consumer class extension 和精确 DOM 恢复。Tool/Workflow 是 Harness production provenance；Reasoning/Context 等 chat consumer 只登记参考，不解冻 VCP 消息内部生产接入。源码 focused test 15/15、全量 UIUX 35/35、50 generated artifact consistency、artifact smoke 和 Electron generated journey 通过；固定 800×600@1x geometry/screenshot 已登记到 `fixtures/vcp/disclosure-row.candidate.*`。当前为 `candidate-interaction-active`；同语义 Harness pixel diff与非冻结 VCP production consumer仍 pending。

2026-08-27 StateDot checkpoint：新增独立 `modules/uiux/primitives/state-dot.ts`，精确复刻 done/warning/error 的 10px halo + 6px core，以及 ongoing 的 8×2px crisp-edge pixel chase；覆盖四态闭集、任意正尺寸、8 个负相位 delay、`aria-hidden`、状态/尺寸更新和 host 精确恢复。Jobs、Workflow、Workspace、Subagent、Tool 是 Harness production provenance；VCP chat consumer 仍受冻结边界约束。源码 focused test 16/16、全量 UIUX 36/36、52 generated artifact consistency、artifact smoke 和 Electron generated journey 通过；固定 800×600@1x 四态 geometry/screenshot 已登记到 `fixtures/vcp/state-dot.candidate.*`。当前为 `candidate-interaction-active`；同语义 Harness pixel diff与真实 VCP consumer仍 pending。

2026-08-27 Toast checkpoint：新增独立 `modules/uiux/primitives/toast.ts`，复刻单个 body-portal transient alert，而非新增 notification queue。合同覆盖 `role=alert`、optional aria-hidden icon、viewport/anchor 水平居中、resize remeasure、3000ms hold + 1000ms fade、`onDone` 一次通知、pointer-events none 和 scope dispose timer cancellation。InputBar 是冻结的 Harness provenance，不接入 VCP Composer；ModelSelect 可作为未来非冻结 consumer。当前为 `candidate-interaction-active`；完成 Lab/generated/Electron geometry/screenshot 后仍需同语义 Harness pixel diff与真实 VCP consumer才能晋级。

2026-08-27 RiskConfirmation checkpoint：新增受控 `modules/uiux/primitives/risk-confirmation.ts`，复用 Candidate Modal/Button，以 Light DOM 复刻 warning icon、description、checkbox acknowledgement 和 primary action gate。只接受 caller 的 `open`/`acknowledged`/`disabled` 投影与 action callbacks，不持有 VCP durable state，不替换 `showConfirmDialog()` 或接入冻结的聊天 Permission/Command consumer。当前 focused generated-artifact test 覆盖 unacknowledged/acknowledged/disabled、cancel/mask/Escape、reopen、autofocus 与 dispose；Electron geometry/screenshot、Harness same-semantic pixel diff、合法 VCP production consumer 和 legacy deletion均 pending，因此为 `candidate-interaction-active`，不是 Stable 或 public business API。

2026-08-27 private icon contract checkpoint：新增 `modules/uiux/primitives/semantic-icon.ts`，只覆盖 RiskConfirmation/Modal/Menu/Disclosure 所需的 `warning`、`close`、`check`、`chevron-down`。slot 自身只规定 `aria-hidden`、`currentColor` 和 14/16/18px geometry，glyph 渲染仍唯一委托给现有 `VCPIcons` Lucide adapter；不新增 SVG catalog、icon Provider 或业务 API。source test 覆盖 adapter refresh、name/size update 和精确 restore；generated Electron Lab 已确认四个名称渲染为非焦点 SVG。独立 screenshot/geometry、Harness pixel diff、真实 consumer adoption 和 legacy deletion仍 pending，成熟度为 `candidate-interaction-active`。

2026-08-27 Menu ReactNode 合同收口：上轮遗留的 `modules/uiux/primitives/menu.ts` Node-label 支持经真源核对确认为 Harness `Menu.tsx:22` `label: ReactNode` 的合法对齐（非越界改动），已补 focused test（Agent-Preset 式 name/description 复合 label）并再生 artifacts。选中项不触发 Menu.onClose 的合同也在此确认：Harness 只在外部点击/Escape 时调用 onClose，关闭由调用方投影。

2026-08-27 AgentPresetSeat Candidate checkpoint（B2 首个 composite）：新增 `modules/uiux/primitives/agent-preset-seat.ts`，以 Light DOM 复刻 Harness hero chip——seat 按钮 28px/8px/16px pill、`ic_ds_agent_preset_outline_16` + chevron 14 真源 glyph、`aria-haspopup/aria-expanded`、staged preset label、body-portal Menu（align start）与 name-over-description 复合 item label。owner-controlled 合同覆盖 closed/open/selected/hover/focus/busy-disabled/error title 与 roster swap rebuild；候选不复刻 introduce-cue 动画与 PresetMenu trust 后缀/Row 36px pill（inventory 已登记为未完成 sub-state）。发现两点环境事实并如实记录：① Harness `ui-theme` 从未定义 seat disabled 使用的 `--dsw-alias-label-quaternary`，candidate 保留该变量名不加 fallback；② VCP next-shell `mountNativeTooltipBridge` 会把原生 `[title]` 异步转换为 `data-tooltip`/`aria-label`，Electron 探针同时记录两种载体。证据：`npm run test:uiux` 41/41、`npm run check:harness-reference`（34 files / 16 contracts）、60 generated artifact consistency、artifact smoke、`npm run guard:chat-kernel-consumers` 与 `node scripts/test-electron-uiux-theme.mjs` 全部通过；固定 800×600@1x open-selected screenshot/geometry 已登记到 `docs/reference/deepseek-harness-primitives/fixtures/vcp/agent-preset-seat.candidate.*`。VCP 没有合法 AgentPreset production consumer（assistantAgent legacy-owned、chat switching 冻结），Lab 通过≠Stable，Harness 同语义 pixel diff 仍 pending。

2026-08-27 AgentPresetRow Candidate checkpoint（PresetMenu trust 后缀 + 36px pill 合同）：新增 `modules/uiux/primitives/agent-preset-row.ts`，首个自建 DOM 的复合 primitive——host 内组装 `.vcp-agent-preset-row`（flex/gap 8px/16px 0/border-bottom border-l2）内含 title/desc 文本列（desc 有 error 时置 `role="alert"`）与 `.vcp-agent-preset-selector` 36px pill（gap 12px/padding 0 14px/radius 18px/bg-module-platform，fallback rgb(245,246,247)），内部以 `mountMenu` 挂 align-end body-portal 菜单并按 Harness `PresetMenu.tsx` 合同对 string label 追加 trust==='user' 的 `· <userTrust>` 后缀（en 默认 'Custom'）；label 回退链为 loading 文案 → `preset.name ?? preset.id`，disabled 规则忠实 `busy || !writable || options.length===0`，owner-controlled 投影覆盖 roster swap/roster rebuild 后 selection 清空/busy/writable/error。focused generated-artifact test 与 Electron geometry 探针（36px/radius 18px/padding 0 14px/gap 12px、alignEnd、portal list 开启时挂 body、trust 后缀三项 items、picks/draft 关闭投影、busy disabled、error alert）全部通过；探针修正一处自身时序错误——portal list 在关闭时会被 detach，placement 断言必须在点选前读取。证据：`npm run test:uiux` 42/42、`check:uiux`/`build:uiux`、62 generated artifact consistency、artifact smoke、reference pack（34 files / 16 contracts）、kernel guard 与 Electron journey 全绿；固定 800×600@1x screenshot/geometry 登记到 `docs/reference/deepseek-harness-primitives/fixtures/vcp/agent-preset-row.candidate.*`。仍无合法 VCP production consumer，仅 introduce-cue 动画未复刻；Harness 同语义 pixel diff pending，不得晋级 Stable。

2026-08-27 AgentPreset evidence-contract audit：为避免仅有 Candidate fixture 却没有可机读 Harness 真源，新增 `agent-preset-seat` 和 `agent-preset-row` 各自的 DOM/ARIA/owner/dispose 与 CSS/geometry reference contract，并把两个 composite 的 visual states、interaction/dispose 语义和“无 VCP production consumer + Harness 同语义 pixel diff pending”状态写入 fixture matrix 的硬门禁。`check:harness-reference` 现要求 18 份 primitive contract（38 files），fixture matrix 现追踪 38 个 visual cases 与 13 个 interaction cases。验收时，focused UIUX 42/42、现有 generated-artifact smoke、reference/fixture gates、chat-kernel consumer guard、Electron journey 均通过；本轮 AgentPreset 三个提交未触及 Plugin Loader、chat manifest 或冻结 chat kernel。全量 `check:uiux`、`build:uiux` 与重新生成 artifact check 当前不作为通过证据：未提交且未被 AgentPreset import 的 `modules/uiux/primitives/popup-select.ts` 已被 tsconfig 自动纳入，存在 4 个 TypeScript 错误；先由其作者闭合或隔离该 WIP，才可恢复全工作树的编译/生成门禁。该阻断不改变 AgentPreset 的 Candidate 成熟度，也不允许其晋级 Stable。

2026-08-27 PopupSelect Candidate checkpoint（B2 Command composite）：将先前无入口的 `modules/uiux/primitives/popup-select.ts` 收敛为 generated-artifact、Light-DOM、Lab-only Candidate，并修复其错误的 binding 类型、capture listener 与重复/悬空 subscription/dispose 路径。其 Harness 真源是 `ui-commands/src/client/popup.ts` 与 `PopupSelectView.tsx`：controller 只持有 transient open/load/filter/highlight/submitting/risk state，业务 option loader、selection、token consume 与 focus return 均由 caller 注入；reopen/dismiss/dispose 通过 AbortController + binding identity 丢弃迟到结果。VCP Lab 使用无副作用的 local callback，不接入 `conversation.input.overlay`、Composer、input machine、IPC 或 command business chain。新增 DOM/CSS contracts、focused generated-artifact test、artifact-smoke import 与 800×600@1x Electron screenshot/geometry（open/filter/risk/success/focus/closed）；reference pack 现为 19 primitives / 40 contract files，fixture matrix 为 41 visual cases / 14 interactions。成熟度仅 `candidate-interaction-active`：Harness same-semantic pixel diff、合法 VCP production consumer 与 legacy deletion 均 pending，绝不因 Lab export 晋级 Stable。

2026-08-27 DirectoryBrowser foundation（B2 Directory flow）：新增 `modules/uiux/primitives/directory-browser.ts` 的 Light-DOM Miller browser 基础，实现严格 injected `listDirectory`/`createDirectory`/`onOpen`/`onClose` face，单/双栏 selection、hidden filter、Open/Cancel、AbortController + generation close/reopen/dispose 安全。Candidate Lab 使用内存 fixture tree；未触碰 VCP directory IPC、Workspace persistence、动态壁纸路径选择或任何聊天域。当前只标记 `foundation-under-test`：已具备 focused generated artifact owner/liveness 测试和 DOM/CSS source contract；仍缺 path editor、nested create dialog、slow scan、Electron fixture 和 same-semantic pixel diff，不能称 Candidate active 或 Stable。

2026-08-27 DirectoryBrowser Electron checkpoint：固定 800×600@1x 的 generated artifact Electron journey 已验证 headless dialog 为 680×500、0 padding/gap、single → selected two-pane + divider、hidden entries toggle、row 28px/radius 6px/column 256px/footer 12×24 geometry、owner `onOpen(selectedPath)` 与 close/dispose。实现中发现 shared Modal stylesheet 后加载会覆盖单类 browser selector；按 Harness `DirectoryBrowser.module.css` 的 `.dialog.dialog` 优先级模型改为双类 selector，修正后证据通过。状态推进为 `foundation-electron-active`，但路径编辑、nested create dialog、slow scan、same-semantic pixel diff与合法 VCP production consumer仍明确 pending。

2026-08-27 DirectoryBrowser path-submit checkpoint：在同一 Candidate owner 内接入 Harness breadcrumb → Light-DOM path input 的最小安全垂直切片：以当前 list path 预填、Enter 通过 injected `listDirectory` 提交扫描、Escape 仅退出编辑并 `stopPropagation()`（不可让 shared Modal 误关闭）。focused generated-artifact test 覆盖提交、取消、Open target 与重开；该路径编辑仍只是 submission-only，尚未实现 Harness draft debounce、prefix filter、two-leg landing 或 Electron visual fixture，不能扩大成熟度声明。

2026-08-27 DirectoryBrowser nested-create checkpoint：新增 Harness 目录浏览器的 nested create dialog，但仍只经由 injected `createDirectory(path, name)` 工作。子 dialog 打开时 parent Dialog 的 rows、crumbs 与 footer 控件均 inert；Escape 只收回 child；成功 create 由 request token 约束、重扫目标 level 并选中新建 entry。generated artifact focused test 与 800×600@1x Electron fixture 都验证 380px 子 dialog、44px input、parent inert、Escape retract、选择与 Open target。尚未实现 Harness draft preview/filter、slow-scan、two-leg landing 或同语义 pixel diff，因此仍是 `foundation-electron-active`。

2026-08-27 DirectoryBrowser slow-scan checkpoint：listing owner 增加 300ms 静默窗口；快速响应不产生 Loading 闪烁，慢响应才在 content 角落显示状态，新的导航或 close/reopen/dispose 会取消旧定时器。focused generated-artifact test 已验证快/慢两条路径。状态保持 `foundation-electron-active`，下一缺口收敛为 Harness draft preview/prefix filter、two-leg landing、same-semantic pixel diff 与 VCP production consumer。

2026-08-27 DirectoryBrowser draft-prefix checkpoint：路径编辑现在会在 Light DOM 内即时重绘当前 pane 的最后路径段前缀；命中时收窄列表，无匹配时保留原列表，避免编辑过程出现空白 pane；输入仍不会触发 host listing，Enter 才提交导航。focused artifact test 覆盖命中、无匹配与 Escape 恢复。该切片尚未实现 Harness draft directory debounce、two-leg landing 或同语义 pixel diff，状态仍为 `foundation-electron-active`。

2026-08-27 DirectoryBrowser draft-preview checkpoint：路径草稿在以分隔符结束时启动 250ms debounce，稳定后仅通过 injected `listDirectory` 预览目标 directory；结果替换 pane 但保持 editor 挂载，最后未完成段仍走 local prefix filter。预览 timer 与 listing generation 都随 owner 被新输入、close/reopen/dispose 取消。focused artifact test 验证 debounce、capability call、pane 更新和 editor 保持。仍缺 Harness two-leg landing 与同语义 pixel diff，状态保持 `foundation-electron-active`。

2026-08-27 DirectoryBrowser two-leg landing checkpoint：非 root draft preview 先 list target、再在同一 generation 内 list parent；仅 parent entries 含 target 时一起提交 parent + selected target child 的双栏，否则安全退化为 target 单栏。focused artifact test 覆盖 parent-leg 请求、双栏和 selected row。Harness 的 parent-leg timeout/late upgrade 等完整 timing 仍未复刻，且无同语义 pixel diff 或 VCP production consumer；状态保持 `foundation-electron-active`。

2026-08-27 DirectoryBrowser landing-timing checkpoint：统一 `land()` helper 现在对 parent leg 施加 200ms 界限；超时先提交 target 单栏，合法的晚到 parent 结果仍可在同一 generation 内升级为 selected 双栏，失败或缺少 target 则维持单栏。focused artifact test 已覆盖慢 parent 的 single-first 与 late upgrade。DirectoryBrowser 仍缺合法 VCP production consumer 与同语义 Harness DOM/computed-style/pixel diff。

本批次不解冻聊天内核、消息渲染、Composer 内部、协议、IPC、持久化、Plugin Loader、chat manifest 或动态壁纸。Harness conversation/tool/markdown 控件可以在实验室复刻，但不得借实验室接入改变这些冻结边界。

## 0.3 上位规范到执行批次的映射

`vcpchat-harness-uiux-architecture.md` 是范围、冻结边界和 Definition of Done 的权威来源；本路线不再重复定义另一套目标架构。执行关系如下：

| 上位规范 | 本路线执行批次 | 当前状态 |
| --- | --- | --- |
| U0 事实与架构冻结 | R2-00 前置登记、工作树和证据账本 | complete |
| U1 TypeScript UI foundation | R2-08 `modules/uiux/` typed kernel | scoped-service-assembly-active（局部 registry + Settings producer/consumer；public API not ready） |
| U2 Overlay / Focus / Primitive kernel | R2-01 | notification/lease slice complete，journey 持续补证据 |
| U3 Theme service | R2-03 | semantic-token-projection-active（legacy theme reads remain） |
| U4 Settings Surface | R2-02 | typed-production-consumer-active（legacy bridge retirement and broad lifecycle evidence pending） |
| U5 Shell 与 Chat Surface | R2-00、R2-04 | Chat Composer slice complete，Shell 持续迁移 |
| U6 App Surface | R2-05 | planned |
| U7 旧 UI 清理与发布证据 | R2-07 | planned |

新 UI 公共 API、primitive 和 Surface 从 R2-08 起默认使用 TypeScript；当前既有 JavaScript 改动只作为有编号的迁移适配层，不扩展新的稳定 UI API。

## 0.1 长期目标（North Star）

最终目标是把 VCPChat 的 UI/UX 变成接近 DeepSeek Harness 的可组合运行时，而不是在旧架构外面继续包一层 wrapper。激进重构只发生在 UI/UX 边界；业务域与聊天核心保持冻结。

```text
任意高频 UI 任务
  → 一个明确的 typed UI adapter（Domain snapshot / command / subscribe）
  → 一个明确的 Surface owner
  → 一个明确的 Slot graph occupant
  → 一套 TypeScript primitive / Web Component / theme / focus contract
  → 一条真实 Electron 操作序列
  → 可重放、可回滚、可长期 soak 的证据
```

目标模式必须包含：

- `Service Definition → Provider / Electron adapter → Consumer / Surface`；
- `Effect / Scope / Owner / Dispose` 生命周期，所有 UI 副作用可等待撤销；
- `Snapshot / Command / Subscribe` 状态合同，UI 不复制 durable state；
- TypeScript DOM renderer、Web Components、native/Web Awesome fallback；
- 每个迁移 Surface 完成后删除旧 presentation 路径，而不是永久保留 wrapper；
- StreamCoordinator、StreamSession、StreamProjection、消息协议和持久化作为冻结业务边界，只允许 UI 通过 adapter 消费。

允许的激进方向：

- 将 `main.html` 从“所有页面结构的真源”降级为兼容壳，并逐步把高频 Surface 的结构迁入 owned mount root；
- 将 `renderer.js` 从业务与 DOM 的总装配器收敛为 composition adapter；
- 将 `settings-bridge`、`appearance-studio`、`next-shell` 等 bridge 按任务切片删除，而不是无限扩展；
- 让 Slot graph 成为内部 UI 扩展和未来皮肤/工作流能力的正式入口；
- 在完成真实 consumer 与证据后，激进删除重复 DOM、selector、全局状态和旧 facade。

禁止的激进方向：

- 不复制聊天 durable state；
- 不把消息协议、流式 renderer、插件 Loader、动态壁纸和 Electron 主进程边界重写为 UI Runtime；
- 不用“迁移完成率”替代用户任务、生命周期和跨平台证据；
- 不保留一个没有生产消费者的 Mega Runtime 只因为路线图已经写过。

## 0.2 昼夜持续推进协议

这条路线可以长期推进，但每个自动施工批次必须是有限、可审查、可回滚的切片：

1. 读取当前账本和工作树，确认唯一 active slice；
2. 选择一个真实生产 consumer，写出 invariant、owner、rollback 和 evidence command；
3. 先做最小代码变更和 focused tests，再决定是否扩大范围；
4. 任何异步/跨进程/视觉声明都必须追加真实终态证据，不能用固定延时或文档推断；
5. 批次结束时更新 `last_verified`、consumer report、删除项和下一切片；
6. 连续两个批次没有真实 consumer，自动转 `dormant` 并删除该抽象。

## 1. 目标模式

VCPChat 不复制 Cordis，也不引入 React/Vue；不重写聊天协议、消息渲染器或 Electron 插件 Loader。目标模式是：保留已有业务 owner，通过 typed UI adapter，把 UI 从“共享旧 DOM + selector + bridge”逐步变成“业务 snapshot/command → Surface/Slot → TypeScript DOM renderer / Web Component kernel”。

```text
上游业务 manager / stream / IPC
              ↓
Domain adapter / snapshot / command
              ↓
VCP UI Runtime 2
  ├── Surface owner（LifecycleScope）
  ├── Slot registry（single/list/keyed/chain）
  ├── snapshot + subscribe（不复制 durable state）
  ├── overlay / focus / async contract
  ├── semantic theme tokens
  └── Native / Web Awesome / fallback provider
              ↓
DOM、Web Components、原生 Electron View
```

### 1.1 与 Harness 的对应关系

| Harness 原则 | VCPChat 目标模式 | 明确不照搬 |
| --- | --- | --- |
| Slot declaration / registration | `VCPUI.runtime2.slots` | 全局 Cordis 容器 |
| Fiber effect | `LifecycleScope` + Surface owner | 每个 DOM 节点一个 fiber |
| Session-scoped props | 领域 snapshot / projection | 第二份聊天 Store |
| Theme service | `ThemeSnapshot` + semantic token presenter | 业务模块读写 `body.classList` |
| React renderer boundary | Native/WA provider adapter | 引入 React/Vue 作为全应用容器 |
| Dispose to quiescence | `SurfaceController.dispose()` + owner scope | fire-and-forget cleanup |

### 1.2 不变量

- 一个动态 Surface 只有一个 owner；owner 负责 listener、timer、observer、overlay、IPC task、临时 DOM 和注册项。
- 注册必须返回 release，并随 owner 撤销；不存在只有测试或展示页消费者的稳定公共 API。
- UI 只读取权威业务状态或只读 projection，不创建第二份 durable state。
- `open → focus → interact → commit/cancel/error → restore focus → teardown` 是所有高频 Surface 的共同合同。
- provider 在 mount 前选择并保持稳定；Web Awesome 失败只能回退到同一视觉/交互合同的 native kernel。
- 目标模式新增代码必须能与现有主窗口一起运行；迁移按 Surface/任务切片，不按文件机械重写。

## 2. 当前事实基线

### 2.1 已有、继续复用

- `LifecycleScope`、`SurfaceController`、`ContributionRegistry`；
- Web Awesome 离线 adapter 与 native fallback；
- 主聊天既有 manager、stream、message renderer、IPC 和插件 Loader；
- 主窗口单一 presentation 收敛结果；
- Electron 操作序列、生命周期压力和真实终态测试。

### 2.2 仍然落后的核心

- `main.html` 仍是页面结构真源；
- `renderer.js` 和 `modules/renderer` 仍有大量全局 DOM 查询和直接写 DOM；
- VCPUI 主要是既有节点增强器，不是可组合的 Slot/Surface runtime；
- 主题、设置和显示状态存在多种相互投射的来源；
- 全局设置只有部分 Harness-style 结构，其他高频 Surface 尚无统一交互合同；
- UI 行为合同和任务级视觉证据尚未覆盖完整高频路径。

### 2.3 当前工作批次

```yaml
batch: R2-02C
mode: target
focus: select-full-state-production-fixture
status: active
production_consumer: global SettingsRoot + Appearance Studio
consumer_kind: internal production consumer; typed adapter migration slice
first_slice: existing settings capability boundary + modules/uiux/adapters/settings.ts
completed_slice: semantic token projection + scope-owned SettingsUiService/RustAssistantUiService assembly + typed SettingsRoot observation, failure/retry/timeout/late-result/teardown evidence
next_slice: Field description/error visual slice is closed. Harness `ui-primitives/Input` currently has no production consumer, so its source-derived fixture is not eligible to unblock the pipeline. Agent Preset Select closed-trigger raw capture is now available and proves the generic VCP Settings Select is not the same trigger contract. The keyboard-open menu now preserves trigger focus in both implementations; VCP's previous selected-item focus transfer and arrow roving were removed because Harness `Menu.tsx` has neither behavior. The Harness busy trigger is reproducibly captured by delaying the real browser-initiated `agentPreset.select` host response after a menu selection; its VCP comparison remains blocked, because no in-scope VCP AgentPreset consumer exists. Do not define an `AgentPresetSeat` provider until a real, in-scope VCP product consumer is identified: current VCP `assistantAgent` is still legacy-owned and field migration is frozen, while chat-side assistant switching is a frozen boundary.
blocked_by: a real, in-scope VCP consumer for the AgentPresetSeat or AgentPresetRow trigger contract; dynamic-wallpaper disabled-manifest UI Apps smoke is external and nonblocking for this slice
excluded: chat-message-internals, plugin-loader, child-page-migration, generic-vdom-before-consumer
last_verified: 2026-08-26
evidence: npm run check:uiux; npm run test:uiux; npm run check:harness-fixture-matrix; npm run check:harness-input-production-consumer; npm run capture:vcp-field-browser-fixture; npm run diff:harness-vcp-field-geometry; npm run diff:harness-vcp-field-pixels; npm run check:harness-field-visual-evidence; npm run capture:harness-select-busy-fixture; npm run check:harness-select-busy-evidence; node --test tests/creation-controller.test.js; node scripts/test-ui-system.mjs; node scripts/test-appearance-studio.mjs; node scripts/test-settings-wa-electron.mjs; npm run test:electron-uiux-theme
```

2026-08-26 target-mode correction：目标工具中的 objective 保持 active 且无法原地改写，因此以本账本作为可执行目标的权威镜像。后续批次不得以“更多字段已迁移”作为单独进度；必须先闭合 Harness reference、Light-DOM contract、真实 consumer、四层等价证据和对应 legacy deletion。聊天渲染/流式/协议/持久化/Plugin Loader 继续冻结。

2026-08-26 target-mode verification：目标收窄后的最小证据集通过：`npm run check:uiux`、`npm run test:uiux`（26/26）、`npm run check:uiux:artifacts`（34 generated files）、`npm run test:uiux:artifacts`、`node scripts/check-settings-source-equivalence.mjs`（legacyClean=true）、`node scripts/test-settings-wa-electron.mjs`（Settings Harness structure gate passed）以及 `npm run guard:chat-kernel-consumers`。本批没有新增字段迁移，未触碰聊天冻结边界。
2026-08-26：新增 `npm run check:harness-reference`，对 reference pack 的 17 个文件、8 个 primitive DOM/geometry 合同执行可重复静态门禁。Forum `adminUsername/adminPassword` 暂不进入施工：全局提交路径仍会编排 Forum 保存，直接接入字段 owner 会形成第二个 command owner；待 dirty/autosave seam 可单一化后再推进。
2026-08-26：Forum `adminUsername` / `adminPassword` 已进入 typed field-owner 阶段：TS Light-DOM Input primitive 提供 32px/8px/8px geometry 与 scope-owned teardown；字段 owner 负责 debounce、save、failure/retry 状态和 close flush，native inputs 与 ForumConfigUiService 保持业务/command source；全局提交路径在 owner 挂载时跳过重复 Forum save。Electron Settings gate 新增两项 primitive DOM 断言并通过；仍需补齐独立 failure/timeout/reload/teardown 证据后，才能删除剩余 legacy orchestration。
2026-08-26 lifecycle correction：Forum owner 已将 `run` 注册到 state，`flushSettingsAutosave()` 现在可以在关闭时真正提交 pending credentials；此前只设置 timer 而未暴露 run 的缺口已修复，`check:uiux`、global save regression 与 Settings Electron gate 通过。
2026-08-26 Forum owner evidence：Settings Electron journey 新增真实 username 输入保存、password close-flush、重新打开持久化恢复断言；`ForumConfigUiService` state 与 Input DOM 均验证通过。failure/timeout 注入和剩余 legacy orchestration 删除仍待独立批次。
2026-08-26：`ForumConfigUiService` 新增确定性的 `timeoutMs` adapter 合同；hung save 会返回 retryable failure，不再依赖文件权限模拟。`tests/uiux-forum-config-adapter.test.mjs` 覆盖 timeout，generated artifact consistency/smoke 与完整 UIUX tests（27/27）通过。
2026-08-26 artifact evidence：`test-uiux-artifact-smoke.mjs` 新增 generated Forum timeout 场景；源码与 generated 平面的 hung-save→retryable-failure 合同均通过。
2026-08-26 primitive contract alignment：TS Input primitive 现在复刻 Harness 的 `wrap → optional icon → input.input` Light-DOM 层级，并优先使用 `--dsw-alias-*` token、保留 VCP fallback；dispose 精确恢复原始 input class/父级。`npm run test:uiux` 27/27 与 artifact consistency 通过。该切片仍不等同于全量 pixel diff。
2026-08-26 renderer-kernel slice：新增 `modules/uiux/runtime/dom-renderer.ts`，提供 scope-owned `mount`、text update 与 keyed insertion/dispose；首次真实 contract test 通过，暂不作为 public runtime API 或通用 Virtual DOM。
2026-08-26 renderer-kernel update：keyed handle 新增 deterministic `update()`，覆盖 reorder/add/remove 后的节点复用与 owner dispose；`npm run test:uiux` 28/28、generated artifact consistency 通过。kernel 仍仅服务 UIUX 内部真实 consumer。
2026-08-26 renderer-kernel portal：`DomRenderer` 新增 owner-bound `portal(node, container)`，支持节点迁移、原位置恢复和 dispose；与 keyed update 一起形成 mount/update/keyed/portal/dispose 最小合同，测试 28/28 通过。
2026-08-26 renderer-kernel listener：新增 scope-owned `listen(target, type, handler)`，dispose 后 listener 不再触发；renderer kernel 最小合同现覆盖 mount/update/keyed/portal/listen/dispose，`npm run test:uiux` 28/28 通过。
2026-08-26 target-mode checkpoint：目标模式继续保持 active，但本阶段验收口径进一步收窄为可测量的 Harness 等价链。Field description/error 节点已通过 `DomRenderer.mount` 接入一个真实 Settings primitive consumer；source-plane bridge 与 generated artifact 已同步，`npm run check:uiux`、`npm run test:uiux`（28/28）、`npm run build:uiux`、`npm run check:uiux:artifacts`、`npm run check:harness-reference`、`npm run check:harness-contracts` 全部通过。该 checkpoint 只证明 renderer kernel 的真实 consumer 接入，不提升为 public runtime 或 pixel-equivalent；下一切片固定为 Input/Field/Select 的固定 viewport DOM/computed-style/state 快照与 diff 自动化，并在证据闭合后删除对应 legacy presentation。
2026-08-26 primitive state contract：新增 Input/Field/Select 的 disabled、selected、error、`aria-describedby` 与 teardown 回滚测试；`npm run test:uiux` 29/29 通过。该证据仍属于 jsdom 行为合同，尚不能替代 Electron 固定 viewport 的 computed-style/pixel diff。
2026-08-26 generated snapshot gate：新增 `npm run check:harness-snapshot`，从 generated artifact 实际挂载 Input/Field/Select，并依据 reference pack 验证 Light-DOM nesting、ARIA、selected state 与 teardown 恢复；该 gate 已通过，明确作为 DOM/state 快照层，后续继续扩展 Electron computed-style 与截图容差层。
2026-08-26 Electron geometry evidence：`test-electron-uiux-theme.mjs` 扩展为读取 generated Input 的 computed `height/gap/padding/borderRadius/fontSize/lineHeight`，并与 Harness geometry reference 断言；重试后 journey 通过。首次启动因本机缺失 VCP-CDS 二进制与 renderer ready 时序失败，保留为环境阻断证据，不计入通过次数。
2026-08-26 Select DOM alignment：Select menu 已从 `list → item` 调整为 Harness 目标层级 `list → viewport → itemWrap → item`，保留 native select、键盘导航、outside-dismiss、portal 和 owner dispose 行为；`npm run test:uiux` 29/29、`npm run check:harness-snapshot` 与 generated Electron journey 均通过。该切片仍未宣称完整 CSS/pixel equivalence，viewport/itemWrap 的最终 geometry 继续由后续 computed-style diff 门禁确认。
2026-08-26 Select token provenance：Select trigger/menu/item/description/error 的颜色改为 `--dsw-alias-*` 优先、VCP token fallback；`check:harness-contracts` 新增 token provenance 检查，UIUX、snapshot 与 Electron artifact journey 全部通过。该变更只影响 UI presentation，不改变 native select 或 Settings command path。
2026-08-26 Select hierarchy evidence：静态 contract gate 与 Electron generated snapshot 现在同时断言 `menu-viewport`、`menu-item-wrap` 层级存在，防止回退到 list 直接承载 item；Electron journey 通过。下一步仍是固定 viewport 截图与像素容差，不把结构证据扩大解释为视觉等价。
2026-08-26 screenshot evidence：Electron generated journey 现在在固定 primitive 场景写出 `uiux-primitive-contract.png` 并断言截图大小超过 1KiB；该证据证明 screenshot capture 可重复执行，但尚未与 Harness reference image 做 pixel diff，暂不提升 equivalence 状态。
2026-08-26 Select CSS provenance：补齐 Harness Menu 的 `viewport`（flex column）与 `itemWrap`（relative）几何语义，并保持 DSW alias token 优先；source/build、contract、29 项 UIUX 测试及 Electron artifact journey 全部通过。
2026-08-26 Select geometry diff：Electron artifact journey 扩展断言 menu `min-width/radius`、viewport `display/flex-direction`、item `gap/radius/font/line-height`，与 Harness geometry reference 对齐；journey 通过。该证据仍是固定场景 computed-style gate，不等同跨页面 pixel diff。
2026-08-26 Select visual delta audit：确认 Harness selected row 的 trailing check marker/透明背景与当前 VCP selected background projection 不同；已登记为下一条隔离 primitive slice，在实现真实 check node 与状态截图前不宣称 pixel equivalence。
2026-08-26 Select selected marker：已新增 Light-DOM trailing `.vcp-harness-menu-item-check`（`aria-hidden`、CSS glyph、selected-only visibility），selected row 改用 Harness interactive hover token，不再依赖 selected fill；UIUX 29/29、snapshot 与 build 通过，Electron generated journey 已加入 selected-marker 断言并通过。
2026-08-26 Select marker fidelity：selected marker 由可访问隐藏的 SVG check node（16×16 viewBox/path）承载，DOM 结构更接近 Harness `IconCheckOutline16`；jsdom 与 Electron marker visibility 断言均通过。
2026-08-26 dual-page pipeline priority：根据最新等价审计，R2-02C 暂停继续迁移 Settings 字段与扩展 renderer；当前唯一阻断任务升级为 Input/Field/Select 双页面 fixture 流水线：真实 Harness fixture + VCP generated fixture，固定 viewport/DPR/font/theme，产出 DOM structural、geometry、contract-scoped computed-style 与 pixel diff 四层报告。现有 VCP snapshot/screenshot 只算单页面证据，不能替代 Harness 对照图。
2026-08-26 fixture matrix scaffold：新增 `fixture-matrix.json` 与 `npm run check:harness-fixture-matrix`，锁定 800×600、DPR 1、system-ui、Input/Field/Select 九个状态及 DOM/geometry/computed-style/screenshot/pixel-diff 五层输出；当前状态为 `harness-vcp-dom-captured-structural-diff-active`，未把矩阵定义误报为 Harness 参考图或 pixel diff 完成。
2026-08-26 VCP DOM capture：新增 `npm run capture:vcp-dom-fixtures`，从 `modules/uiux/generated/` 真实挂载并保存 Input.default、Field.description、Select.open 三组 fixture；`diff:harness-vcp-dom` 首次报告 Input 结构相等、Select 结构不相等，差异报告保留供下一轮对齐。
2026-08-26 Select structural alignment：VCP Select item 已补齐 Harness 对应的 `itemLabel` span 与 selected class；重新 capture 后 structural diff 仍诚实报告 Select 外层 contract 差异（1/2 cases equal），未将局部对齐误报为整体通过。
2026-08-26 structural diff boundary：diff runner 现按 primitive root 比较 Select 双方 `[role="menu"]`，并归一化 CSS-module hash 与 VCP compatibility class；fixture capture 统一 selected=first option。结果仍为 Input 相等、Select 不相等，保留 ARIA/属性差异作为下一轮修正依据。
2026-08-26 Select structural diff closure：Select 已补齐 Harness 的 viewport `role=presentation`、scrollable marker、itemLabel/check 节点及 selected state 属性；diff runner 归一化后 2/2 已捕获案例结构相等（`pass=true`），fixture matrix 状态更新为 `structural-diff-partial-pass`，其余 7 状态与 geometry/style/pixel diff 仍未完成。
2026-08-26 state fixture expansion：Harness 真实组件与 VCP generated artifact 现已各自捕获 Input default/focus/disabled、Select closed/open/selected/disabled；Field description 仅已有 VCP fixture，Field error 与 Harness Field fixture 仍缺。矩阵状态随后更新为 `structural-diff-7-of-9-pass`，不宣称九状态完整。
2026-08-26 Field error fixture：VCP generated capture 新增真实 Field.error（`aria-invalid` + error node）fixture；Harness Field description/error 仍无独立生产 primitive 可直接捕获，尝试手工 fixture 后已撤回，继续保留为 reference 缺口，不伪造对照图。
2026-08-26 state structural diff：`diff:harness-vcp-dom` 扩展到 7 个已捕获状态，结果由 5/7 提升至 6/7 structurally equal；Select closed 已通过按需挂载 menu 的真实生命周期修正，剩余 disabled contract 差异仍保持 `pass=false` 作为修正依据。
2026-08-26 disabled fixture alignment：Select disabled fixture 改为与 Harness 相同的“open menu + disabled item”场景；`diff:harness-vcp-dom` 现为 7/7 structurally equal（`pass=true`）。Field error 与完整九状态仍未完成，pixel equivalence 仍未宣称。
2026-08-26 Input icon fixture：Harness 生产 Input 与 VCP generated Input 均新增 icon 状态；fixture matrix 扩展为 10 cases，当前已捕获并可 diff 的 8 个案例全部 structurally equal。Field description/error 仍缺真实 Harness consumer，因此状态为 `structural-diff-8-of-10-pass`，不宣称完整。
2026-08-26 Harness Field error capture：通过 Harness 生产 `ModelsSection` 的真实 `state.status=error` 分支临时 Vitest capture，生成 `fixtures/harness/field.error.dom.html`；Field error structural diff 现已纳入，9 个可捕获案例中 8 个相等。Field description 仍无稳定独立 consumer fixture，矩阵状态标记为 `structural-diff-8-of-10-pass-field-error-captured`。
2026-08-26 geometry report persistence：Electron generated journey 现在将 800×600 @1x 的 Input+Select computed geometry 写入 `reports/vcp-primitive-geometry.json`，作为后续 Harness↔VCP geometry diff 输入；报告来源标记为 generated artifact，未冒充双页面比较。
2026-08-26 Harness DOM capture：通过 Harness 自身 Vitest/jsdom 生产组件测试临时渲染并保存 `fixtures/harness/input.default.dom.html` 与 `select.open.dom.html`；capture test 已删除，不修改 Harness 源码。CSS-module hash 保留，待 structural diff runner 归一化。
2026-08-26 fixture source audit：确认 Harness 生产组件通过 `packages/client/web` Vite/React 入口和 Vitest/jsdom 测试暴露，没有可直接加载的静态 fixture 页面；新增 `fixtures/README.md` 记录真实 source-of-truth、同内核要求和禁止手工复制 markup 的规则。双页面 capture 仍为当前唯一主线。
2026-08-26 Harness web build probe：在本机执行 `pnpm --dir /Users/asahi/Documents/Codex/deepseek-harness run build:web` 成功（Vite 6.4.3，413 modules）；确认可从生产 web entry 产出浏览器 artifact。尚未生成 primitive-isolated fixture 页面，因此 matrix 状态仍保持 `matrix-defined-harness-capture-pending`。
2026-08-26 Harness component evidence：执行 `pnpm --dir /Users/asahi/Documents/Codex/deepseek-harness exec vitest run packages/client/ui-primitives/tests/atoms.client.spec.tsx packages/client/ui-settings-general/tests/settings-root.client.spec.tsx`，2 个真实 client test files、43 tests 全部通过；该证据确认生产 Input/Menu/Settings 组件可渲染并具备行为合同，但仍不等同 fixture PNG 或跨页面 pixel diff。
2026-08-26 reference gate integration：`check:harness-reference` 现在强制读取 `fixture-matrix.json`，校验 800×600 @1x 与十组状态；reference pack 与独立 matrix gate 均通过，后续 fixture capture 不能绕过固定矩阵。
2026-08-26 fixture readiness gate：新增 `npm run check:harness-fixture-readiness`，只读验证 Harness `apps/web/dist/index.html`、Input/Menu 生产源码/CSS 与 VCP generated browser entry 均存在；该 gate 通过，fixture runner 可在不降级为单页面的前提下启动。
2026-08-26 freeze-boundary audit：最近三项提交仅涉及 UIUX Select、Harness contract/screenshot 脚本和路线文档；`npm run guard:chat-kernel-consumers` 通过（17 个冻结 kernel files），确认未修改 StreamCoordinator/StreamProjection/MessageRenderer、聊天协议、持久化或 Plugin Loader。
2026-08-26 legacy retirement audit：`npm run guard:classic-retirement` 与 `node scripts/check-settings-source-equivalence.mjs` 通过；已迁移 Range/Toggle 字段的 legacy rows、inline styles、CSS selectors 均为 0。`appearance-studio` 对这些 key 的读取仅用于规范化/语义应用，未发现重复 presentation output；该证据支持继续收窄 legacy deletion，但不代表全量 Settings bridge 已退役。

2026-08-26 priority recalibration：根据 Harness 等价审计，施工顺序调整为四层门禁：
1. `reference automation`：reference pack 必须能从固定 viewport 产出 DOM/computed-style/state 快照并生成 diff 报告；
2. `primitive contract`：Input/Field/Select 先完成源码级 DOM nesting、`--dsw-alias-*` token、icon/ARIA/focus 状态；
3. `renderer kernel`：仅实现已有真实 consumer 需要的 mount/update/keyed list/portal/focus/dispose，不提前造通用 Virtual DOM；
4. `legacy deletion`：每个 primitive 证据闭合后删除对应 bridge/projection，未满足前不得继续扩大字段迁移。
Forum 字段当前降级为上述门禁的 consumer 验证，不再单独作为“迁移完成率”指标。
2026-08-26：新增 `npm run check:harness-contracts`，静态对照 Harness Input/Select reference JSON 与 VCP primitive source 的 DOM class、ARIA marker 和 `--dsw-alias-*` token；该门禁通过，作为自动 computed-style/pixel diff 之前的早期 contract drift 检查。

## 3. 分阶段路线

### R2-08：TypeScript UI foundation / scoped service assembly（施工中）

- 范围：`modules/uiux/` 的 typed contracts、UiScope、局部 `UiServiceRegistry`、generated artifact 与已有 Settings/Theme consumers。
- 当前状态：`scoped-service-assembly-active`；UiScope 仍委托 legacy `LifecycleScope`，registry 只服务真实 UI assembly，不是全局插件容器。
- 已有证据：source typecheck、focused service/renderer tests、generated artifact consistency 与 artifact-only Electron smoke。
- 未闭合：独立 runtime 实现、packaged artifact/跨平台证据、完整 Harness fixture equivalence；因此 `public API ready = false`。
- 施工约束：在 R2-02C 双页面 DOM/geometry/computed-style/screenshot/pixel diff 闭合前，不扩展 kernel 能力或新增 public seam。

### R2-00：Chat Surface Slots 目标模式合同（已完成）

目标：在已有 `createChatSurfaceSlots` 原型上建立最小可运行的 Slot 合同，并由真实的 `standalone-chat-history` 内部应用消费。组件库展示页不能单独作为 Stable 公共 API 证据。

必须交付：

- 演进 `modules/chat/chatSurfaceSlots.js`：registration owner、priority、scope、inject、diagnostics，并抽出可声明允许 Slot 集合的 `createSlotRegistry()`；
- 复用现有 `LifecycleScope` / `SurfaceController`，不再创建第二个 Surface runtime；
- Slot registration 的 owner 绑定、release、absence 诊断；
- Slot mount 失败时同步回滚已创建的贡献，异步 disposer 由现有 Surface owner 等待；
- 一个真实生产 consumer；
- Node contract tests 和静态 `node --check`。

退出证据：注册 → 展示 → owner dispose → Slot absent；mount 失败不留 DOM/listener；重复 mount/dispose 结果稳定；主聊天附件按钮保留 DOM identity、事件和 ARIA，并在 Surface dispose 后恢复原父级位置。

### R2-01：Shell / Overlay / Focus 合同

目标：统一 Topbar、Launchpad、Account Menu、通知、Ask Nova 和 Modal 的 open/focus/dismiss/restore 行为。

不新增第二套全局弹窗 Store；在现有 `OverlayCoordinator` 上提供窄的 owner/lease 合同。

当前进度：`OverlayCoordinator.acquire(owner, { restoreFocus })` 已记录 lease 的 focus origin，并在最后一个 owner release 时恢复；global modal visibility 与 CreationController 已共享该路径。EscapeDispatcher 仍负责优先级决策，避免把 Escape 逻辑塞进 OverlayCoordinator。

退出证据：真实 Electron 键盘路径、Escape 优先级、Select 不误关 Modal、关闭后焦点恢复、owner 资源归零。

### R2-02：Settings / Creation 页面模式

目标：将全局设置和 Agent/Group 创建抽象成稳定页面模式，而不是继续复制表单 DOM。

页面模式统一包含：Field、Section、Choice/Select、ActionBar、Error、Autosave/Submit、Dirty 状态。

退出证据：保存成功/失败/取消/迟到结果；输入保留；重新打开读取 durable 值；native/WA/fallback 视觉与键盘合同一致。

当前 SettingsRoot 状态（2026-08-24）：全局 Settings form submit 已通过 `VCPUISettingsBridge.getTypedService().save.execute()` 进入 typed command owner；`SettingsUiService` 与局部 `RustAssistantUiService` 现由 bridge-owned child scope 内的 `UiServiceRegistry` 装配，SettingsRoot 通过 `get('settings-ui')` 与 Rust 控件 consumer 读取；显式 release、owner teardown、逆序 dispose、provider failure rollback、Rust refresh/save 迟到结果隔离与 generated artifact smoke 已有 focused 证据。Rust command failure 现在发布 `vcp-settings-save-result: success=false`，保留 SettingsRoot 打开并进入 retry 状态；global settings 已写入的部分保持 durable，但不会掩盖 Rust capability 的失败。该 registry 只用于 UI service assembly，不接入 Plugin Loader、chat manifest 或全局插件协议。clean external snapshots 现在真实驱动用户身份、assistantAgent 动态 select、服务器 URL、VCP API/File/Log 连接字段、语音 mode/识别器路径/本地与网络 provider、分布式服务/工具注入/思维链/上下文净化/AI 按钮/音乐控制 checkbox、净化深度与可见性、flowlock/middle-click/regenerate controls、chat presentation/layout mode、用户气泡宽度与 stream tuning 及其可见性、摘要模型、Home、Appearance（density/radius/typography/fontScale/contentWidth/surface/sidebar geometry）、字体 preset/custom、聊天气泡和 smooth streaming 控件；checkbox/radio 使用 `checked` 投影，动态 assistant options 通过 MutationObserver 重放 snapshot，sidebar radius radio group、range output（px）与 hidden compatibility select 同步，dirty/in-flight 时仍拒绝外部覆盖。Rust adapter 只消费既有 `getRustAssistantConfig` / `saveRustAssistantConfig` capability，不复制 Rust durable state、不改 IPC/配置格式；global save 已通过该 typed command 路由。`event-listeners.js` 的 Rust 初始填充和 `mainChatSettingsPresentationOwner` 的 Rust DOM projection 在 typed service 可用时均降为 compatibility fallback；`node scripts/test-settings-wa-electron.mjs` 已覆盖 clean projection、失败保存、重试、重载恢复、3 次 repeated reopen 和 owner teardown，`tests/global-settings-save.test.mjs` 覆盖 Rust command failure retry terminal state。其余 legacy projection 仅保留未迁移字段和 Classic compatibility fallback，dirty/autosave 编排仍由 legacy `settings-bridge.js` 与 global settings manager 控制，因此 R2-02 当前是 `typed-production-consumer-active`，不是 complete。

R2-02 退出审计（2026-08-24）：已迁移字段对应的 `mainChatSettingsPresentationOwner` 写入均在 typed service 可用时 gated；forum-config、networkNotesPaths、assistantRuntime diagnostics 均已有独立 typed Surface、失败/迟到/teardown 证据。当前阶段提升为 `typed-production-consumer-active`，但不标 complete：剩余工作是删除已完全覆盖的 legacy bridge presentation 分支、确认 Classic/upstream fallback 没有被 typed assembly 破坏，并继续补 renderer-destroy 及更广泛生命周期证据。`node scripts/test-settings-wa-electron.mjs` 现已通过 60 次 close/reopen，验证 `settings-presentation` 与 `ui-services` 各保持单一 scope、network path 行数稳定、四个 typed services 持续存在，随后显式 renderer teardown 仍能撤销全部 owner；此前超时原因为测试选择器漏查 root 自身，已修正为 `#globalSettingsModal.vcp-harness-settings-root`。本批另修正 readiness marker 的 service/consumer 边界、teardown 撤销、partial-root 与跨 await/root identity race，并加入单元证据；Home visual 的 `showHomeVisualTagline` 已纳入 typed Settings snapshot projection，Settings WA persistence、Appearance Studio 与 Electron Settings gate 均通过。Settings-only 60-cycle stress 通过，但混合全局 lifecycle stress 仍观察到 listener 增长，未将全局生命周期门禁标为通过。

Forum-config 独立 Surface（2026-08-24）：`ForumConfigUiService` 已通过 bridge-owned `UiServiceRegistry` 装配，管理员账号/密码由 typed snapshot 消费，保存由 typed command 路由到既有 `loadForumConfig/saveForumConfig` capability；失败会保持 SettingsRoot 打开并发布 retryable save result。该 adapter 不复制论坛 durable state、不改 IPC 或配置格式。`networkNotesPaths` 也已由 typed snapshot 在 clean form 上幂等重建动态输入行，dirty form 不会被外部 snapshot 覆盖；`assistantRuntime*` 已由只读 `AssistantRuntimeUiService` 消费 runtime status snapshot，旧 diagnostics projection 在 typed service 可用时降为 fallback。

Select projection cleanup（2026-08-24）：Harness Select/Choice 在重建选项 DOM 前会先执行旧 option listener cleanup，避免 detached option listener 随 SettingsRoot refresh/reopen 累积；`node scripts/test-settings-wa-electron.mjs`、`node scripts/test-settings-wa.mjs` 与 `npm run check:uiux` 通过。

Avatar preview projection（2026-08-24）：`userAvatarUrl` 的 SettingsRoot 预览读取已由 typed Settings consumer 接管，上传与 `saveUserAvatar` capability 仍保持在既有业务 owner；Electron gate 覆盖 data-URL 显示与 clear，Classic fallback 保留。

Creation 现状核验（2026-08-24）：`tests/creation-controller.test.js` 8/8 通过，覆盖命令缺失、Surface 部分失败回滚、Web Awesome 失败后的 native fallback、重复 open、kernel 加载期间 dispose、创建失败恢复和迟到完成隔离。完整 `test-electron-ui-apps-smoke.mjs` 当前不能作为 Creation 的 broad evidence，因为它在进入 Creation journey 前被用户禁用的 `VChatDynamicWallpaper/plugin-manifest.json.block` 阻断（`loaded=true, results=[], dynamicWallpaper=false`）；本路线不擅自启用该插件，下一切片将使用独立 Creation Electron journey 补齐真实 Surface 证据。

### R2-03：Theme Runtime 与语义 Token 真源

目标（迁移完成后的门禁）：主题状态只有一个 snapshot owner，组件不再通过 `body.classList` 猜测主题；当前 semantic tokens 已启用，但 legacy theme reads 仍未清零。

退出证据：source → generated artifact → runtime presenter 一致；light/dark/system、壁纸、DPI 和 fallback 矩阵通过。

当前状态：`ThemePresenter` 已根据 snapshot 投射 light/dark semantic CSS custom properties、`color-scheme` 与诊断属性，并由 Scope dispose 恢复旧 token；但 legacy `body.classList` 读取、部分 surface material/control states 仍存在，因此状态仅为 semantic-token-projection-active，不得描述为单一主题真源完成。

### R2-04：Conversation Surface Slots

目标：为 Composer leading/trailing、消息 action、turn tail、tool view 建立局部 Slot；不重写结构化消息内部 renderer。

退出证据：真实聊天入口可挂载/撤销 slot；流式、取消、主题切换、长消息和 renderer reload 不产生孤儿贡献。

### R2-05：Apps / Embedded Surface

目标：Launchpad、AppTabHost、WebContentsView 和内部 App 统一使用 Surface/Slot contract。

退出证据：注册、打开、激活、reload、crash、注销、tab/session 恢复后，DOM、View、IPC task、listener 和 registry 对账归零。

### R2-06：高频任务与可访问性证据

目标：将 `open → focus → interact → terminal → teardown` 固化为任务级 Electron 测试和视觉基线。

退出证据：主窗口高频路径可仅用键盘完成；ARIA 与真实 DOM 同步；主题、DPI、窗口尺寸、reduced-motion 和 fallback 有矩阵记录。

### R2-07：条件式业务子页面演进

只在某个 Notes/Translator/Forum/Memo 页面存在真实需求时迁移。每个页面必须独立提交 consumer、runtime、teardown、Electron 证据；不以“全站统一”为理由提前迁移。

## 4. 已完成施工记录：R2-00 第一切片

第一切片有意保持很小：它不改主聊天、不改插件 Loader、不替换现有 `VCPUI.create()`，只把已有聊天 Slot 原型推进到目标模式合同，并由 standalone-chat-history 作为第一个真实 consumer。

目标 API：

```js
const slots = createChatSurfaceSlots();
const release = slots.register('chat.composer.leading', 'voice', mount, {
  owner: scope,
  priority: 20,
  scope: 'session-maybe',
});
const owned = slots.mount('chat.composer.leading', host, snapshot, { scope });
```

本切片的 API 仍是内部目标模式，不进入 `window`，不注册新的全局 registry kind。未来 R2-08 的 TypeScript foundation 只提供 typed service/scope adapter；不得平行创建第二套 Slot/Surface 实现，也不得用 `createUiRuntime2()` 之类的空 facade 代替真实 consumer。

## 5. 证据与门禁

| 变更轴 | 最小证据 | 扩展证据 |
| --- | --- | --- |
| Slot/Surface kernel | Node contract tests + `node --check` | UI System + Electron app |
| Settings/Overlay | focused tests + real DOM terminal | Electron keyboard/task journey |
| Theme/token | source/artifact static gate | light/dark/DPI/GPU screenshots |
| Chat slots | stream/owner tests | main chat sequence + reload/crash |
| Embedded App | controller tests | lifecycle stress + packaged smoke |
| Cross-platform claim | 不得只用单机替代 | Windows/macOS + manual soak |

## 6. 明确非目标

- 不引入 React、Vue、Cordis 或全应用插件容器；
- 不重写聊天协议、消息节点、流式渲染、VCPTool 或动态壁纸；
- 不通过隐藏 Classic 控件 `.click()` 作为命令总线；
- 不把所有既有业务状态复制进 UI Store；
- 不为了视觉一致一次性迁移所有 Classic 子页面；
- 不把组件库独占展示页消费者直接升级为 Stable 公共 API；
- 不以单台机器绿色测试宣称跨平台、打包或人工 soak 完成。

## 7. 动态更新规则

- 每个施工批次使用唯一 `batch` 编号；完成后保留证据链接和实际代码入口。
- 新增公共 API 必须同时写出 producer、consumer、owner、release 和测试；否则保持 internal/candidate。
- 若一个阶段连续两个批次没有真实 consumer，回退到 `planned` 并删除空 runtime。
- 每次迁移都记录“新增、删除、保留”三张表，优先净删除 selector、facade、重复状态和 bridge。
- 发现跨越业务、provider、主题、生命周期多个轴时，拆成多个批次，除非它们不可分割。

## 8. 当前下一步

1. R2-02C 已完成 Agent Preset Select closed-trigger 的双页面原始采集：Harness production seat 为 `148.78125×28`，VCP generic Settings Select 为 `218×40`，因此 DOM/geometry 不同且像素截图不可比。下一步不是压缩通用 Select，也不是定义仅供截图的 `AgentPresetSeat` provider。先决条件是一个真实、未冻结的 VCP product consumer：当前 `assistantAgent` 仍由 legacy `settings-bridge` 管理且字段迁移已暂停，聊天侧切换又属冻结区；满足前该 trigger state 保持明确 unresolved。
2. `AgentPresetSeat` 的 `state.busy` disabled trigger 是独立生产状态：只有建立稳定、可重放的 busy route 后才采集和比较。当前的 disabled Menu item 仅保留为 `MenuItem.disabled` 源码合同/DOM fixture，绝不计入 Agent Preset 生产视觉闭合。
3. `ui-primitives/Input` 没有生产 consumer，只保留 source/DOM contract 与 consumer inventory；不得制造 Input production fixture、不得将它作为 R2-02C 的退出条件，也不得以此扩展 renderer kernel。
4. 已暂停 Settings 字段迁移、renderer kernel/new primitive、Theme legacy-read 清理，以及 Workspace/Shell/Overlay/Apps/Chat Surface 迁移。`check:harness-pixel` 只能在具有真实同语义 production fixture 的状态集上汇总四层命令；不得用 PNG 存在检查或源码 fixture 充数。
5. 每个真实 primitive/state 的四层证据闭合后，才可删除其对应 legacy presentation；R2-02C 关闭后才推进 R2-03 的 Theme legacy reads 清零。
6. R2-08 继续保持 scoped-service-assembly-active：`UiServiceRegistry`、generated artifact 与 `LifecycleScope` 委托均保留现状；在补齐 packaged artifact/跨平台证据前，不声明 public runtime ready。
7. 保持 R2-00/R2-01 的能力由真实 consumer 驱动，不开放任意 selector/HTML 注入，也不创建第二套生命周期或 durable UI Store；Plugin Loader 与 chat plugin protocol 保持冻结。

补充门禁记录：本批补回 `nextUiNotificationForum` / `nextUiNotificationMemo`，并让 NextShell controller 成为唯一 owner；旧 `event-listeners.js` 中对应的重复 document-level binding 仍保持注释隔离。Plugin Loader 与 chat plugin manifest 的越界改动已回退，UI Runtime 只消费既有插件能力；完整 UI Apps smoke 仍受 `VCPDistributedServer/Plugin/VChatDynamicWallpaper/plugin-manifest.json.block` 外部 readiness blocker 影响，本轮不擅自启用用户禁用插件。

R2-02 failure contract 增量（2026-08-24）：Forum typed command 的显式失败与异常、头像文件保存的显式失败与读取异常，均发布 retryable `vcp-settings-save-result: success=false` 并终止当前提交事务；对应回归证据位于 `tests/global-settings-save.test.mjs`。该增量不改变头像、设置或 IPC 数据格式，也不影响 legacy bridge 的剩余迁移职责。

R2-02 timeout/late-result 增量（2026-08-24）：typed Settings save 超时现在调用 `cancelPendingSaves()` 失效当前 generation，迟到 IPC 结果不能重新发布 Settings snapshot；generated artifact consistency、artifact smoke 与 Electron Settings journey 均通过。该能力仍属于迁移期 Settings service，不代表 legacy bridge 已退役。

R2-02 projection simplification（2026-08-24）：删除 Settings typed projection 表中重复的 `enableUserChatBubbleUi` 映射；行为保持不变，避免同一 consumer 对同一控件执行重复投影。Electron Settings journey 与 UIUX type check 通过。

R2-02 retry-chain 增量（2026-08-24）：timeout cancellation 现在同时切断 bridge 内部未完成的串行 save chain，并撤销旧请求的 external snapshot publication rights；重试不会继续排在永久挂起的旧 IPC 后面。typed adapter、generated artifact 与 Electron Settings evidence 均通过。

Stress evidence refresh（2026-08-24）：`VCPCHAT_STRESS_CYCLES=5 VCPCHAT_STRESS_WARMUP=1 npm run test:electron-lifecycle-stress` 仍在 checkpoint 处失败，listeners 从 baseline 579 增至 609（+30），但 lifecycle scopes/resources、connected elements、detached roots/icons/options 均稳定。该混合场景包含多个非 Settings Surface，不能据此归因或宣布 Settings failure/retry + teardown complete。

Lifecycle attribution harness（2026-08-26）：`test-electron-lifecycle-stress.mjs` 新增 `VCPCHAT_STRESS_STAGES`（可独立选择 `ask-nova,settings,agent-settings,embedded,detached-app,mode-round-trip`）及 opt-in `VCPCHAT_STRESS_TRACE_LISTENERS=1` target/type/stack 追踪，默认完整矩阵与阈值不变。追踪确认每轮 +4 来自 `mountHarnessDisclosures()` 对同一 `.style-collapse-header` 重复注册 click/keydown；原因是 `disclosureStates` 保存 state record 却用 `Set.has(container)` 判断。修复为按 container 查找既有 state 后，`VCPCHAT_STRESS_STAGES=settings VCPCHAT_STRESS_TRACE_LISTENERS=1 VCPCHAT_STRESS_CYCLES=3 VCPCHAT_STRESS_WARMUP=1 VCPCHAT_STRESS_CHECKPOINT_EVERY=1 VCPCHAT_STRESS_SKIP_PREFLIGHT=1 npm run test:electron-lifecycle-stress` 结果稳定为 `585 → 585 → 585`；仅保留 Web Awesome runtime 的两个全局 listener，nodes、connected elements、managed lifecycle scopes/resources、detached roots/icons/options 全部稳定。Settings listener attribution gate 现已通过；混合全局 stress 与其他 Surface 仍需独立归因。

Settings-only stress evidence（2026-08-24）：`VCPCHAT_SETTINGS_REOPEN_CYCLES=60 node scripts/test-settings-wa-electron.mjs` 通过；60 次 close/reopen 均保持单一 `settings-presentation` 与 `ui-services` scope、稳定 network path 行数和四个 typed services，随后显式 teardown 撤销全部 Settings owner。该证据支持 Settings Surface 自身稳定，但不替代混合全局 lifecycle stress。

R2-02 readiness-boundary 修复（2026-08-24）：legacy Settings owner 不再把“typed service 已装配”误当成“SettingsRoot consumer 已挂载”；现在以真实 `vcpSettingsRevision` projection marker 判定 typed takeover。service 预装配/partial mount 时保留 legacy 初始化，Forum/Rust/runtime fallback 同步遵守该边界。owner 单测、UIUX type check 与 20-cycle Electron Settings journey 通过。

R2-02 marker teardown 修复（2026-08-24）：typed consumer disposer 现在同步撤销 `vcpSettingsRevision` / `vcpSettingsSource` readiness markers，避免复用 root 在 service 不可用时把旧 marker 误认成活跃 consumer；Electron teardown gate 已断言 marker 为 null。

R2-02 partial-root 修复（2026-08-24）：typed projection 只有在 `#globalSettingsForm` 存在时才写入 readiness marker；malformed/partial SettingsRoot 不会被 legacy owner 误判为已接管。Settings Electron gate 与 UIUX type check 通过。

R2-02 async-readiness 修复（2026-08-24）：`syncGlobalSettingsToUI()` 在 Forum IPC 与 assistant options 两个 `await` 边界重新读取 typed consumer readiness，避免 consumer 中途挂载后 legacy owner 继续用过期状态覆盖 typed projection。owner 单测、Electron Settings gate 与 UIUX type check 通过。

R2-02 root-identity 修复（2026-08-24）：readiness refresh 不再捕获旧 SettingsRoot 引用；每次跨 await 检查都重新解析当前 modal root，避免 reload/reopen generation 使用已替换 DOM 的 marker。owner 单测、10-cycle Electron Settings journey 与 UIUX type check 通过。

UI System gate audit（2026-08-24）：`npm run check:ui-system` 当前在 `guard:design-subtraction` 阶段失败；大量既有 UIUX/Settings 文件相对旧 baseline `b5931a69...` 未登记，且另有 `styles/themes.css` composer focus contract 报告。该失败不能归因于本批 Settings readiness 修复，也不能通过扩大 allowlist 或重写 baseline 伪造绿色；发布门禁缺口保持独立记录。

可归因子门禁复核（2026-08-24）：`check-ui-async-state-matrix`（5 surfaces × 6 states）、`check-ui-task-journeys`（7 journeys）与 `check-theme-provenance` 均通过；因此当前 Settings readiness 变更的异步状态/任务旅程/主题来源子证据保持绿色，总门禁失败仍限于 baseline/design-subtraction 账本缺口。

Artifact runtime refresh（2026-08-24）：`build:uiux`、`check:uiux:artifacts`、`test:uiux:artifacts` 与 `test:electron-uiux:artifacts` 均通过；generated 20 文件一致，Electron generated theme journey 的 light → dark → reload light 与 subscriber teardown 合同通过。

Settings source-boundary refresh（2026-08-24）：`check-settings-source-equivalence.mjs` 与 `check-settings-unified-surface.mjs` 均通过；shell source equivalence、retired bridge owners、Harness geometry 和 legacy rows/inline styles/selectors 均保持绿色。该证据仍不等同于 legacy Settings bridge 全部退役。

R2-02 network-path consumer 增量（2026-08-24）：`networkNotesPaths` 的 typed projection 现在由 Settings bridge 自己创建/删除 Harness row；Add 按钮优先走 `VCPUISettingsBridge.addNetworkPathInput()`，legacy `uiHelperFunctions.addNetworkPathInput()` 仅保留 capability 不可用时的 fallback。Electron gate 新增 Add/Remove 行证据，60-cycle Settings-only stress 也通过；source-equivalence、unified-surface 与 UIUX type check 通过；字段名和持久化格式未改变。

账本校准（2026-08-24）：本节早期 R2-02 段落中的“3 次/10-cycle repeated reopen”属于历史记录；当前权威 Settings-only 证据为 60 cycles，详见上方 stress evidence 与 network-path consumer 增量。状态仍为 `typed-production-consumer-active`，不标 complete。

R2-02 late-command 修复（2026-08-24）：`VCPUISettingsBridge.addNetworkPathInput()` 在 bridge dispose 后拒绝 late command；Electron teardown gate 已验证 disposed Settings owner 不会被 late network-path row command 复活。

R2-02 URL capability fallback 修复（2026-08-25）：legacy owner 对可选 `completeVcpUrl` capability 改为 capability-aware 调用；缺失时保留 authoritative snapshot 原值，不再因 typed consumer 未挂载而抛异常，也不在 UI 层复制 URL 规范化规则。Settings owner、WA persistence 与 UIUX type check 通过。

R2-02 path-listener ownership（2026-08-25）：network path Add 兼容监听改用 renderer `listenerOwner` 注册，继续优先 typed bridge capability、无 capability 时才 fallback 到旧 helper；Settings Electron gate 与 UIUX type check 通过。

R2-02 post-abort verification（2026-08-25）：上一轮中断后工作树保持干净；`VCPCHAT_SETTINGS_REOPEN_CYCLES=60 node scripts/test-settings-wa-electron.mjs`、source-equivalence、unified-surface 与 UIUX type check 均重新通过。

R2-02 assistant-options capability 修复（2026-08-25）：legacy owner 对不存在于仓库稳定实现中的 `populateAssistantAgentSelect` 改为可选 capability 调用；缺失时保留现有 options 并继续 typed snapshot projection，不再中断 Settings 初始化。owner tests、WA persistence、Electron Settings gate 与 UIUX type check 通过。

Harness 等价链施工校准（2026-08-26）：当前主线固定为 Harness↔VCP 双页面 fixture 对照流水线；R2-02C Settings 字段迁移与 renderer kernel/新 primitive 扩展暂停，直到 DOM structural、contract-scoped computed-style/geometry、固定 viewport screenshot 与 pixel diff 四层证据闭合。现有 10-case matrix 中 9 个案例已有可比较 fixture，8 个结构相等；`field.error` 已捕获真实 Harness `ModelsSection` error branch 但与 VCP Field error 语义不同，`field.description` 尚无稳定真实 Harness consumer，因此 `npm run diff:harness-vcp-dom` 保持 `pass=false`（8/10，1 pending），禁止手工伪造 fixture 或宣称 pixel-equivalent。下一施工批次只允许建立 Harness/VCP 双页面 computed-style/geometry capture 与 diff 输入；在四层证据完成前不得扩大 Settings 字段、renderer 或 Chat/Overlay Surface 范围。
Harness geometry gate scaffold（2026-08-26）：新增 `npm run diff:harness-vcp-geometry` 与 `reports/harness-vcp-geometry-diff.json`。该门禁将 VCP generated Electron geometry 与 Harness reference contract 做显式逐属性检查（CSS shorthand canonicalization 后当前 14/14 contract checks 通过），同时把 Harness 浏览器 computed-style capture、跨页面 geometry diff、screenshot/pixel diff 标为 pending；因此单页 VCP geometry 不再被误报为 Harness 等价证据。下一步必须提供 Harness production browser capture 后才能将此门禁提升为双页面 computed-style diff。
Harness production browser capture（2026-08-26）：通过 `pnpm dsh web --host 127.0.0.1 --port 4173` 启动真实 Harness web production entry，并新增 `npm run capture:harness-browser-geometry`，捕获 API Key Input 的 DOM、computed style、800×600 @1x 截图。双侧输入现已接入 geometry diff；Input/Select 14/14 contract checks 通过，computed-style 仍明确标记为部分覆盖（Harness Select browser capture与完整跨页面 pixel diff 尚缺）。捕获过程中发现并修正 VCP inner Input 缺失 `padding: 0 10px` 的真实视觉差异；artifact consistency 与 Electron UIUX journey 重新通过。
Harness Select capture boundary（2026-08-26）：capture runner 现会在真实 production 页面中探测 `select`/`[role=combobox]` 并记录其 DOM、rect 与 computed style；当前 Harness 首屏因未配置 workspace 只暴露 API Key Input，Select capture 明确为缺失而非降级伪造。geometry 报告继续将 Select browser capture 与完整跨页面 pixel diff 列为 pending，待通过真实 workspace fixture 或受控 production route 采集。
Harness Select production-route audit（2026-08-26）：审查 Harness 官方 `apps/web/tests/agent-preset-selection.e2e.ts` 确认 Select/Menu 的真实 production 场景需要 `launchWebScaffold({ agentPresets })` + `connectFreshWorkspace()`，随后点击 `Standard mode` 并读取 `[role=menu]`。尝试从仓库外部直接导入 scaffold 会触发 Vitest worker/package 运行时约束，临时 capture 未产生可信 fixture，已删除；因此当前仍保留 Select browser fixture pending，不把 source-level E2E 代码当作浏览器截图证据。
Harness Select capture retry（2026-08-26）：在 Harness E2E 扫描路径中复用官方 scaffold，并修正 `agentPresets.roots` 为 `{ path, trust }` 形状；随后 Chromium executable/Playwright 运行仍在当前环境中挂起，未生成 fixture，进程已终止且临时测试已删除。该失败属于环境/runner closure 证据，不改变 Select browser fixture 的 pending 状态，也不修改 Harness 源码。
Harness Select browser dependency audit（2026-08-26）：再次在官方 E2E 配置下执行临时 capture；系统缓存的 Chrome for Testing 缺少对应 Framework 二进制，Playwright 在 `browserType.launch` 阶段 abort，未进入 scaffold/page capture。临时测试已删除，失败原因与报告保留在本账本；需补齐与 Playwright 版本匹配的浏览器 runtime 或使用 Harness 官方 CI runner 后，才能取得真实 Select PNG/DOM/style fixture。
Harness Select executable fallback audit（2026-08-26）：改用系统 `/Applications/Google Chrome.app` 作为 Playwright executable 重新执行官方 scaffold capture；runner 在 Vitest worker 中仍未完成页面初始化并被超时终止，未产生 Select fixture。该结果说明缺口不只在浏览器二进制，也包括 Harness scaffold 的可独立运行 closure；临时测试已删除，Select fixture 继续 pending。
Harness Select Puppeteer closure audit（2026-08-26）：尝试在官方 E2E worker 内使用 VCPChat 已验证可启动的 Puppeteer Chromium，并按 `connectFreshWorkspace` 的 DOM 操作复现 production flow；`launchWebScaffold`/worker 仍未在限定窗口完成初始化，未生成 fixture。临时测试已删除；这进一步确认需要 Harness 官方 E2E 环境或预封装 capture command 才能取得可信 Select browser evidence。
Harness pixel diff runner（2026-08-26）：新增 `npm run diff:harness-vcp-pixels`，内置无额外依赖的 RGB/RGBA PNG 解码与逐像素指标，读取固定 800×600 截图并输出 `reports/harness-vcp-pixel-diff.json`。当前两张图尺寸一致但语义页面不同，报告诚实记录 `differingRatio=1`、`pass=false`，并将 same semantic fixture route、pixel tolerance 与 reviewable diff image 列为缺失证据；该 runner 不是 pixel-equivalent 宣称。
Pixel diff artifact（2026-08-26）：pixel runner 现额外生成 `reports/harness-vcp-pixel-diff.png`（红色差异掩码），使失败比较可人工复核；当前仍因 Harness/VCP 不是同语义 fixture 而保持 `pass=false`。
Pixel policy/schema gate（2026-08-26）：新增 `docs/reference/deepseek-harness-primitives/pixel-policy.json`，固定 800×600 @1x、`maxDifferingRatio=0.01`、`maxMeanChannelDelta=2` 与 semantic-fixture-required；新增 `npm run check:harness-vcp-evidence-schema`，确保 geometry/pixel 报告在证据不足时显式保持 pending/non-pass。该策略已定义但尚未用于等价页面放行。
Pixel semantic gate tightening（2026-08-26）：`diff:harness-vcp-pixels` 现在读取 geometry 报告的 `semanticFixture.same`；当页面语义未证明一致时直接输出 `semantic-fixture-pending`，不再把不同页面的逐像素差异统计成等价比较。固定 viewport、tolerance 与 reviewable diff 仍保留为后续同语义页面的放行条件。
Harness Select source evidence gate（2026-08-26）：新增 `npm run check:harness-select-source-evidence`，校验官方 `agent-preset-selection.e2e.ts`、生产 `Menu.tsx` 与 CSS 均存在，并确认 `connectFreshWorkspace → Standard mode → [role=menu] → menuitem` 的真实交互链。当前 gate 通过，但 browser fixture 仍为 pending；source-level production interaction coverage 不等于浏览器 computed-style 或 screenshot 证据。
Harness Select production fixture captured（2026-08-26）：Playwright Chromium 1228 runtime 安装完成后，官方 E2E scaffold 成功执行 `connectFreshWorkspace → Standard mode → [role=menu]`，生成 `fixtures/harness/select.production.dom.html`、`select.production.png` 与 `reports/harness-select-production.json`。Menu 真实 production geometry 为 list `padding=4px`、`borderRadius=12px`、`minWidth=218px`，4 个 menuitems 的 computed geometry 已保存。该 fixture 是 Select-only 场景；VCP 当前 capture 仍为 Input+Select，因此 semantic fixture 未合并，pixel diff 继续 pending。
VCP Select-only fixture captured（2026-08-26）：generated-artifact Electron runner 已重新捕获只包含 `.vcp-harness-menu-list[role=menu]` 的 4-item Select 场景；历史误抓 legacy sidebar menu 的 report 已被替换并通过 provenance gate。Harness 与 VCP 现均具备 4-item Select fixture，geometry report 的 `semanticFixture.same=true`，因此 pixel diff 已进入真实同语义比较；当前 `status=compared` 但 `pass=false`（differingRatio 约 0.989、meanChannelDelta 约 13.97），差异图已生成，说明页面定位/整体场景仍未达到像素容差。该批次只闭合了 semantic route，不得宣称 geometry/pixel equivalence，也不得删除 Select legacy path。
Select primitive contract increment（2026-08-26）：VCP Select 已补齐 Harness production Menu 所需的描述层级（label → name/description）、portal 菜单的 fixed anchor 定位与 trigger-width sizing，并重新生成 36 个 UIUX artifact 文件。当前 capture runner 的历史 host 定位仍需独立修正，最新截图尚不能作为 viewport geometry/pixel 证据；在 runner 修正并重捕获前，geometry/pixel 继续保持 non-pass，Select legacy path 不得删除。
Select geometry closure（2026-08-26）：修复 portal open 顺序（先读取 anchor，再 portal/定位/显示），并让 fixture runner 按唯一 `aria-controls` 读取菜单、promote 同步 PNG。新的 VCP Select rect 为约 `198.86,218,334×370`，4 个 item rect 与 Harness 在 1px 容差内一致；逐 rect/style geometry diff 已标记 `cross-page-select-geometry-equivalent` 且通过。ROI pixel diff 现为真实同语义、focused-selected 状态比较，`differingRatio` 约 `0.358`、`meanChannelDelta` 约 `9.42`，仍未达到 1%/2 通道门限；差异主要集中于菜单文字、focus fill 和视觉 token，Select legacy path 继续保留。
Select same-engine visual fixture（2026-08-26）：新增 Playwright Chromium VCP browser fixture，与 Harness 使用同一 browser engine、viewport 和 device scale；Electron fixture 继续作为 generated-artifact runtime evidence。同步 Harness base antialiasing、production token、font stack、hover state 和 check path 后，Select ROI pixel diff 为 `differingRatio=0.000599`、`meanChannelDelta=0.00308`，在既定 1%/2 门限内 `pass=true`；raw threshold 分布仍保留在 report，未放宽 pixel policy。
Select production takeover / legacy deletion（2026-08-26）：六个 Appearance Select 现在先由 typed primitive mount并设置 owner marker，legacy `mountHarnessSelects()` 仅按 marker跳过，不再维护字段 id bypass；两处 legacy reclassification也排除 typed owner。production consumer启用 body-level portal，旧 Settings trigger/native selector收窄到 `.vcp-harness-select-wrap`，不再覆盖 typed primitive。Electron gate明确验证 typed portal DOM、40px/10px geometry以及六个字段均不存在 legacy Select wrapper；其余未迁移 Settings Select继续由 legacy owner负责，因此只关闭 Select vertical slice，不宣称整个 Settings Surface complete。
VCP Select fixture validation（2026-08-26，历史记录，已 supersede）：证据 gate 要求 VCP Select report 的 DOM 必须包含 `.vcp-harness-menu-list`，并拒绝错误捕获的 legacy sidebar menu；当时的历史 report 为 `pending-invalid-or-missing`。后续 Electron Select-only 与同引擎 browser fixture 均已重捕获并通过 provenance gate，以本节后续的 Select same-engine visual fixture 和 production takeover 记录为准。
施工游标校准（2026-08-26，历史记录，已 supersede）：当时 Select vertical slice 的 DOM、跨页面 geometry/computed-style、同引擎 screenshot/pixel 与六字段 production legacy-wrapper deletion已闭合，而 Field 仍待双页面对照。后续 `Field.description/error` 已在 1680×1000 production fixture 闭合，Input 已审计为无 production consumer，当前唯一未决的 Select 状态为 trigger/closed、keyboard focus ownership 和可重放的 busy-trigger disabled；不得把本条的旧 Field/Input 施工顺序作为当前计划。
Field production baseline correction（2026-08-26）：审计确认旧 `fixtures/harness/field.error.dom.html` 实际来自 `ModelsSection` 加载失败区，不是 Field primitive，不能作为 VCP inline field error 的等价真源。现改由 Harness `ui-settings-plugins` 生产 `ValueField` 通过仓库自身 Vitest/jsdom 渲染 description 与 invalid 两态；临时 capture test 已删除，Harness 工作树仅保留原有用户未跟踪 Select capture 文件。新的 DOM diff 仍为 8/10，但现在两个 Field case 都是同语义 production baseline 的真实失败：Harness contract 为 `field → head → label → input → p(hint|invalid)`，VCP 当前缺少 head 层、使用不同 hint/error tag/class，并在 description fixture 中混入 Select consumer。下一批必须先确定并实现 Field Light-DOM contract，再建立 browser computed-style/geometry/pixel evidence；不得通过 normalize 规则隐藏结构差异。
Select portal lifecycle correction（2026-08-26）：独立审查发现 production `portal:true` 初版只在 open 时测量一次 anchor，未达到 Harness 对 nested scroll/resize tracking 与 12px viewport clamp 的合同。`mountSelect()` 现由同一 UiScope owner 在 capture-phase scroll 和 window resize 时重新测量 trigger，并按 menu 实际尺寸夹紧；focused interaction test 覆盖 anchor 移动、右/下边界 clamp 与 dispose，generated artifact consistency 通过。证据措辞同步收窄：现有 pixel pass 仅证明 open/selected/hover 的 Select menu ROI，不包含 trigger、closed/disabled 全状态截图；完整 Select primitive pixel closure 仍是 `R2-02C-VISUAL-EQUIVALENCE` 后续门禁，不能由当前 ROI pass 代替。
Field DOM contract correction（2026-08-26）：VCP Field 已对齐 Harness `ValueField` 的真实 Light-DOM：`field → head → label → control → p(hint|invalid)`；valid/invalid control class 互斥，保留 label `for` 与 invalid `aria-invalid`，不再加入 Harness 真源不存在的 `aria-describedby`。VCP fixture 改用 native text input，而不是将 Field 基线与 Select composite 混为一体；description/error 两个结构 diff 均通过。重新捕获也暴露旧 Select fixture 已过期：当前 generated Select 的 `itemLabel → name` 嵌套与既有 Harness reference 不同，open/selected/disabled 三态因此诚实失败，矩阵从 8/10 校正为 7/10。不得用 DOM normalizer 隐藏此结构差异；下一步先决定 Select label contract 是对齐 Harness 或更新真源，再开始 Field browser style/geometry/pixel 证据。
Field production-consumer verification（2026-08-26）：Settings Electron journey 的前段已通过真实 Appearance Select 的 Field/portal-menu/geometry contract；完整 journey 在既有“保存失败后点击 retry”步骤停留于 `error`，第 667 行等待 `saving|saved` 超时并伴随 `ERR_FILE_NOT_FOUND`。该路径不读取 Field DOM，不能归因为本次结构改动，也不得被计作完整 Settings save/retry 绿色证据；Field 本批依据为 focused primitive test、generated artifact consistency、fixture DOM diff 与 Electron production DOM preflight，保存/retry gate 保持待独立诊断。
Select contract correction（2026-08-26）：审计证实静态 Harness Menu fixture 与 production Agent Preset fixture是两种合法 label contract：无 description 时 `itemLabel` 直接承载文本；有 description 时为 `itemLabel → content → name/description`。VCP Select 改为按 option description 选择对应结构，并为 content 恢复 column layout；重新生成后 10-case DOM matrix 为 10/10 structural pass。该通过仅表示 DOM structural 层，production Agent Preset 的同引擎 geometry/pixel 与完整 Select states 仍须单独保留/扩展，不将其误写成全矩阵视觉等价。
Field browser capture audit（2026-08-26，历史记录，已 supersede）：确认 Harness 真实 `ValueField` production consumer 是 web `plugin-config` E2E 的 Settings → Plugins → Bash card。临时 capture 使用同一 web scaffold 启动成功，但未像官方 E2E 一样先等待 `[class*=frame]`，在 Settings button 出现前超时；未生成或保留任何 fixture。后续真实 production capture 已在下条完成，本条不再定义当前 viewport 或下一步。
Field dual-page visual closure（2026-08-26）：真实 Harness `plugin-config` 生产路径已采集 ValueField description/error 两态（1680×1000 @ DPR 1；800px 下 Settings 入口不可达），VCP 侧由 `modules/uiux/generated/browser-entry.js` 直接挂载同一 Light-DOM fixture。`capture:vcp-field-browser-fixture`、`diff:harness-vcp-field-geometry`、`diff:harness-vcp-field-pixels` 与 `check:harness-field-visual-evidence` 现构成独立证据链：两态 contract-scoped computed-style/geometry 均通过；description 的像素差异为 0；error 为 differingRatio `0.0038522`、meanChannelDelta `0.31024`，均低于既定 `0.01` / `2` 阈值。对齐实现保留 Harness 当前 invalid control 的浏览器默认样式异常，不以源码推测覆盖 production capture。该闭合仅覆盖 Field description/error，未放行新的 Settings 字段迁移或全 Field 状态完成声明。当前唯一视觉工作为 Agent Preset Select trigger/closed；busy-trigger disabled 仅在其生产路径可稳定重放后纳入，Input production visual matrix 继续 blocked。
Input production-consumer audit（2026-08-26）：对 Harness `packages/client` 与 `apps/web` 的 TypeScript import plane 进行精确 inventory，`ui-primitives/Input.tsx` 当前只有源文件、export 与 atom test 引用，没有 production consumer。此前 `API 密钥` Settings input 是另一套手写控件，不能作为 Input atom 的 browser fixture。新增 `check:harness-input-production-consumer` 固化此结论；Input 保留 source/DOM contract，但其 production visual matrix 标记为 blocked。R2-02C 随即回到有真实 agent-preset production consumer 的 Select trigger/closed/disabled 状态，Settings 字段迁移与 renderer 扩展继续暂停。
Select closed-trigger raw baseline（2026-08-26）：新增 `capture:harness-select-trigger-fixture`、`capture:vcp-select-trigger-browser-fixture` 与 `diff:harness-vcp-select-trigger`。两端均由同一 Chromium、`800×600@1x` 和相同 `Standard mode` 语义 fixture 生成；Harness 真实 `AgentPresetSeat` 为 `148.78125×28`、`padding=0 8px`、`gap=4px`、`border=0`、`radius=16px`，并包含 agent icon + chevron；VCP 通用 Settings Select trigger 为 `218×40`、`padding=8px 10px`、`gap=8px`、`border=1px`、`radius=10px`，且无相应 slots。报告因此诚实为 DOM/geometry non-pass，像素为 `pending-trigger-dimension-mismatch`。这证明二者不是同一 trigger contract：不得为通过 Agent Preset fixture 而修改已闭合的 40px Settings Select。进一步审计确认 Harness 的 Settings `AgentPresetRow` 是独立的 `36px` pill 合同；VCP `assistantAgent` 仍由 legacy `settings-bridge` 填充/观察，尚未成为 typed `mountSelect` consumer。由于本阶段冻结 Settings 字段迁移和 chat-side assistant switching，当前没有合法 VCP production consumer 承载 seat/row trigger。该 state 因此保留 unresolved，不引入 fixture-only provider。
Select open-menu source closure（2026-08-26）：`capture:harness-select-fixtures` 现由 VCP 仓库内的外部 E2E fixture 同时重放 closed trigger 与 open/selected menu；它复用官方 `launchWebScaffold → connectFreshWorkspace → Standard mode → [role=menu]` production route，并写入独立 `harness-select-menu-open` report/PNG。此前仅存在于 Harness 用户工作树的临时 capture 不再是本路线的唯一来源。该完成只提升 open-menu reference 的可重放性，不扩大已有 menu ROI pixel pass，也不解除 closed-trigger consumer boundary。
Select menu replayable equivalence（2026-08-26）：Select geometry/pixel runners 的默认输入已切换为可重放的 `harness-select-menu-open` 与 generated `vcp-select-browser-production`；两端均声明 `agent-preset-selection/ready/Standard mode/open-selected-hover-menu`，并在截图前把 pointer 移到已选第一项。重放结果为 geometry `cross-page-select-geometry-equivalent`，menu ROI pixel 继续按固定 `0.01` / `2` policy 通过。该 pass 只覆盖 open/selected/hover menu ROI，不覆盖闭合 trigger、focus、busy-trigger disabled，也不改变这些状态的 unresolved 结论。

Select keyboard-focus alignment（2026-08-26）：`capture:harness-select-focus-fixture` 与 `capture:vcp-select-focus-browser-fixture` 以相同 `AgentPresetSeat → Standard mode → trigger focus → Enter` 路径捕获 `document.activeElement` 的语义 owner；`diff:harness-vcp-select-focus` 单独输出 `reports/harness-vcp-focus-geometry-diff.json` 和 focus pixel report，绝不覆盖 hover 的通过报告。初次 capture 真实揭示 Harness 保留 trigger 焦点、而 VCP `mountSelect()` 转移到 selected menuitem 并执行 arrow roving。查阅 Harness `Menu.tsx` 后，VCP 删除了这个额外 keyboard owner 行为，仅保留 Escape close；重新生成的 interaction/geometry/pixel 三层报告必须显示两端 `focusOwner=trigger` 和 `pass=true`。这只闭合 open menu 的 keyboard-focus state，不扩大 closed trigger 或 busy disabled 的结论。

Select busy-trigger production capture（2026-08-26）：`capture:harness-select-busy-fixture` 通过真实 Agent Preset production page 选择 `Minimal mode`，再在 host `ctx.apiProxy.agentPresets.select` 的同一 browser-initiated request 上暂缓响应；`AgentPresetSeatController.apply()` 因而发布 `state.busy=true`，真实 trigger 的 `disabled` 属性可在 host completion 前采集。`check:harness-select-busy-evidence` 固定 provenance、语义 route、800×600@1x、disabled DOM state 与 16px/4px/8px seat geometry；teardown 会释放原始 response 并关闭 scaffold，故不保留悬挂请求。该 Harness fixture 证明 busy trigger 可重放，但不能和 VCP generic Settings Select 比较：VCP 没有可合法迁移的 `AgentPresetSeat`/`AgentPresetRow` consumer，且 `assistantAgent`/chat switching 均在当前冻结边界内。不得为完成状态矩阵新建 fixture-only provider。

Select interaction-state ledger（2026-08-26）：`fixture-matrix.json` 现把 keyboard-open focus 和 busy-trigger disabled 放入独立 `interactionCases`，不把它们伪装为 DOM visual matrix 的额外 pass。前者是同语义双页面 `pass`；后者只能标为 `blocked-vcp-consumer`，即 Harness production capture 已通过、但仍缺合法 VCP AgentPreset consumer。任何汇总门禁必须同时读取 visual cases 与 interaction cases，不能以 hover menu ROI 的像素通过覆盖该边界。

R2-02E Production Surface Adoption 启动（2026-08-27）：线程 B 按 [uiux-production-surface-adoption-handoff.md](docs/uiux-production-surface-adoption-handoff.md) 开始并行施工，不改动 R2-02D 游标。第一批六字段（`sidebarRowHeight`/`sidebarAvatarSize`/`customRadius`/`sidebarRadiusChoice`/`showHomeVisualBrand`/`showHomeVisualTagline`）ownership table 已建立；hidden `#appearanceSidebarRadius` 兼容 select 及其镜像（typed owner 反向投影、Appearance Studio 双向回写、global-settings-manager 兜底读）已删除，Choice 单选组成为唯一可见控件。提交 `3b792fcd`。
R2-02E retry 路由阻断修复（2026-08-27）：Settings Electron journey 在 HEAD 基线（自 `be29ff00` 起）于失败重试步骤超时——legacy autosave 在 Forum typed owner 挂载时全局吞掉状态条重试点击。两个 owner 现各自记录错误归属，重试点击只路由给产生失败的 owner；journey 全绿（failure/retry、reload restore、teardown）。提交 `c49f9263`。
R2-02E Forum draft seam 收口（2026-08-27）：论坛输入的 owner 抑制标记键名与 legacy whole-form autosave 检查的键名不一致，导致在 `adminUsername`/`adminPassword` 打字会同时驱动 legacy 全表单 submit 并与论坛 owner 争抢同一状态条。legacy input 过滤器现同时识别两种标记；Electron journey 新增证据：论坛打字从不触发全表单 `requestSubmit`，保存经由 `ForumConfigUiService.save.execute`。提交 `aa848ec4`。
R2-02E close-flush 逐字段补证与草稿互覆修复（2026-08-27）：Settings 关闭时的 modal-visibility flush 逐字段补证暴露出 typed field owner 的真实缺陷——`readTypedFieldPatch` 从裸服务端快照物化全量 appearanceProfile，同一防抖窗口内后到的字段事件把先编辑的兄弟草稿键覆盖回过期值（实测 53/33/17 全部回退为 52/36/14）。修复后全量快照叠在已积累草稿之上，保存命令线格式不变；journey 新增 6b 段：关闭模态绕过防抖，三个 range、radius choice、home tagline 与论坛凭据的屏幕草稿必须由关闭 flush 原样提交。Electron journey 全绿，`check:uiux:artifacts` 通过（60 文件）。提交 `26333d52`。
R2-02E wide-layout 单选对单一 owner 收口（2026-08-27）：`enableWideChatLayout` 的宽屏/标准 radio 对加入 typed field owner（新增 `inverse-boolean` kind，radio 按 checked 取值）；settings-bridge 通用 projection 两行与 presentation 双轨退役，manager 持久化读保留。Electron journey 6c 证明切换只产生 typed dirty、从不驱动 legacy `requestSubmit`、关闭 flush 提交布尔草稿且 save-result 归属为 `typed-settings-field-owner`；ownership 表升级 `typed-owner-active`。（补记批次 6 与 7 的此段因线程 A 并发编辑本文件而延后，特此说明。）提交 `a6d5c208`。
R2-02E 生命周期与打包证据收口（2026-08-27）：批次 8 Settings-only stress（含批次 6/7 变更树）通过，listener/lifecycle 资源五 checkpoint 恒定、detached=0，验收矩阵「混合 listener 增长归因」「close flush 按字段补证」两行闭合；批次 9 首批六字段 + 论坛凭据 + 宽屏布局全部具备绕过防抖的关闭 flush 逐字段证据；批次 10 在隔离 worktree 完成 electron-builder --dir 打包并通过文件系统 smoke、runtime closure 启动 smoke 与 invalid-packaging 拒绝门禁——darwin/arm64 的 packaged-artifact evidence-pending 解除，win32/Linux 维持 pending。提交 `208b50b5`、`8eaeb5f0`、`1eaa5253`。
R2-02E 字体字段 typed owner 收口与 select 重挂缺陷修复（2026-08-27，批次 11）：8 个字体字段（chatFont/chatCode/chatDiary/chatTool 的 preset 与 custom 各一对）加入 typed field owner（kind: string），settings-bridge 通用 projection 8 行退役，typed project() 接管快照填充与 custom 行显隐；字体应用语义不动。批内必现并修复既有潜在缺陷：`mountHarnessSelects()` 在重复 refresh 时 disconnect 旧 MutationObserver 却因注册表条目残留不重建，动态 option 替换从此无人监听（assistantAgent 重挂回归的根因）；修复为断开时删除条目、挂载尾部必然重挂。journey 新增 6d（preset select + custom text 绕过防抖的关闭 flush 双证据），全绿 16 PASS；8 项门禁通过；ownership 表 8 行升级 `typed-owner-active`。
R2-02E directory-browser/popup-select 生产面接缝审计（2026-08-27，批次 12）：契约面结论——popup-select 是 composer 命令面板控制器（deps 需 token 消耗与 focusComposer），在 Settings 无合法 consumer；directory-browser 严格 injected face、自身无 Electron 依赖但成熟度仍为 foundation-electron-active。Settings 全量路径类输入盘点后唯一开放候选是 networkNotesPaths 动态行（UNC 共享语义、双轨序列化），而全仓无通用目录列举 IPC，注入 Miller 浏览器需先跨线程决策新能力或降级原生对话框互操作。本批不接线（audited-hold），前置条件清单落盘 handoff §11：primitive 达 Candidate active → 目录列举能力决策 → 先把动态列表字段单一 owner 化。
R2-02E networkNotesPaths 动态列表单一 owner 收口（2026-08-27，批次 13）：动态路径行以容器级 owner 通道收口——`#networkNotesPathsContainer` 委托 input/change 重收集整列表进 pendingPatch 并经 save.execute 提交，静默删行改为显式宣告并触发草稿重收集（旧行为下删行不产生 dirty），行投影从通用 consumer 迁入 typed project()，legacy manager 收集仅留 Classic 兜底。journey 新增 6e：编辑/新增/删除三类交互 + 绕过防抖的关闭 flush 整列表提交与 owner 归属，全轮 17 PASS；8 项门禁通过。方法论：toggle 探针竞态假象经影子还原对照定位为 journey 自身增删行断言触发的 debounced save 与探针交叠，以结算等待收敛。批次 12 登记的先决工序闭合，directory-browser production consumer 仅剩 primitive 成熟度与目录列举能力两项外部前置。
R2-02E 验收矩阵存量盘点（2026-08-27，批次 14）：directory-browser unlock 复查未满足（`af281a22` 后线程 A 新增 4 个提交推进 draft prefix/preview/two-leg/timing-parity，但各 checkpoint 状态仍为 `foundation-electron-active`），按预案转入矩阵盘点分支。settings-bridge 通用 consumer projection 残余 45 行三向归因：40 行 / 38 键为台账 §3 冻结责任保留；唯一非冻结待迁量为「userName 簇」4 键（userName、userNameTextColor(+Text) 镜像、userUseThemeColorsInChat、continueWritingPrompt），presentationOwner 对该簇写入全部位于 `!typedSettingsProjectionActive` 兜底分支、挂载后惰性。矩阵「单一 projection owner / 单一 save command owner / legacy projection 删除」三行的存量边界据此收敛为精确清单。docs-only：代码面自批次 13 全绿提交 `180fb5bc` 起零变更，不重跑门禁。
R2-02E userName 簇 typed owner 收口（2026-08-27，批次 15）：unlock 复查仍未满足（`8247c82a` 后线程 A 零新提交），转入批次 14 登记条件施工。`readTypedFieldPatch` 新增定义级 trimValue/fallback 归一化使 typed 保存与 legacy 收集契约逐字节等价；`userName`、`userNameTextColor`(+Text 镜像双 id 共享单键)、`continueWritingPrompt` 加入 TYPED_FIELD_DEFINITIONS，typed project() 接管投影，通用 consumer 非 frozen 行清零。关键修正：globalSettingsForm 内并不存在 `#userUseThemeColorsInChat`（可见的同名前缀复选框属 per-agent agentSettingsForm 域），该 global 键裁定 `inventory-only` 并退役其惰性通用行。failure/retry journey 的打字字段正是 continueWritingPrompt，迁移后该段经 typed dirty→save→错误归属→重试链路全绿；新增 journey 6f（trim/回填/镜像/归属四证据）。八项门禁通过，journey 全轮 19 PASS。
R2-02E presentationOwner 兜底退役评估（2026-08-27，批次 16）：unlock 复查仍未满足（`3bc85d98` 后线程 A 零提交，DirectoryBrowser 保持 `foundation-electron-active`），转矩阵存量评估并选定启动兼容 fallback 为下一候选。定性更正：`uiMode:'classic'` 仅存在于 embeddedAppSessionManager 独立入口页参数，settings-bridge 无 uiMode 门控自举——presentationOwner 的 19 个守卫分支（60+ 处 safeSet/safeCheck）的真实职责是 main.html 内的启动挂载窗口与部分挂载失败窗口安全网，而非跨页面 Classic 兼容。退役前置证据清单 E1-E6 落盘（入口面清单、挂载序确定性、部分挂载失败契约、上游事件路由等价、reload 断言扩容、source-equivalence 负向守护）；本批 docs-only 不删兜底代码，下一批可独立推进 E2/E5/E4。
