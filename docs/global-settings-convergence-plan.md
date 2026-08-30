# Global Settings 收口施工计划

更新时间：2026-08-28

## 最新验收记录（2026-08-28）

- 继续复测后，当前 `npm run test:uiux` 为 94/94，`npm run test:ui-system` 为 115/115；Harness fixture matrix 为 161 visual / 32 interaction，reference pack 为 97 files / 47 primitive contracts。
- 修复 artifact-only Electron Tooltip/HoverCard 视觉 fixture 的不稳定触发：fixture 现在显式发送 Tooltip anchor 的 `pointerenter`，不再把视觉门禁建立在窗口焦点副作用上；Tooltip 的 focus 交互仍由 UIUX interaction tests 覆盖。
- 通过 `npm run test:electron-uiux:artifacts`、`npm run check:uiux`、`npm run check:uiux:artifacts`、`npm run test:uiux`（95/95）、`npm run test:ui-system`（115/115）、`node scripts/test-settings-wa-electron.mjs` 与 `node scripts/test-electron-global-settings-entry.mjs`。
- 本次仅调整测试 fixture，未修改 Tooltip 生产实现、Settings 业务保存链或聊天冻结区域。

## 唯一目标

让 VCPChat 全局设置页继续使用已经接入的 Harness 风格组件（Input、Field、Select、Toggle、Range、Choice、ColorPair、Button、Menu、Tooltip、Modal、Toast），并通过分区收口减少旧 CSS、重复 listener、重复 projection 和过宽 bridge 职责。

这是一份产品施工计划，不是 DeepSeek Harness 源码复刻研究计划。旧的 `ui-runtime-2-roadmap.md`、parity ledger、reference pack 只用于追溯和必要回归，不作为高频设置迁移的阻塞条件。

## 当前基线

### 列表项圆角行式控件（2026-08-28）

全局设置的“列表项圆角”已改为 Harness 风格的单行设置项：左侧为字段说明，右侧为可换行的 Choice 选项组。原有 radio 节点仍是 canonical control，`appearanceProfile.sidebarRadius` 映射、自动保存和 Appearance engine 均未改变；仅删除原两列卡片式布局的 presentation 约束，并在窄屏降为上下排列。验证通过 `check:uiux`、`build:uiux`、artifact consistency、`test:uiux` 和 `test:ui-system`。Settings Electron 全流程本轮在既有 90 秒等待点超时，未进入该字段断言，不能作为本项通过证据。

- Global Settings 已有约 93 个控件节点；
- 已有 generated primitive 的真实 consumer：Input/Field、Select、Range、Toggle、Choice、ColorPair、Button，以及 Tooltip/Modal/Toast；
- Appearance section 已完成多 viewport/light-dark 的基础视觉回归；
- Settings 保存、失败重试、close-flush、reload/reopen 和 owner teardown 已有 Electron 证据；
- canonical DOM、settingsManager、IPC、persisted key 和聊天业务语义必须保持不变；
- 当前状态是“高频组件已广泛接入，按 section 收口中”，不是“重新接入组件”。

## 施工原则

```text
现有 generated primitive
→ 保留 canonical native control
→ 一个 section presentation owner
→ 真实 Global Settings consumer
→ 删除该 section 直接竞争的旧 CSS/listener/projection
→ focused + Electron 回归
→ 独立提交
```

不引入 React、Vue、Cordis、Virtual DOM 或第二份 durable settings state。特殊 picker、窗口 icon、低频控件和聊天区域保持原实现。

## 分区顺序

### G0：基线与目录收敛

- 组件展示页将条目标为 `production-ready`、`candidate-lab` 或 `legacy-showcase`；
- 新页面只允许引用前两类中的 production-ready/真实 consumer 组件；
- 暂停为没有 VCP production consumer 的 Harness source-only 控件增加新 parity 文档；
- 每批只修改本批 section 直接相关文件。

### G1：服务器连接（当前批次）

字段：`vcpServerUrl`、`vcpApiKey`、`vcpLogUrl`、`fileKey`、`vcpLogKey`。

- 采用现有 `Field + Input`，保留 text/url/password 原生类型；
- 保存继续走现有 global settings command/IPC/persisted key；
- 盘点并删除该组重复 blur listener、旧 input geometry selector 和无效 projection；
- 验收首次打开、编辑、保存、失败重试、close-flush、reload/reopen、light/dark、teardown；
- 若发现某个 legacy 分支承担业务归一化（例如 URL 补全），只迁移 presentation，不删除业务归一化。

### G2：身份与论坛

- `userName`、颜色镜像对、`adminUsername`、`adminPassword`；
- 统一 Field + Input/ColorPair；
- 保留头像文件、论坛 capability 和写入协议；
- 删除已经由 typed owner 接管的旧投影和重复 marker。

