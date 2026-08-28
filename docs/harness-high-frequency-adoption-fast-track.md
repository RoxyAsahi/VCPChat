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
| F1 | Agent Settings：名称、模型、参数、TTS、动作、折叠区 | Input、Range、Toggle、Choice、Select、Button、DisclosureRow 已有真实 consumer；继续按控件组收口 | `settingsManager`、保存协议、模型 modal 的 feature parity、TTS/聊天消费 | 每个已接管控件的重复 disposer、legacy enhancer、冲突 geometry selector |
| F2 | Sidebar Account tray | Button 已接入；维持真实菜单 controller | 32px icon trigger、导航和 theme command | 已接管 action 的旧 presentation selector |
| F3 | Notification quick-actions | 中性 Button 已接入；补 selectable `menuitemcheckbox` 与 danger menu-item adoption | `NotificationMenuController` command routing、filter subscription、clear confirmation/业务语义 | filter/clear 的局部 hover、selected、danger presentation 分支 |
| F4 | App tray drawer | Button/Tooltip 已接入通用 drawer rows | 32px Fixed Dock 定制 geometry | 已接管 row 的旧 action presentation |
| F5 | Launchpad cards | 先建立 app-launch tile contract，再接入动态 controller | app launch command、embedded app lifecycle、特殊卡片 | 手工 DOM/CSS 的 card-only presentation |

F1--F4 可并行，但同一真实 DOM 节点只允许一条施工线；F5 在 tile 的 Harness
source provenance 登记后开始。聊天消息、工具结果、思维链、composer 内部布局和
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
