# VCPUI 长期收敛路线

> 状态：当前权威长期路线<br>
> 建立日期：2026-08-17<br>
> 当前事实：[`next-ui-current-state.md`](./next-ui-current-state.md)<br>
> Provider 决策：[`vcp-ui-provider-architecture.md`](./vcp-ui-provider-architecture.md)<br>
> 当前 PR 收敛路线：[`next-ui-development-roadmap.md`](./next-ui-development-roadmap.md)

## 1. 长期目标

在不引入 React、Vue、Solid 等应用框架的前提下，将 VCPUI 从大型混合实现收敛为薄而稳定的产品 facade。Native DOM、Customizable Native 与 Web Awesome 是 VCPUI 背后的 Provider，不是业务 API。所有动态 Surface 的副作用必须有 owner，失败必须原子回滚，迟到结果必须失去提交权。

路线最终要消除：

- detached native shim；
- 对 Web Component `querySelector()` / `querySelectorAll()` 的 Shadow DOM 伪装；
- controller 挂载后偷换 Provider；
- 对业务节点的长期 property descriptor patch；
- 无真实生产消费者的公共 API；
- 同一状态的多个权威来源；
- 无 owner 的 listener、Observer、timer、IPC task、Overlay 和 View。

完成不仅要求自动测试变绿，还要求 macOS、Windows、真实 Electron、操作序列、生命周期压力、离线打包和人工视觉证据成立。

## 2. 不可突破的边界

1. 不改变上游聊天业务 DOM、manager、IPC、聊天数据或用户配置协议。
2. 不接管前端插件 Loader、动态壁纸或第三方插件生命周期。
3. 不重绘上游消息、工具、日记、思考链、代码块和媒体组件。
4. 不因拆组件引入第二业务 Store、全应用 idle 或通用工作流框架。
5. 每一步只改变结构、Provider、视觉、vendor 或业务适配中的一个维度。
6. 没有真实生产消费者时，不增加稳定公共 API。
7. 每个阶段都必须独立可测试、可审阅、可回滚。
8. 未经用户明确指示，不创建或推送 PR。

## 3. 当前基线

核对时间：2026-08-18（含本轮未提交测试门禁与 Overlay 修复）。

- 工作分支：`codex/design-system-upstream-no-workflow-20260817`。
- 最近已提交基线：`0d5aa7a1`；当前工作树另有未提交的生命周期、Provider、Shell 和测试改动，不能把工作树状态误写成远程已交付。
- 跟踪分支：`origin/codex/design-system-upstream-no-workflow-20260817`；本地提交历史领先远程 12 个提交，当前 42 个路径仍有未提交改动（含并行线程的未提交修复）。
- `upstream/next-ui`：`8a18b1f0`；当前 HEAD 领先 44、落后 0。
- `upstream/main`：`51d519c4`；相对当前 merge-base 新增 8 个 Scriptorium 提交。本批只修改 `ScriptoriumModules/**` 和相应测试，与当前 Select 工作区不重叠。目标分支仍是 `next-ui`，因此阶段 0 不直接合并 `main`。
- 当前未提交内容共 42 个工作树条目，属于 Provider 架构、生命周期、Next Shell、测试和文档；不包含 workflow、插件或动态壁纸改造。用户独立的 `styles/themes.css` 仍不在本轮范围。
- `vcp-ui.js` 当前约 2,380 行；Select policy、WA sibling proxy 和首批纯展示 factory 已拆为独立模块。

最近一次证据（2026-08-18）：

- UI System：`npm run check:ui-system` 全门禁通过（Node contract 92 项、Registry/生命周期 16 项均通过）；
- Electron UI Apps：23/23（新增主界面 DPR/主题合成矩阵）；
- 主聊天状态机操作序列：20×30，共 600 actions、17 action kinds、187 pairs、55 transitions、4 faults、165 次受控 VCP 请求，required edges 16/16；
- 生命周期压力：3 次预热 + 20 次测量通过；
- 861 listener、8 Scope、162 受管资源、5 process 保持稳定；
- detached root/icon/option 均为 0；
- macOS Electron 41 / Chromium 146 支持 `base-select` 与 `::picker(select)`；
- Windows Customizable Native 视觉与键盘证据尚缺失。

