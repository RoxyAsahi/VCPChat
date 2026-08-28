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

## 当前优先队列

| 顺序 | 真实入口 | 复用组件/缺口 | 保留不动的业务与定制部分 | 本切片可清理的债 |
| --- | --- | --- | --- | --- |
| F1 | Agent Settings：名称、模型、参数、TTS、动作、折叠区 | Input、Range、Toggle、Choice、Select、Button、DisclosureRow 已有真实 consumer；TTS Range/ColorPair 与 Voice Select 的直接旧 presentation 已退役 | `settingsManager`、保存协议、模型 modal 的 feature parity、TTS/聊天消费 | 每个尚未接管控件的重复 disposer、legacy enhancer、冲突 geometry selector |
| F2 | Sidebar Account tray | Button 已接入；维持真实菜单 controller | 32px icon trigger、导航和 theme command | 已接管 action 的旧 presentation selector |
| F3 | Notification quick-actions | 中性 Button 已接入并有真实视觉证据；Harness Menu 无 `menuitemcheckbox` contract，因此 filter/clear 保留专属语义 | `NotificationMenuController` command routing、filter subscription、clear confirmation/业务语义 | 仅在存在同语义真源时处理 filter/clear 的局部 presentation |
| F4 | App tray drawer | Button/Tooltip 已接入通用 drawer rows | 32px Fixed Dock 定制 geometry | 已接管 row 的旧 action presentation |
| F5 | Launchpad cards | Harness 没有可追溯 app-launch tile；暂不伪造 primitive，动态卡片已改为结构化 DOM | app launch command、embedded app lifecycle、特殊卡片 | 未来仅在找到真源 contract 后处理 card-only presentation |

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

这些切片都是 `production-consumer-active` 或 presentation-debt reduction，均不是
`Stable`；任何能改变业务命令、IPC、持久化或冻结聊天 Surface 的扩张仍然不在快车道内。