#### G2 首个净删除（颜色镜像）

全局身份区的 `userAvatarBorderColor`/`userAvatarBorderColorText` 与
`userNameTextColor`/`userNameTextColorText` 现在由 generated ColorPair 的
owner 回调负责同步、校验提示和头像预览更新；`event-listeners.js` 中原有
6 个 ambient input/change/blur listener 已删除。重置颜色按钮、canonical
controls、保存和颜色提取业务保持不变。`npm run check:uiux`、58 项 focused
tests、artifact consistency 和 `test-settings-wa-electron.mjs` 全部通过。

### G3：语音与高级

- 语音 mode 使用 Choice，路径/URL/Key 使用 Field + Input；
- 高级布尔项使用 Toggle，数值项使用 Input；
- 保留能力发现、失败状态和条件显示；
- `topicSummaryModel` 和复杂模型 picker 暂不收口。

### G3 审计结果（2026-08-28）

语音模式已由 generated Choice 接管，浏览器路径、识别页路径、本地/网络
URL 与 Key 已由 generic generated Input 接管；现有测试覆盖 snapshot 投影、
条件显示和 reload 恢复。未发现第二套语音 listener 或可安全删除的独立
projection，因此本批不做空转改动，保留现有业务 capability 与默认值语义。

G2 身份颜色镜像的 6 个 ambient listener 已在提交 `2a69fb01` 删除；该结果
作为后续 section ownership 拆分的参考实现。

本轮补充收口高级区的条件显示：context sanitizer、middle-click quick action、
advanced action 与 regenerate confirmation 的即时显隐现在由同一个 typed
field owner 统一处理，并随 Settings presentation scope 销毁；
`event-listeners.js` 中对应的 5 个重复绑定已删除。`middleClickAdvancedDelay`
的 1000ms 归一化已迁入同一 owner（input/blur 均覆盖），message/renderer 的
业务读取边界保持不变。

### G4：section controller 拆分

将过宽的 `settings-bridge.js` 逐步拆为内部模块：

```text
settings-bridge-entry
├── section-mounting
├── primitive-mounting
├── field-projection
└── autosave-orchestration
```

每个 section controller 只提供 `mount(section) / sync(snapshot) / dispose()`，不拥有第二份 durable state。拆分必须以真实调用方为依据，不为了形式制造公共 API。
模块化时必须同步更新 source-equivalence 门禁；字段 ownership 不能因 `spread`、动态注册或间接常量而变得不可静态审计。若门禁无法证明单一 owner，则保持当前显式映射，不合并拆分。

首个 G4 内部切片已完成：高级区条件显隐抽为
`modules/ui-system/settings/advanced-visibility.js`，bridge 仅负责注入
owner 生命周期与事件绑定；字段字面量仍保留在 helper 中，source-equivalence
可继续静态追踪。该模块不建立 durable state，也不改变 Settings/IPC 协议。

随后 Rust Assistant 区也完成同样的收口：
`modules/ui-system/settings/rust-visibility.js` 负责面板显隐，typed Rust
consumer 绑定并销毁即时响应监听；旧 `event-listeners.js` 监听仅在 typed
service 不可用的 Classic/早期 bootstrap 路径启用，避免生产 Settings 双写。

同时，颜色镜像的旧 binder 现在仅在 UIUX artifact 不存在时启用；生成的
ColorPair 可用时，生产 Settings 不再注册第二套颜色同步监听。

用户样式折叠标题的旧单击绑定也已删除；`mountHarnessDisclosures` 现在是该
标题的唯一 presentation owner，统一处理点击、键盘、ARIA 和 dispose。

当前 `event-listeners.js` 中仍保留的全局设置绑定已完成边界分类：
`submit`（兼容字段保存）、头像文件选择/裁剪、颜色重置按钮和无 UIUX
artifact 时的 ColorPair fallback 均直接承载业务或 bootstrap 语义，暂不退役；
它们不是与 typed primitive 竞争的生产 presentation owner。后续只有在对应
业务命令拥有独立 owner 且有 Electron 回归证据后才迁移。

`render-settings` 的四组字体 preset/custom 行显隐也已抽为
`modules/ui-system/settings/render-visibility.js`；该 helper 只投影 DOM
显示状态，不读取或写入聊天状态，作为 G4 的第三个无状态 section helper。
其四个 preset select 现在由同一 owner 绑定即时 change 响应，切换后无需等待
autosave 回写即可显示/隐藏 custom 行，监听随 owner teardown 撤销。

Appearance 的三个 Range mount 也已抽为
`modules/ui-system/settings/appearance-ranges.js`，native range 与输出节点
仍由原有 typed snapshot/field owner 管理，helper 仅负责生成 primitive 装配。