## 4. 阶段总览

| 阶段 | 当前状态 | 核心结果 |
|---|---|---|
| 0 保护现场与事实基线 | 已完成 | 分支、远程、工作区、文档与测试证据对齐 |
| 1 固化 Select Provider | 已完成 | Provider、WA proxy、原子回滚和测试已形成独立提交 |
| 2 清除 Select property bridge | 已完成（2026-08-17） | 原业务 Select 不再被 patch descriptor；复用设置 Surface 的异步提交代次有真实 Electron 逆序证据 |
| 3 跨平台 Select 决策 | 未开始 | 用双平台证据决定默认 Provider |
| 4 Input / Textarea Provider | 进行中（2026-08-17） | shim/查询伪装已删除；macOS Electron 已覆盖 Shadow DOM、IME、selection、password、FormData/reset、validity、focus；待 Windows 真机 |
| 5 Toggle / Range / Form | 进行中（2026-08-17） | Checkbox/Switch 已移除 Shadow DOM 查询桥并统一 host API；SettingsSection/Field/ActionBar 已加入 WeakMap owner、同步撤销和保存/删除 operation identity；Range 只回滚视觉层并拒绝覆盖已有业务属性；Field 已通过 host 委托监听与 owner 管理的 MutationObserver 支持动态 control replacement。仍待 Windows 证据 |
| 6 Feedback / Overlay | 进行中（2026-08-18） | Feedback owner 增加精确 loading token；Dialog factory 失败可结算；WA Modal close 不依赖 after-hide；Overlay replacement 先取得新 lease 后释放旧 lease，Classic/第三方 modal 隔离，Escape dispatcher 阻止级联关闭；真实跨进程 load reject、renderer crash、迟到 hide response/reload、hide handler rejection、Ask Nova 来源焦点恢复、Creation 来源焦点恢复和全局设置来源焦点恢复已有证据，仍待更强 Creation/Ask Nova 与嵌入 View 组合证据 |
| 7 VCP-owned Patterns | 首批拆分进行中（2026-08-18） | List 有全局设置导航真实消费者，已移入 `patterns/list-factory.js` 并由 facade 注入共享 controller/icon；SegmentedControl 现已移入 `patterns/segmented-control-factory.js`，由 facade 注入 normalize/value 规范化/icon/emit，Creation 消费者保持不变；Tabs 当前仅 showcase/契约测试。Divider/Skeleton/Card/Toolbar 已移入纯展示 factory 模块，facade/registry 兼容入口保持不变 |
| 8 Web Awesome Runtime | 进行中（2026-08-18） | Surface manifest、并发批处理、adapter-only 加载和部分组件导入失败后的唯一 `failed`/Native fallback 语义已落地并有契约证据；生产 facade 已收缩为 `loadComponents/create/isDefined/isLoaded/getRuntimeState/mountScope/surfaceManifests`，模块级兼容 helper 尚待测试迁移后删除；Windows cold start、真实 ASAR 增量失败与跨平台视觉仍待补 |
| 9 性能与视觉稳定 | 进行中（2026-08-17） | macOS Electron 已加入 DPR 1/1.25/2 × 连续主题切换、主壳几何/正文/焦点断言；Windows 原生 DPI/DWM 仍待实机 |
| 10 操作序列与故障注入 | 进行中（2026-08-18） | 状态机已覆盖 20×30、required edges 16/16，并包含通知→创建→Ask Nova→全局设置→嵌入应用 Escape 链、同 action WebContentsView replacement、旧 view 失败/abort、设置 modal 跨代逆序和真实主进程 hide gate；test-only Electron 另外验证 `loadURL` reject、renderer crash session 清理、replacement 隔离，以及双成员 Group stream-switch/reload/crash 的 history/DOM/瞬态状态归属。Group crash 以新 renderer document epoch 为恢复证据。trace 最小化、附件/重生成/删除末消息及更广 fault matrix 仍待完成 |
| 11 双平台长时间稳定 | 未完成 | macOS 短循环通过；Windows 完整矩阵及 30–60 分钟人工 soak 尚缺 |
| 12 提交与上游交付 | 未开始 | 干净、可审阅、可回滚的最终 diff |

