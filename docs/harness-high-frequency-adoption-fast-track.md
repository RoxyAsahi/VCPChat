# Harness 高频组件接入快车道

> 施工状态：active（2026-08-28）。
> 
> 目的：以更短的端到端批次，把已经具备 generated artifact 与基本
> interaction/lifecycle 合同的 Harness Candidate，接入 VCPChat 的高频、
> 非冻结真实 Surface。特殊定制控件保持现状，直到存在同语义 contract。

## 交付规则

每个切片必须是可独立审查、可回滚的单一提交：

```text
已有 Candidate primitive
  -> 一个真实高频入口
  -> 保持 canonical DOM / command / persisted key
  -> 一个 presentation owner
  -> 删除直接竞争的旧 CSS、listener 或 projection
  -> focused test + artifact gate + Electron journey
```

不等待整页重构，也不等待全套像素等价证据才开始真实接入；但在 DOM、
computed style、interaction、legacy retirement 和平台证据闭合前，状态只能是
`production-consumer-active`，不能称为 `Stable`。

## 加速执行规则（2026-08-28）

后续不再按“一个 Candidate 完成全部深度 parity 才允许下一个”的串行方式施工。
改为两条互不混淆的并行车道：

```text
接入车道：已有 generated Candidate
  -> 同语义、高频、非冻结的真实 consumer
  -> 保持 canonical business DOM/state
  -> 删除该节点直接竞争的 presentation debt

等价车道：Harness source/reference
  -> DOM/CSS/interaction/pixel evidence
  -> Visual Forensics 真正页面巡检
  -> 决定是否可以升为 Stable
```

这允许在不触碰业务边界的前提下成组提升真实产品覆盖率，同时不把“已经挂载”
误报成“已经像素等价”。一个批次只允许复用已存在且语义相容的 primitive；没有
Harness 同语义 contract 的特殊控件保持 bespoke，不为了统一而替换。

### 下一批次的批量范围

| 批次 | 允许快速应用 | 明确保留 bespoke | 完成定义 |
| --- | --- | --- | --- |
| Wave A | Agent Settings 中已经有 Input/Toggle/Choice/Range/Select/Button/ColorPair contract 的 canonical 节点 | 模型 modal 的 hot/favorite/refresh 直到 feature parity；任何聊天参数和 TTS 业务语义 | 每个节点一位 presentation owner，删除相应重复 listener/CSS/projection，跑 Agent Electron journey |
| Wave B | Account、Notification、App drawer 的普通文字 action/row（Button、Tooltip） | 32px Dock/topbar icon trigger、`menuitemcheckbox` filter、danger clear | controller/command/focus 不变，真实 theme/窄视口/Escape/reopen evidence 通过 |
| Wave C | 已有同语义 contract 的 Settings 普通表单字段 | 无 contract 的专用 picker、复杂编辑器、业务组合 widget | 不改 persisted key/IPC，接入后旧 field-level presentation path 可删除 |

优先选择“一次能覆盖多个同构真实节点”的组，例如一组普通操作按钮或一组已有
native canonical form fields；不把时间消耗在低频 DiffBlock、展示页专用样例或冻结
聊天内容上。每组仍按一个可回滚提交交付，避免把并行修改混成大包。

## 当前优先队列

| 顺序 | 真实入口 | 复用组件/缺口 | 保留不动的业务与定制部分 | 本切片可清理的债 |
| --- | --- | --- | --- | --- |
| F1 | Agent Settings：名称、模型、参数、TTS、动作、折叠区 | Input、Range、Toggle、Choice、Select、Button、DisclosureRow 已有真实 consumer；TTS Range/ColorPair 与 Voice Select 的直接旧 presentation 已退役 | `settingsManager`、保存协议、模型 modal 的 feature parity、TTS/聊天消费 | 每个尚未接管控件的重复 disposer、legacy enhancer、冲突 geometry selector |
| F2 | Sidebar Account tray | Button 已接入；维持真实菜单 controller | 32px icon trigger、导航和 theme command | 已接管 action 的旧 presentation selector |
| F3 | Notification quick-actions | 中性 Button 已接入并有真实视觉证据；Harness Menu 无 `menuitemcheckbox` contract，因此 filter/clear 保留专属语义 | `NotificationMenuController` command routing、filter subscription、clear confirmation/业务语义 | 仅在存在同语义真源时处理 filter/clear 的局部 presentation |
| F4 | App tray drawer | Button/Tooltip 已接入通用 drawer rows | 32px Fixed Dock 定制 geometry | 已接管 row 的旧 action presentation |
| F5 | Launchpad cards | Harness 没有可追溯 app-launch tile；暂不伪造 primitive，动态卡片已改为结构化 DOM | app launch command、embedded app lifecycle、特殊卡片 | 未来仅在找到真源 contract 后处理 card-only presentation |
| F6 | Global Settings：外观、首页、身份、网络与论坛普通字段 | SettingsRoot、Field、Input、Select、Range、Toggle、Choice 已是 production consumer；2026-08-28 Electron journey 覆盖真实保存、失败重试、close-flush、reload/reopen 和 teardown | 聊天字体/消息渲染配置的业务效果与聊天渲染保持冻结；专用 picker 保持原路径 | 仅处理对应字段的重复 presentation owner、冲突 selector 和无调用方 fallback |