Home 视觉的两个 Toggle mount 已进一步抽为
`modules/ui-system/settings/appearance-toggles.js`；checkbox 仍是 canonical
节点，helper 不拥有持久化状态，仅注册 generated Toggle 与 scope cleanup。

Home tagline 的 generated Input mount 也已抽为
`modules/ui-system/settings/home-controls.js`；输入值与保存仍由 typed field
owner 负责，helper 仅建立 Light-DOM primitive 和销毁标记。

全局身份两组 ColorPair 的 generated mount 也已抽为
`modules/ui-system/settings/identity-controls.js`；头像预览与错误提示通过
注入回调保持，颜色持久化和业务同步仍由原有 owner 负责。

Agent 六个 section 的 DisclosureRow presentation owner 已抽为
`modules/ui-system/settings/agent-disclosures.js`；该模块通过注入的
`settingsManager.toggleAgentSettingsSection` 保持业务命令归属，并观察
canonical collapsed class，不复制折叠状态。

Appearance 圆角 Choice 与 Voice Mode Choice 的 generated mount 已合并抽为
`modules/ui-system/settings/choice-controls.js`；仅负责两个高频 Choice 的
展示装配和 marker cleanup，不接管冻结的聊天布局 radio。

Forum credential 的两个 generated Input mount 已抽为
`modules/ui-system/settings/forum-controls.js`；ForumConfigUiService 的保存、
dirty、retry 和 capability 语义仍由原 field owner 管理。

拆分复核（2026-08-28）：bridge 已从约 2111 行降至约 1881 行，Appearance、
Identity、Forum 的纯 primitive 装配已有独立归属。剩余约 2k 行主要集中在
Agent section disclosure/model picker、service 装配和全局 shell 生命周期；这些
包含真实业务调用方，不再继续做机械小 helper 拆分。下一阶段优先处理 Agent
section controller 的 mount/sync/dispose 边界，并以真实 consumer 与 Electron
回归作为拆分依据。

### Agent ModelPicker capability 收口（2026-08-28）

模型目录适配已抽为
`modules/ui-system/settings/agent-model-picker-directory.js`。该模块只负责把
现有 `chatAPI` 的缓存、热门/收藏元数据、刷新、收藏切换和更新订阅转换为
ModelPicker 的短生命周期 capability；不写入 `#agentModel`，不复制 durable 模型
状态，也不触碰 legacy modal。`settings-bridge.js` 现在只负责 capability 注入、
canonical input/change 事件和 primitive owner 生命周期。

本切片的 focused contract 覆盖：三分区顺序及重复策略、active 投影、收藏调用、
更新订阅释放。它仍不授权删除 `modelSelectModal`；删除前必须继续取得真实生产
Electron 的选择、刷新/失败、close-race、reopen/reload 和 focus 恢复证据。

同日真实 Electron `agent-settings` lifecycle stress 已通过（1 warmup + 1 measured
cycle）：节点 5856、监听器 571、active scopes 41、active resources 501 在周期前后
保持稳定；detached roots/icons/options 均为 0，ModelPicker 的 close/dispose 没有留下
瞬态 scope 或 DOM。该证据支持“当前 picker owner 无增长/泄漏”，但仍不等同于
legacy `modelSelectModal` 已具备删除资格。

随后 `test:electron-agent-settings-interaction` 的 Agent Select 交互回归也通过：
选择、关闭、重开、Escape 和触发器焦点恢复路径在真实 Electron 中完成，且周期前后
监听器 570、active scopes 41、active resources 501、detached roots/options 仍保持
稳定。ModelPicker 的生产交互证据因此已覆盖目录能力、键盘关闭、焦点恢复和 lifecycle
stress；剩余删除阻断主要是 `topicSummaryModel` 共享 legacy caller 与完整默认数据
源 parity，而不是 Agent picker 本身的 owner 稳定性。

Visual QA 记录：2026-08-28 的 1280×800 light 运行中，Select 采样出现
`focused=true` 但 `:hover=false`，导致门禁失败；同一脚本的其他 viewport 与
历史 light/dark manifest 通过。该问题暂归类为“hover/focus 分阶段采样缺失”，
等待并行 Visual QA 脚本修正后再判断 CSS cascade，不以此阻塞 Settings owner
施工。

并行动效线程当前阻断：`npm run test:ui-motion-contract` 要求 Tooltip 在
显示/隐藏时发布 `data-motion="enter|exit"`，但现有 Tooltip 源码尚未写入该
状态；Theme Presenter 单测通过，问题限定在动效合同实现。Tooltip 文件属于
并行未提交改动，本线不覆盖，待其补齐后再复跑动效与 UIUX 全套门禁。

2026-08-28 历史复测曾出现 Settings Electron gate 的 light/dark 背景差异和资源
`ERR_FILE_NOT_FOUND`。本轮已定位并修复这两个问题；packaged artifact-only Theme
Electron journey 同样通过：initial=`light/1`、dark=`dark/2`、reload=`light/1`、
subscribers=`2`。主题与 Settings 专项视觉阻断均已解除。

