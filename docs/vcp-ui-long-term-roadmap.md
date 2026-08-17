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

核对时间：2026-08-17。

- 工作分支：`codex/design-system-upstream-no-workflow-20260817`。
- 最近已验证实现：`a0d7bfdd`（Stage 2 修复与真实 Electron 逆序证据；Stage 3 决策门已记录）。
- 跟踪分支：`origin/codex/design-system-upstream-no-workflow-20260817`，本地已提交历史与远程一致。
- `upstream/next-ui`：`8a18b1f0`；当前 HEAD 领先 44、落后 0。
- `upstream/main`：`51d519c4`；相对当前 merge-base 新增 8 个 Scriptorium 提交。本批只修改 `ScriptoriumModules/**` 和相应测试，与当前 Select 工作区不重叠。目标分支仍是 `next-ui`，因此阶段 0 不直接合并 `main`。
- 本轮 Stage 2 提交后工作树干净；提交内容属于 Provider 架构、Select 实现、设置 Surface 代次保护、测试和文档，不包含 workflow、插件或动态壁纸改造。
- `vcp-ui.js` 当前约 2,208 行；Select policy 和 WA sibling proxy 已拆为独立模块。

最近一次证据：

- UI System：84/84；
- Electron UI Apps：22/22；
- 主聊天操作序列：24 步通过；
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
| 5 Toggle / Range / Form | 未开始 | 单一状态 owner 与可逆增强 |
| 6 Feedback / Overlay | 未开始 | owner 隔离与 Overlay/View 对账 |
| 7 VCP-owned Patterns | 未开始 | `vcp-ui.js` 退化为薄 facade |
| 8 Web Awesome Runtime | 进行中（2026-08-17） | Surface manifest、并发批处理和 adapter-only 加载已落地；待完成跨平台/pack/失败矩阵 |
| 9 性能与视觉稳定 | 未开始 | 可重放的跨平台性能和几何证据 |
| 10 操作序列与故障注入 | 未开始 | 必需 edge、trace 与资源不变量 |
| 11 双平台长时间稳定 | 未开始 | 双平台完整矩阵与 soak |
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

拆分 Checkbox、Switch、Range、Field、SettingsSection 和 SettingsActionBar。明确哪些是 Native Provider、WA Provider 或 VCP-owned pattern；删除 Checkbox/Switch 查询桥和重复 checked 状态。设置页反复打开、保存、失败回滚和销毁后不得遗留控件或 listener。

## 11. 阶段 6：Feedback 与 Overlay

拆分 Toast、Modal、Confirm、Prompt 和 Loading，保留 `feedback.owner(scope)`。统一 Escape、外部点击、焦点恢复、关闭期间重开、Overlay lease 和 WebContentsView 遮挡对账。子 Surface 不能清理其他 owner 的反馈。

## 12. 阶段 7：VCP-owned Patterns

拆分 Card、List、Toolbar、Tabs、SegmentedControl、Pagination、EmptyState 和 Settings patterns。Stable 必须具备生产消费者和 Electron 证据；展示页独占能力保持 Candidate 或删除。退出时 `vcp-ui.js` 只保留 facade、registry、共享 controller 基础和受控兼容入口。

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