F1--F4 可并行，但同一真实 DOM 节点只允许一条施工线；F5 在 tile 的 Harness
source provenance 登记后才允许作为 primitive 施工。聊天消息、工具结果、思维链、composer 内部布局和
所有聊天核心仍绝对冻结。

## 快速验收门槛

每个接入只运行与风险相称的证据，不为小切片反复跑整库：

1. `npm run build:uiux`、`npm run check:uiux`、`npm run check:uiux:artifacts`；
2. 该 controller/primitive 的 focused test；
3. 真实 Electron 打开、重复打开、Escape/外点、theme 和窄视口路径；
4. `npm run guard:chat-kernel-consumers`；
5. 仅当修改了 shared Settings/overlay owner 时，再补对应 lifecycle stress。

Visual QA 并行记录 geometry、cascade、portal clipping 和 focus/disabled/selected
状态。发现问题时先修该切片的最小 CSS/owner seam；不借机扩张成 Settings 或
Shell 大重构。

## 不进入快车道的项目

- 仅在展示页出现、没有合法生产 consumer 的 Candidate；
- 需要改变 persisted key、IPC、聊天参数组装或业务 state 的控件；
- 32px dock/icon、复杂图表等故意定制的视觉控件；
- DiffBlock、Markdown、工具结果、会话内容、composer 和流式 UI。

## 当前成熟度说明

当前的真实接入证明了“可快速接入并单 owner 运行”，并未证明所有控件已经达到
DeepSeek Harness 的生产像素等价。等价链（Harness provenance → DOM/CSS →
interaction/lifecycle → Electron/pixel → legacy retirement）继续作为晋级条件，
不会因为快车道而被跳过。

## 已验收的快车道切片

| 切片 | 提交 | 已闭合的实际边界 | 仍未闭合 |
| --- | --- | --- | --- |
| Agent TTS Range | `a6d5e7ed` | generated Range 唯一投影 `#ttsSpeedValue`；移除 Manager listener 与 id-specific layout CSS；Electron restore/stress | Harness Range 同语义 DOM/geometry/pixel |
| Agent ColorPair | `ff41430f` | generated ColorPair 唯一同步/invalid rollback/preview owner；移除 Manager listeners；Electron restore/stress | Harness 生产 consumer 与 pixel evidence |
| Agent TTS Voice Select | `0dca6c47`、`49d436dd` | native select 保持 business/options owner；typed Select 管理 portal/keyboard；legacy Agent Select CSS 排除 typed native node | Harness Select 同语义 DOM/geometry/pixel |
| Account menu actions | `1f3285c8` | 三个普通 action 使用 generated Button；controller 保留 command/focus/theme owner | production visual equivalence、legacy action CSS deletion |
| Notification neutral actions | `b1ab4b8c`、`76f65312`、`b5f0335a` | 五个普通 action 使用 generated Button；light/dark/三视口 Electron QA | checkbox/danger 没有同语义 Harness contract，故不迁移 |
| Launchpad catalog DOM | `1fdf7838` | runtime app name 使用结构化文本节点；render scope/commands/keyboard 不变 | 无 Harness app-tile 真源，不能宣称 primitive equivalence |
| Global Settings high-frequency field baseline | 2026-08-28 `test-settings-wa-electron` | 真实 SettingsRoot 中的普通 Input/Field、6 个 Appearance Select、3 个 Appearance Range、Home Toggle、Choice、portal menu、失败重试、close-flush、reload/reopen、owner teardown 全通过 | 全 Surface Harness DOM/computed-style/pixel 对照、artifact-only Electron 和 Windows evidence；聊天输出视觉仍不在本切片 |

这些切片都是 `production-consumer-active` 或 presentation-debt reduction，均不是
`Stable`；任何能改变业务命令、IPC、持久化或冻结聊天 Surface 的扩张仍然不在快车道内。