最新 `test-settings-wa-electron` 结果：SettingsRoot geometry、typed Field/Select
DOM、portal stacking、category switching 保留未保存值、无重复 search layer、light/dark
截图与 control geometry、保存重试、close-flush、reload/reopen、重复打开和 teardown
全部通过。门禁中的 OS window resize 仍因当前 Electron CDP 不提供
`Browser.getWindowForTarget` 而跳过，这只限制窗口尺寸自动化证据，不影响固定 viewport
截图与 Settings 行为验收。

本轮同时修复了两个真实渲染阻断：将模板中的无效
`path/to/xiaoke_avatar.png` 替换为仓库内的 `assets/default_avatar.png`，并为仍带有
`.modal-content` 兼容类的 SettingsRoot 面板增加 token 级 `!important` 覆盖，消除旧
CSS 对暗色面板的覆盖。Electron gate 不再报告 `ERR_FILE_NOT_FOUND`，暗/亮面板背景
分别计算且截图 hash 不同。测试驱动主题时同时发布 legacy class 和
`data-vcp-theme`，与现有 typed ThemePresenter 合同保持一致。

### G5：旧债净删除

按 section 删除：

- `:not(.vcp-harness-*)` 兼容 selector；
- 已由 generated primitive 取代的旧几何和 hover/focus 规则；
- 重复 listener、observer、timer 和 disposer；
- 无调用方 helper 与死 projection；
- 只为旧 bridge 保留的 fallback。

2026-08-28 增量：高级区条件显示与延迟值校验的旧 ambient listeners 已净删除，
校验语义由 typed owner 保持；该 section 的直接 presentation 债务已收口。

论坛凭据 owner 的监听器也已改为直接注册到 Settings presentation scope：两个
控件的 `input/change` 与 autosave 状态重试不再同时依赖手工 listener removal 和
scope cleanup。dispose 仍保留 timer 取消、dirty marker 清理和 pending save 的
业务语义；本切片只减少 presentation lifecycle 的重复清理路径。

同一原则已应用到 Agent 风格折叠行：generated DisclosureRow 之前已接管视觉与
ARIA，现在其 click/keydown 监听也直接归属 presentation scope；状态观察器和
属性恢复仍由记录对象负责。这样重复 mount/refresh 不会重新绑定同一 header，且
dispose 的监听器清理与其它 generated primitive 使用同一 owner 机制。

连续切片复核（2026-08-28）：`npm run test:uiux` 当前 90/90 通过；
`check-settings-source-equivalence`、`check-global-settings-section-ownership` 和
`check-agent-model-picker-legacy-parity` 均通过。source-equivalence 仍报告
`legacy.rows=0`、`legacy.inlineStyles=0`、`legacy.cssSelectors=0`，说明已收口的
Settings sections 没有重新引入直接竞争 projection；未收口的 legacy modal 与业务
fallback 仍由负向门禁明确保留。

字段 owner scope 化后的完整回归（2026-08-28）已通过：`npm run test:uiux`
88/88、`check:uiux:artifacts`，以及 `test:electron-agent-settings-interaction`。
真实 Electron 交互周期前后保持 41 个 active scopes、501 个 active resources、570
个 listeners，detached roots/options 均为 0，说明这次 listener 归属调整未引入
重开泄漏或 Agent Settings 交互回归。

Disclosure host 属性恢复修复后的 Electron 复测同样通过：Agent Settings 交互周期
前后节点 5830、listeners 570、active scopes 41、active resources 501，detached
roots/options 均为 0；generated artifact consistency 仍通过（78 个产物）。

#### G4/G5 收口记录（2026-08-28）

本轮完成当前迁移范围内最后一项生命周期收口：legacy autosave controller 的
`input`、`change`、保存结果和重试监听现在通过 Settings presentation scope 注册；
早期 bootstrap 没有 `LifecycleScope` 时才使用本地 disposer。保存队列、失败重试、
close-flush 和 canonical form 行为保持不变，scope 与模块 teardown 均为幂等操作。

结合此前完成的 Advanced、Rust、Render、Appearance、Identity、Forum、Agent
Disclosure、ModelPicker capability 拆分，G4 的真实调用方模块化与 G5 的直接竞争
presentation listener/CSS/projection 净删除均已完成。UIUX 95/95、Settings Electron
journey、artifact consistency、source-equivalence、section ownership 和 typed build
全部通过。