## 5. 阶段 0：保护现场与事实基线

### 工作

- 核对分支、远程、merge-base、领先/落后关系和上游新增提交。
- 证明当前工作区文件来源，排除用户独立修改和越界目录。
- 对 Select 改动做故障路径审查，并补齐半挂载原子回滚。
- 建立本文，与当前状态、短期路线和 Provider 决策形成唯一权威链。
- 记录完整自动证据，不把历史数字当作永久事实。

### 退出条件

- 代码、文档、工作区和测试数字一致。
- 上游新增提交已归因，未盲目合并错误目标分支。
- 当前改动不含 workflow、插件、动态壁纸或业务页面重写。
- 下一阶段可以只整理 Select 提交，不需再改变行为。

## 6. 阶段 1：固化 Select Provider

> 状态：已完成（2026-08-17，`d999d945`）。

2026-08-18 对抗复核修正了 WA-owned Select 的事件边界：Web Awesome 已从 host 派发标准 `input`/`change`，VCPUI 只同步 controller value，不再按 `Event.isTrusted` 判断或二次派发。契约测试覆盖 Web Component 的 `isTrusted=false` 事件只对消费者出现一次、后续无关 update 不回写旧值、程序化 setValue 不产生 input/change；Native fallback 与 WA-owned 的 `required` 合同也已对齐。

### 工作

- 固定 decision、WA sibling proxy、Native、Customizable Native、WA owned 和 Native fallback 合同。
- Provider 在 mount 时冻结；切换只能 destroy/remount。
- 原 `<select>` 继续拥有 value、options、form、validity 和业务事件。
- 覆盖普通枚举、250+ 模型列表、动态 options/value、label、disabled、required、input/change 单次派发、destroy 恢复和半挂载失败。
- 将文档、Provider 实现和测试整理成可独立回滚提交。

### 退出条件

- macOS 完整门禁通过。
- 提交边界中不混入后续 property bridge 删除或视觉默认变更。
- 工作树只剩明确属于下一阶段的内容。

## 7. 阶段 2：清除 Legacy Select property bridge

### 工作

- 生成生产调用清单：`value`、`selectedIndex`、`add`、`remove`、`focus`。
- 标注上游、Next、测试和不可达调用者。
- Next 消费者迁移到 controller API 或真实 DOM operation + 标准事件。
- 上游不能立即修改的调用只保留最窄、显式、可销毁适配。
- 删除 proxy 对业务 Select 的 own property descriptor patch。
- 设置模态框关闭后仍复用同一业务 DOM；为每次打开建立 generation/owner，异步 `getAgents`、Rust 配置和业务表单同步在 `await` 后检查当前 Surface 与精确 root，迟到结果不得写入下一次打开。
- 将 Rust 配置 hydration 收敛为单一 writer，终态 presentation 事件携带 `surface`、`root` 和 `generation`；Settings bridge 只接受当前代次的通知。

### 退出条件

- mount 前后原 Select property descriptors 一致。
- 表单提交、reset、事件顺序、label 和焦点行为不变。
- 反复 mount/destroy 不增加 detached options、listener 或 Observer。
- open → close → reopen → 乱序完成的 deferred 测试通过；关闭或替换 root 后不产生刷新事件、不写入新 Surface。