明确保留、不得在本批次强删的债务只有业务共享边界：全局提交兼容链、头像文件选择与
裁剪、无 artifact 时的 ColorPair fallback，以及被 `topicSummaryModel` 共享的
`modelSelectModal`。其中 `topicSummaryModel` 的 canonical 文本输入已接入 typed
field owner，legacy whole-form autosave 不再监听该字段；仍保留共享 modal，因为
Agent 模型和话题总结模型共用其目录、刷新、收藏和默认数据 caller。上述剩余债务
分别等待独立业务命令、完整默认数据 parity 或 caller 迁移后再退役。因此 G4/G5 状态定义为
`complete-with-explicit-business-exclusions`，而不是伪装成全仓库 legacy 清零。

### Topic summary field owner 收口（2026-08-28）

`topicSummaryModel` 的 native input 现在纳入 `TYPED_FIELD_DEFINITIONS`，由现有
typed Settings owner 负责 input/change 草稿、debounced save、snapshot projection、
close-flush 和 reload restore。模型选择按钮及共享 `modelSelectModal` 保持原状，仍
由 `settingsManager` 的业务目录能力负责；本切片只退役该字段的 legacy autosave
presentation 监听，不改变 persisted key、IPC 或话题总结业务语义。

验证：`npm run check:uiux`、`npm run test:uiux`（91/91）、
`node scripts/check-settings-source-equivalence.mjs` 通过。

### 头像异步回写生命周期收口（2026-08-28）

头像文件选择与裁剪仍保留原有业务链，但颜色提取 Promise 现在绑定本次选择的
generation，并要求原始 input 和所属 Settings modal 仍处于当前 active 状态后才允许
回写颜色控件。关闭、重开或连续选择新头像时，旧结果会失去提交资格；未改变头像保存、
裁剪、颜色提取 API 或 persisted key。由于 `event-listeners.js` 含有并行工作树改动，
本切片不单独提交整文件，待该文件归属明确后再固化。

### 设置页视觉与保存缺陷修复（2026-08-28）

在 G4/G5 的既有 owner 边界内完成一轮用户可见缺陷修复：

- 折叠 section header/summary 在窄侧栏不再使用会裁剪内容的固定高度，摘要允许完整换行；
- Agent 表单的自动保存状态现在可挂载到 Agent 自身的 action row，继续调用 canonical form submit；
- 显式“保存 Agent 设置”和“删除此 Agent”入口隐藏，删除业务命令与兼容 submit 节点保留；
- Agent 基础信息摘要、正则操作、TTS 模型刷新按钮移除液态玻璃背景、渐变、模糊和内阴影；
- TTS 语速继续使用 native range 作为业务节点，但 generated Range 增加 Harness 风格轨道、滑块和输出布局；
- 全局 SettingsRoot 移除导航标题下边线和左右分栏竖线。

本轮不改变 persisted key、IPC、settingsManager 保存/删除语义、聊天区域或任何冻结业务边界。
验证证据：`test:uiux` 91/91、`check:uiux`、`check:uiux:artifacts`、设置源码等价与
section ownership 门禁、`test:electron-agent-settings-interaction` 均通过；Electron 压力
周期前后 listeners=570、active scopes=41、active resources=501，detached roots/icons/options=0。

## 不作为阻塞条件

## 当前完成度快照（2026-08-28）

| 区域 | 状态 | 说明 |
| --- | --- | --- |
| G1 服务器连接 | stable-adoption | Input/Field 已接入，URL 归一化保留业务边界 |
| G2 身份/论坛 | owner-converged | ColorPair、Forum Input 装配与重复 listener 已收口 |
| G3 语音/高级 | owner-converged | Rust/Voice projection 与条件显隐已归 typed owner |
| G4 内部拆分 | complete-with-explicit-business-exclusions | 已拆 Advanced、Rust、Render、Appearance、Identity、Forum、Agent Disclosure、ModelPicker capability；legacy autosave listener 已归 presentation scope |
| G5 旧债净删除 | complete-with-explicit-business-exclusions | 直接竞争 listener/CSS/projection 已清理；仅保留有业务共享原因的 fallback，并有负向门禁 |
| Electron 视觉最终验收 | passed-settings-and-artifact-journeys | Settings 专项 gate 与 packaged artifact-only Theme journey 均通过；OS window resize 证据受 CDP 能力限制 |

补充证据：`test:electron-global-settings-entry` 已通过，确认 generated Settings
入口 Button 的 mount、click、modal close 和 teardown 在真实 Electron 中保持可用。
当前 Settings 专项视觉 gate 已完成；G4/G5 的 section controller 拆分与直接竞争
presentation 净删除已完成，剩余工作集中在共享 `topicSummaryModel` caller 的独立退役条件。

- 全量 Harness source parity；
- 每个字段的跨页面 pixel diff；
- Windows/packaged artifact-only 证据；
- source-only Candidate 的生产消费；
- ModelPicker legacy modal 全量退役；
- 聊天消息、流式、composer、工具结果、代码块和思维链重构。