Stage 2 证据：`npm run test:electron-settings-race` 连续通过（A=1、B=3）。测试专用 Electron 入口只在 E2E 环境包装 `ipcMain.handle`，生产 main/preload/IPC 文件保持不变；它断言同一 modal root、B 的 WA/native 值、B terminal events、无 synthetic change、迟到 A 不增加 presentation refresh，且每代每个读通道只发起一次请求。

## 8. 阶段 3：跨平台 Select 决策

### 当前调研事实（2026-08-17）

- 本地 Electron 包为 `41.10.4`；真实应用的 `process.versions.chrome`、Windows 构建和显示缩放尚未采集，历史文档中的 Chromium 数字不作为本阶段证据。
- 当前 policy 没有平台分支：`auto` 在 Web Awesome ready 时为 existing Select 使用 sibling proxy，owned Select 使用 WA-owned；未 ready 时稳定回退 Native。Customizable Native 只接受显式请求，并要求 `appearance: base-select` 与 `::picker(select)` 同时被支持。
- 因此不能仅凭 `CSS.supports`、macOS 截图、UA spoof 或 Chromium 版本开放 Customizable Native 的 `auto` 默认。Windows 任一键盘、视觉、缩放或可访问性关键项未通过时，继续保持显式实验 Provider。
- 最小矩阵必须覆盖两平台的 provider/reason、亮暗主题、焦点/禁用/校验态、Tab/箭头/Home/End/typeahead/Enter/Escape、250 项滚动、最小窗口/DPI、动态 options/value、form reset、20 次 open-close-destroy 和 WA import failure→Native；同时采集 listener、Scope、Shadow DOM、detached options 与启动成本。
- `npm run test:vcp-ui-select-proxy` 现在会输出可复用的 Electron 事实记录（Electron/Chrome、OS/架构、UA、DPR、viewport、两项 `CSS.supports` 结果和实际 Provider）。当前已采集 macOS arm64 / Electron 41.10.4 / Chrome 146；Windows 记录仍必须在真实 Windows Electron 上补齐。
- 该测试支持 `VCPCHAT_SELECT_EVIDENCE_OUT=<path>`，会将同一份结构化证据写入 JSON，方便 Windows 实机上传/对比，避免人工抄录或 UA 猜测。

### 工作

- macOS、Windows 比较 Native、Customizable Native、WA。
- 检查视觉、鼠标、键盘、读屏名称、缩放、主题、最小窗口和 250+ 列表。
- 记录启动成本、Shadow DOM 数量、主题切换成本和失败恢复。
- 只有双平台证据支持时，才更改 `auto`。

### 退出条件

- 默认 Provider 决策有数据、回退和独立提交。
- 平台差异只存在于 Provider policy，不散落业务代码。

## 9. 阶段 4：Input 与 Textarea

建立 provider-neutral controller，删除 detached shim 与 Shadow DOM 查询伪装。当前 `Input`/`Textarea` 的 Web Awesome 分支只暴露 `control/getValue/setValue/focus/checkValidity/reportValidity/setCustomValidity`，生产 `InputDialog` 已改用这些 API，不再 monkey-patch `querySelector()`。契约测试明确断言不会创建可见或 detached 的 native shim。

重点保护 IME composition、selection、autofill、password、readonly、required、validity、label 和焦点。`test-vcp-ui-text-controls.mjs` 已在 macOS arm64/Electron 41.10.4 验证真实 WA Shadow DOM、composition 事件顺序、selection、密码属性、FormData/reset、change-only autofill 状态、Field label/description、validity、焦点和销毁；生命周期压力仍保持 listener/Scope/资源不增长。阶段退出仍需 Windows 中文输入/缩放证据及人工输入法确认。