这些可以作为增强证据，但不能阻塞 G1-G5 的高频设置产品收口。

## 每批 Definition of Done

- 真实控件由目标 generated primitive/Field owner 接管；
- native control、settingsManager、IPC、persisted key 不变；
- 同一节点没有双 presentation owner；
- 直接竞争的旧 CSS/listener/projection 已删除，或在批次报告中说明保留原因；
- Electron 首次打开、重开、reload、失败恢复、close-flush 和 teardown 通过；
- light/dark 与常见窗口尺寸没有明显溢出、遮挡或 cascade 回退；
- 变更和证据以独立提交交付。

## 当前启动动作

先对 G1 做只读 owner/CSS/listener 审计；若现有接入已经满足合同，则直接进入最小净删除，不重复包装 Input。完成后更新 `docs/global-settings-architecture-audit-2026-08-28.md` 的状态和本计划的批次记录。

## G1 审计结果（2026-08-28）

G1 当前已经满足“现有 generated Input + canonical native node”的接入条件，不需要重复挂载：

- `node scripts/check-settings-source-equivalence.mjs`：`shellSourceEquivalent=true`、`retiredBridgeOwners=true`、`harnessGeometry=true`、`legacyClean=true`；
- `node scripts/test-settings-wa-electron.mjs`：SettingsRoot、Input/Field/Select、portal、失败重试、close-flush、reload/reopen、网络路径和 teardown 全部通过；
- `vcpServerUrl` 的 blur `completeVcpUrl` 归一化仍属于业务保存语义，暂不删除；
- 当前没有发现连接字段可安全删除的独立 listener/projection，G1 进入“保持现状、等待 section controller 拆分”的状态，而不是强行改代码。

这说明全局设置已经在使用 Harness 风格组件；后续收口重点是拆分过宽 bridge、统一旧 CSS 层级和继续减少 legacy 竞争，不是重新接入 Input。

## 复核记录（2026-08-28，继续施工）

本轮按当前工作树重新核对了 G1-G5 及显式保留债务：

- `check:uiux` 与 `check:uiux:artifacts` 通过，generated Range 源码/产物一致；
- `test:uiux` 91/91 通过；
- Agent Settings production evidence 与 ModelPicker legacy parity boundary 通过；
- Electron Agent Settings interaction stress 通过，周期前后无 listener、scope、resource 或 detached DOM 增长；
- `modelSelectModal` 仍被 `topicSummaryModel` 共享，当前删除条件尚未满足；头像文件/裁剪、全局 submit 兼容链和无 artifact ColorPair fallback 仍分别承担业务或 bootstrap 责任，暂不进行 presentation 误删。

因此当前不是“全仓库 legacy 清零”，而是 G1-G5 的高频设置 presentation 收口已完成，剩余工作只在各自业务调用方和完整 parity 证据闭合后继续退役。目标保持 active。

### 真实渲染复核与基线边界（2026-08-28）

`test-settings-wa-electron.mjs` 已再次通过 SettingsRoot 的真实 Electron 验收：导航/标题/选项
布局、Field/Select DOM 与 geometry、portal stacking、分类切换保留未保存值、light/dark
截图、失败重试、close-flush、reload/reopen、重复打开和 teardown 均通过；窗口 resize 因
当前 CDP 不提供 `Browser.getWindowForTarget` 仍按既有规则跳过。`visual-qa-next-global-settings-controls.mjs`
的 light capture 通过，未发现控件 geometry 变化或 Range 输出失步。

完整 `check:ui-system` 当前仍会报告大量工作树中既有的主题、Harness reference 和其他
非本批文件不满足 subtraction allowlist；这些路径不属于本轮 global-settings 改动，不能用
来否定 SettingsRoot 的专项证据，也不能据此扩大本批次修改范围。目标继续保持 active。

### 共享颜色重置监听净删除（2026-08-28）

复核发现 `resetUserAvatarColorsBtn` 曾同时由全局 Settings modal 绑定路径和文件
后置初始化路径注册 click listener。后置重复 handler 已删除，modal 的
`setupResetUserColorsListener` 作为唯一业务入口，并继续通过 `listenerOwner` 管理
生命周期；颜色提取、表单字段写入、提示文案和保存协议保持不变。

`test:uiux` 91/91、`test:ui-system` 115/115、语法检查和 diff whitespace gate 通过。

### 全局设置监听 owner 收口（2026-08-28）

全局设置 modal 的关闭、提交、头像选择、头像裁剪入口、颜色重置以及
`modal-ready` 监听现统一通过 `setupEventListeners` 已有的 `listenerOwner` 注册；
没有改变 `handleSaveGlobalSettings`、头像 capability 或颜色业务逻辑。这样这些仍需
保留的业务监听也具备统一 teardown，避免 modal 重开或 renderer 销毁时形成裸监听。