设计参考：VS Code 的 [`InputBox`](https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/inputbox/inputBox.ts) 将真实输入节点作为唯一 owner，显式提供 value、focus、select、selection 和 dispose；Lit 的 [`ReactiveController`](https://github.com/lit/lit/blob/main/packages/reactive-element/src/reactive-controller.ts) 只通过 hostConnected/hostDisconnected 管理副作用。VCPUI 采用同一边界，但保留上游原生 DOM 与 Web Awesome host 的可替换 Provider，不把 Shadow DOM 查询暴露给业务。

## 10. 阶段 5：Toggle、Range 与表单组合

拆分 Checkbox、Switch、Range、Field、SettingsSection 和 SettingsActionBar。Checkbox/Switch 的 WA 与 native provider 都通过 host/controller API 读写状态，未再穿透 Shadow DOM；这两个 WA provider 仍只有 showcase/candidate 消费者，不进入生产 Surface manifest。SettingsSection/Field/ActionBar 使用 WeakMap owner 令牌，旧代 cleanup 只释放自己的资源；设置桥在异步 Scope dispose 前同步销毁 controller，保证 Classic → Next 立即重挂载不会被旧 controller 阻塞；保存/删除 terminal event 带 operation identity。Range enhancement 只负责视觉进度、尺寸和标签，已有业务节点拒绝写入业务属性，销毁时不覆盖业务真源。Field 通过 host 委托监听与 owner 管理的 MutationObserver 重新绑定动态替换的 control，并在旧代失权时不回写新代节点。下一步聚焦 Windows 输入法/DPI 证据及设置页反复打开、保存、失败回滚和销毁后的资源计数。

## 11. 阶段 6：Feedback 与 Overlay

拆分 Toast、Modal、Confirm、Prompt 和 Loading，保留 `feedback.owner(scope)`。第一轮已完成精确 loading token（`beginLoading/endLoading`，旧 `setLoading(false)` 保持兼容）、Dialog factory 异常结算、WA Modal 关闭时立即 teardown/焦点恢复、Modal render-owned 控件撤销，以及 OverlayCoordinator 的共享 hide transition、root/generation 防旧事件释放新 lease、dispose 后 WebContentsView reconcile。当前新增 Next-owned priority Escape dispatcher，已迁移 Account Menu、Assistant Search、Notification Menu 和上游模板式全局设置 modal；VCPUI Modal、Appearance Studio 和 Legacy handlers 仍保留各自 owner，避免跨边界改变 Classic/上游行为。Next Shell teardown 现在等待 native app close 完成后才释放 scoped feedback；无 owner 时的 global fallback 仅用于展示且永不 dispose。下一步迁移创建/Ask Nova 的统一 dispatcher 接入，并覆盖无 focusable fallback、焦点逃逸、关闭期间重开、hide IPC 失败和嵌入 View 的可重放序列；子 Surface 不能清理其他 owner 的反馈。

## 12. 阶段 7：VCP-owned Patterns

当前事实盘点：`List` 被全局设置导航使用，已移入 `modules/ui-system/patterns/list-factory.js`，通过依赖注入复用 facade 的 controller/icon，不建立第二套生命周期；列表采用单一 owner-managed delegated click listener，items 重渲染不会保留旧行回调。设置导航已明确为 navigation landmark，交互项保留 native button role，使用稳定 item identity、`aria-current` 和 Arrow/Home/End 焦点导航；真实 Electron 已覆盖搜索过滤、切换、重绘后的焦点恢复和 current 状态。`SegmentedControl` 被创建助手/群组类型选择使用，已移入 `modules/ui-system/patterns/segmented-control-factory.js`，依赖同一 facade controller、normalize、value 规范化、icon 和 emit；采用 delegated click 与 owner-managed keydown，items 替换、禁用项和方向键有契约覆盖。`Tabs` 没有生产消费者，只有 showcase/契约测试，可作为后续纯展示拆分候选。Tabs 与 SegmentedControl 现在会在 items 替换后将 value 规范化到首个可用项（全部禁用时清空），并有 contract 覆盖。`Divider`、`Skeleton`、`Card` 与 `Toolbar` 已移到 `pure-factories.js`，未改变公开 registry。Toolbar 的单宿主约束与 List 的窄窗口/读屏人工证据仍需独立验证；不得再为 showcase-only pattern 增加 Stable API。拆分保持 facade/registry 兼容入口，Stable 必须具备生产消费者和 Electron 证据；展示页独占能力保持 Candidate 或删除。

## 13. 阶段 8：Web Awesome Runtime

修正 `loadComponents(tags)` 名义按需、实际加载全部 `CORE_COMPONENTS` 的不一致。当前已建立冻结的 `settings`、`creation`、`comparison` Surface manifest；并发请求在一个 microtask 内合并，只导入尚未加载的 tag，加载状态在创建事务时同步进入 `loading`，所有 waiter 共享同一终态。`webawesome-comparison.js` 已改为只经 adapter 加载和持有主题，不再直接 import vendor 或建立第二套主题 observer。

文档级终态仍为 `idle → loading → ready | failed`；由于 Custom Elements 不能反注册，失败后不会尝试恢复或升级已挂载控件，后续 Surface 必须走稳定 Native fallback。这里的“按 Surface”只减少执行和注册，不裁剪离线 vendor closure；closure、locale、theme、许可证和 pack 仍须独立核验。VS Code 的 activation/disposable、Lit 的 `updateComplete` 与本地 harness 的 capability/fail-closed 经验作为设计参考，不能替代真实 Electron 证据。

## 14. 阶段 9：性能与视觉稳定

测量 Windows 主题切换、设置打开、创建助手、大模型列表和多 Surface 往返。区分 style recalculation、Shadow DOM、字体、GPU/背景和同步 IPC。增加 blank frame、重复 remount、geometry reversal、重叠、滚动锚点漂移和焦点跳动检查；不得通过放宽泄漏阈值制造通过。

## 15. 阶段 10：操作序列与故障注入

把设置、创建、表单、标签、Ask Nova、通知、主题、reload/crash、WA failure 和 WebContentsView Escape 纳入状态机。每步检查 Scope、listener、Observer、timer、IPC task、Overlay owner、View、process、活动 DOM 和 detached node。失败 trace 必须可保存、重放和最小化。

## 16. 阶段 11：双平台长时间稳定

macOS、Windows 分别运行完整 UI System、Electron UI Apps、主聊天序列、生命周期压力和 pack check。执行 30–60 分钟人工 soak 与更长自动循环，记录 heap、renderer/process、listener、Scope、受管资源和 detached node 趋势。任何平台差异必须解释，不能用另一平台结果代替。

## 17. 阶段 12：提交与上游交付

按文档/Provider 合同、组件域、Runtime、性能和测试证据整理小提交；测试与实现同行。同步目标上游分支并重新归因冲突。最终 diff 禁止包含 workflow、插件 Loader/动态壁纸改造、实验业务页面和用户独立修改。只有工作树干净、完整矩阵通过且风险可解释后才具备交付条件。

## 18. 每阶段 Definition of Done

每个阶段必须回答：

1. 业务状态唯一 owner 在哪里？
2. Surface 谁 mount、谁 dispose？
3. listener、Observer、timer、IPC、Overlay、View 和 DOM 谁释放？
4. 请求如何取消，迟到结果如何失去提交权？
5. 中途失败如何原子回滚？
6. Provider 不可用时 fallback 是否完整？
7. 接口两端和真实消费者在哪里？
8. register/use/dispose/absent 与故障注入证据在哪里？
9. macOS、Windows、Electron 和打包证据分别是什么？
10. 是否能独立回滚且不改变用户数据和插件协议？

任一问题没有证据时，该阶段仍未完成。

## 19. 更新规则

- 每完成一个阶段，同一提交更新本文状态、当前状态文档、测试数字和剩余风险。
- 上游更新先归因到目标分支；不因为 `main` 更新就越过 `next-ui` 直接合并。
- 自动测试只证明覆盖路径，不代表“绝对无 bug”。
- Windows、人工视觉和 soak 缺失时必须明确写为缺失。
- 路线允许调整顺序，但不允许把未完成项改名后宣称完成。