`test:ui-system` 115/115、`test:uiux` 91/91、`check:uiux` 和 artifact consistency
继续通过。该切片完成的是生命周期归属，不代表头像裁剪或共享 model modal 已满足删除条件。

### 全局设置入口与 fallback listener 统一 owner（2026-08-28）

全局设置入口按钮、ColorPair fallback 的镜像监听，以及 Rust fallback 条件显隐监听
现在都通过 `setupEventListeners` 的统一 `addListener` 注册；fallback 的启用条件和
业务归一化保持不变。这样 production typed owner、Classic fallback 和 renderer
teardown 之间不再混用裸 listener 注册路径。

`test:uiux` 91/91、`test:ui-system` 115/115、`node --check modules/event-listeners.js`
和 `git diff --check` 通过。

### Artifact-only 复测边界（2026-08-28）

`test-electron-global-settings-entry.mjs` 通过，确认 generated Settings 入口 Button 的
mount、click、modal close 和 teardown。`test-settings-wa-electron.mjs` 与
`visual-qa-next-global-settings-controls.mjs` 也通过。

此前独立 Tooltip/HoverCard Candidate fixture 因只依赖窗口焦点触发 Tooltip 而出现不稳定
结果；已在 `scripts/test-electron-uiux-theme.mjs` 改为显式发送 `pointerenter`，并提交
`823aa06b`。当前 `npm run test:electron-uiux:artifacts` 已通过，artifact-only 全局证据
恢复闭合。Settings Select 重开路径另补充了关闭终态等待（提交 `1729857a`），避免测试
在异步 portal teardown 与下一次打开之间产生竞态。

### Agent Settings 窄栏与隐藏 action 回归收口（2026-08-28）

真实 Agent Settings 截图复核发现两处仅靠低优先级 fallback 无法保证的回归：
旧 SettingsShell grid 将折叠摘要压进标题列，且 generated Button 装配会把带
`hidden` 的兼容 submit/delete 节点重新设为可见。现已在统一 Settings tab 的
surface override 中强制使用 `"title toggle" / "summary summary"` 两行 grid，
并让隐藏 action 在 Button adapter 入口直接跳过。基础信息摘要改为普通平面框，
不会再被液态玻璃 fallback 覆盖。

证据：真实 Electron Agent Settings 截图已确认摘要不再与标题重叠，保存/删除
入口保持不可见；Agent Settings lifecycle stress（1 warmup + 1 measured cycle）
前后 nodes=5829、listeners=570、active scopes=41、active resources=497，
detached roots/options=0。新增静态合同覆盖 hidden action skip 与 compact summary
grid，`check:uiux`、artifact consistency、Settings bridge focused tests 均通过。

### Topic Summary ModelPicker 复用（2026-08-28）

`topicSummaryModel` 现在复用与 Agent 模型相同的 generated `AgentModelPicker`
装配函数：目录读取、热门/收藏分区、刷新、收藏切换、Escape、焦点恢复和 owner
dispose 均由同一 typed primitive contract 提供；native `#topicSummaryModel`
仍是唯一 canonical business/persistence 节点。旧 `modelSelectModal` 模板和
`settingsManager` 的共享目录 helper 暂时保留，避免在 Agent 与话题总结两个 caller
尚未完成完整 default-data parity 前误删业务能力。

本切片只增加一个 presentation owner，不创建第二份 durable model state，也不修改
IPC、persisted key 或话题总结业务逻辑。`check:uiux`、`test:uiux`（93/93）、
Settings source-equivalence、ModelPicker 专项 Electron journey 与 global Settings entry
Electron journey 全部通过。总 Settings journey 只保留模型目录 IPC capability 检查，避免
section bank 的关闭状态污染重复验证。下一退役条件仍是同时证明两个 caller 的默认数据、刷新/失败、
收藏、关闭竞态、reload 和 focus parity，之后才可删除 legacy modal。

### ModelPicker directory parity 复测（2026-08-28）

重新运行 `npm run test:electron-agent-model-picker-directory-parity` 通过。真实
`agentSettingsForm` + generated `AgentModelPicker` 已重复证明三分区投影、收藏 mutation
隔离、refresh success/empty/failure、close-race、迟到结果丢弃和 owner dispose 无残留。
这只强化 Agent caller 的 capability-contract 证据；`topicSummaryModel` 的 default IPC
directory parity 和共享 `modelSelectModal` 的删除条件仍未满足，因此本轮不删除 legacy modal。

### Topic Summary production consumer journey（2026-08-28）

`topicSummaryModel` 的真实 consumer 验收已移入独立 ModelPicker Electron journey，避免
总 Settings journey 在切换 section 后复用已关闭 modal 的 stale active 状态。独立 journey
继续覆盖 generated `AgentModelPicker` 的打开、目录投影、选择、Escape、关闭、reload、
focus restore 与 owner teardown；总 Settings journey 只验证注入的目录/热门/收藏 IPC capability。
这仍不等价于两个 caller 的完整 default-data parity，`modelSelectModal` 继续保留。

### ModelPicker legacy handler fallback gate（2026-08-28）

`settingsManager` 的 Agent 与 Topic Summary 旧 click handler 现在都检查 generated
picker marker：typed owner 已挂载时直接返回，仅在 Classic/bootstrap 没有 typed marker
的路径保留 `handleOpenModelSelect()` fallback。这样新旧 owner 不再依赖事件传播顺序
来避免双开；`modelSelectModal`、IPC、收藏/刷新业务和 canonical native input 均保持不变。

新增 focused contract 后，Settings bridge tests 为 28/28，`check:uiux`、artifact
consistency 与 ModelPicker legacy boundary gate 继续通过。

### Hot/favorite IPC 隔离阻断记录（2026-08-28）

审计 `modules/modelUsageTracker.js` 后确认热门/收藏状态固定落在仓库级
`AppData/model_usage_stats.json` 与 `AppData/model_favorites.json`，不跟随
`VCPCHAT_APP_DATA_DIR` 临时 profile。为避免测试污染真实开发数据，本轮没有直接写入
这些文件；因此两个 caller 的 default hot/favorite parity 仍是明确的外部状态阻断，
不是“测试没覆盖”。后续需增加显式 tracker data-root capability，并在保持生产默认
路径兼容的前提下重跑真实 IPC parity，之后才重新评估共享 `modelSelectModal` 退役。

本轮已增加 `VCPCHAT_MODEL_USAGE_DATA_DIR` 测试覆盖：未设置时保持生产默认
`AppData` 路径，设置后使用临时 profile，避免热门/收藏 parity 测试污染开发数据。
隔离层已通过 Settings Electron journey 和 ModelPicker directory parity journey。

当前复测已证明隔离 IPC 数据链可用：临时 HTTP 服务返回三条模型，hot metadata 为
`probe-hot`/`probe-secondary`，favorite metadata 为 `probe-hot`；Agent 真实 production
form 已通过三分区投影、favorite mutation、refresh success/empty/failure、close-race、
dispose-race 与生命周期稳定性证据。generated ModelPicker 首次 root → model pane 的
异步目录投影也已修复并由 focused tests 覆盖。剩余删除阻断收窄为 Topic Summary caller
的默认数据 parity 与共享业务 modal 的完整退役链，因此在此之前不删除 `modelSelectModal`。

本轮进一步修复目录首开时序：`agent-model-picker-directory.js` 现在优先消费
`refreshModels()` 返回的模型 payload，仅在刷新命令不返回模型时回读 renderer cache。
这样不会因 IPC cache 更新通知晚于 popup 首次 options load 而产生空目录；Agent directory
parity Electron journey 已复测通过。Topic Summary 仍需在真实 caller 上补齐同样的默认数据、
刷新失败和重开证据后，才能评估共享 modal 退役。

补充验证：default-mounted Agent ModelPicker 的真实 IPC refresh journey 也已通过（1 warmup
+ 1 measured cycle，listeners=571、active scopes=41、active resources=497，detached roots/
icons/options=0）。这证明默认 bridge → `chatAPI` → `refresh-models` → `models-updated` →
picker projection 链路稳定；剩余阻断仍仅针对 Topic Summary caller 和共享 legacy modal。

### 当前收口 checkpoint（2026-08-28）

- 不再重复拆分已经完成的 G4/G5 section helper；当前 bridge 剩余代码均有真实调用方或
  明确的 Classic/bootstrap 兼容职责。
- `settingsManager` 中 Topic Summary 的旧 click listener 继续保留为 fallback，但在
  generated marker 存在时立即返回；因此 production Next surface 不存在双 presentation owner。
- Agent 的 default refresh、隔离目录 parity、Shell close/reopen reconciliation 和全局
  Settings 专项回归均已有真实证据。
- 下一项只接受能增加 Topic Summary 真实证据或减少其共享 legacy 依赖的改动；不再以机械
  helper 拆分或新增字段迁移作为进度。

历史 fresh Electron 复测曾发现，Global Settings 在 modal 关闭/重开与 section 切换交错后
可能留下 `active` 标记，却未把对应 section 重新挂回可见 `sectionHost`。该 Shell 生命周期
切片现已修复：`mountSettingsShell()` 对已存在的 unified shell 执行
幂等 reconciliation，重新挂回 `active sectionHost`、清理 section bank 的 stale active
class，并同步 nav selected/tabIndex。Settings Electron journey 新增 close → reopen →
activate advanced → visible geometry 断言，已通过；这只修复 presentation host，不改变
section 选择状态的业务来源或表单持久化。
