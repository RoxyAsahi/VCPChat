# Chat Kernel 后续架构开发基线

更新日期：2026-08-22。

本文记录 D5/D6 收口后，结合 DeepSeek Harness 架构、测试和 defensive 规范形成的后续开发基线。本文不改变当前 D0-D7 完成标准，也不把 VCPChat 变成 Cordis/DeepSeek Harness；它只定义下一阶段可独立推进的架构方向。

## 当前前提

VCPChat 已经完成 Chat Kernel 的关键拆分：`StreamSession`、`StreamCoordinator`、History Authority、Surface projection、Main Chat composition、显式 RenderDependencies、operation identity、quiescent dispose 和 legacy facade 分层退役。

当前 D7 仍受发布证据阻塞，后续架构开发不能把未完成的 Windows/打包/GPU-DPI/人工 soak 证据当作已完成。新路线必须保留主聊天发送、流式、取消、重试、历史切换、附件、主题、通知、Voice/Rust、Classic 和插件协议行为。

## 三个核心差距

### 1. 类型和协议表达

#### 当前状态

Stream 核心已有 terminal normalization、operation identity、generation、immutable DTO 和迟到结果隔离。`chatEventContract.js` 已经提供局部 contract，consumer/facade gates 也能阻止一部分责任回流。

但核心仍以 JavaScript 和运行时约定为主。`conversationKey`、`operationId`、`messageId`、`topicId`、`sessionId` 多数仍是普通 string；DOM `CustomEvent`、preload subscription、renderer callback、IPC channel 和公共插件协议没有统一的 discriminated contract。

#### 与 DeepSeek Harness 的差距

Harness 的事件和服务通常同时声明 mode、payload、producer、consumer、durability、terminal、生命周期和边界校验，并使用 discriminated union、声明合并和 branded id。VCPChat 当前更多依靠 owner 约定、静态门禁和 focused tests，尚未形成一套可生成的统一协议面。

#### 实际风险

- 把不同语义的 identity 互相传递，运行时仍可能接受。
- `cancelled`、`discarded`、`disposed`、`failed`、`timeout` 在不同模块中的含义不完全一致。
- IPC consumer 主要依赖方法名、参数顺序和隐式字段。
- 公共 facade、插件命令和内部事件可能互相渗透。

#### 最小补法

1. 先为 stream/history/surface 建立逻辑事件定义，不改变传输实现。
2. 为跨 owner identity 提供 branded constructors，优先覆盖 operation、conversation、message。
3. 为 terminal 建立统一 discriminant 和 reason vocabulary。
4. 为 preload/public plugin 协议补充 schema、版本和边界校验。
5. 新代码使用定义和 discriminant；旧代码在触及时迁移，不做全仓一次性 TypeScript 改造。

首个实施范围对应 `chat-event-producer-consumer-roadmap.md` 的 E0/E1：inventory、schema、定义、生成报告和负向门禁。只有这套闭环能发现真实错误后，才进入 Stream 事件实现迁移。

### 2. 持久事实模型

#### 当前状态

VCPChat 已经把实时流状态、terminal arbitration、history persistence、mutation authority 和 DOM projection 分开。StreamCoordinator 负责 reader/abort/persistence queue，Surface 不再拥有 durable authority，主聊天与独立 Surface 通过 conversation identity 隔离。

#### 与 DeepSeek Harness 的差距

Harness 使用 append-only typed session event log 作为模型上下文、恢复、projection、telemetry 和 replay 的共同事实来源，并遵循 “model-visible means logged”。VCPChat 当前仍主要以聊天历史/消息数据作为 durable truth，stream transient state 和 projection runtime 是独立运行时状态，还不是统一可重放的 session log。

#### 实际风险

- 一次发送的 requested、stream、cancel、terminal、persisted/failed 事实分散在多个 owner 和 artifact。
- reload/crash 后可以恢复最终历史，但不一定能重建完整 operation 因果链。
- 跨窗口、跨 Surface 和插件的 operation 审计需要组合多处运行时信息。
- 如果未来直接增加日志而没有唯一 authority，可能产生第二份 history/state。

#### 最小补法

1. 先生成测试/诊断 transcript，不改生产 history authority。
2. 先登记关键 durable facts：message requested、stream terminal、history persisted/failed、message retracted。
3. 为 transcript 建立 keyless replay，验证用户可见结果、terminal 和 persistence outcome。
4. 只有在确有 session resume、crash recovery、跨 Surface 审计或插件共享事实需求时，才评估生产级 append-only log。

#### 明确不做的事

- 当前阶段不替换现有 history 文件格式。
- 不把所有 stream chunk 永久落盘。
- 不让 transcript 成为第二份业务状态。
- 不在事件 owner 尚未稳定前设计 session migration。

### 3. Capability seam 完整度

#### 当前状态

`ChatRepository`、`StreamCoordinator`、`ChatSurface`、RenderDependencies 和 named owners 已经接近 Service Definition、Provider、Consumer 三角色。测试可以使用 memory repository、surface adapter 和显式 capability，主聊天不再依赖旧的全局 stream/history facade。

#### 与 DeepSeek Harness 的差距

Harness 的 capability seam 以可替换的 Definition/Provider/Consumer 为完整单位。VCPChat 的 `electronAPI` 仍是宽总 capability，同时承载 query、command、subscription、history、theme、window、file、voice、desktop、plugin 和辅助窗口能力。很多 consumer 虽然只需要其中少量方法，却在构造时拿到了整个 Electron API。

#### 实际风险

- consumer 的真实依赖范围不透明。
- 单元测试需要宽 mock，容易掩盖缺失方法。
- provider 替换、独立 Surface、memory/offline runtime 和 browser-like test 不够简单。
- 权限边界和生命周期 ownership 不清晰。
- 新功能容易继续把方法添加到 `window.electronAPI`。

#### 最小补法

1. 第一阶段不改 preload，先在 composition 层从 `electronAPI` 截取窄 capability。
2. 优先建立 `ChatHistoryCapability`、`StreamTransportCapability`、`ThemeCapability`、`NotificationCapability` 和 `WindowCommandCapability`。
3. 每个 capability 只暴露真实 consumer 所需的方法，并记录 provider、consumer、failure、dispose 和 smoke。
4. 真实 consumer 迁移后，再考虑增加窄 preload API；旧 `electronAPI` 保留为兼容 facade。
5. `MainChatCommands`、`VCPAppearanceStudio`、Classic 和插件协议继续作为 public protocol，通过 adapter 进入内部 capability，不直接当作内部事件总线。

#### 判断标准

只有当 provider、consumer 或生命周期真正独立演进时才建立新的 seam。单纯包装一个函数、复制一个宽 API 或为测试制造空对象，不算完成 capability 解耦。

## 三个方向的依赖顺序

```text
类型/协议定义
    -> 明确 event、identity、terminal 和 payload
Capability seam 收窄
    -> 明确 producer、consumer、owner 和 transport
Transcript/replay
    -> 明确哪些事实需要 durable、可恢复和可审计
生产级 append-only log（仅在需求成立时评估）
```

不建议先建生产级 session log：如果 event 和 capability owner 尚未明确，日志只会把当前隐式关系永久保存下来。

## 后续开发路线

### N0：保护当前收口成果

- 维持 D5/D6 静态门禁和当前行为矩阵。
- D7 证据继续独立收口，不把后续架构实验混入发布结论。
- 保持用户已有 `styles/themes.css`、`audio_engine/AppData/` 和测试 artifact 边界。

### N1：类型/事件定义闭环

- 执行事件路线 E0/E1。
- 建立事件 inventory、定义 schema、producer/consumer graph 和 invalid definition test。
- 先录入 5-8 个 stream/history/surface 高价值事件。
- 不改变 IPC、DOM CustomEvent 或 StreamCoordinator 的生产行为。

### N2：Stream 事件实现

- 迁移 Coordinator -> StreamConsumer 的 started/chunk/terminal 接缝。
- 统一 terminal/reason、sequence、generation、conversation identity 和 callback failure 语义。
- 保留现有 projection runtime、persistence authority 和真实 Electron sequence。

### N3：Capability 收窄

- 从 renderer composition 层建立窄 capability closure。
- 迁移 ChatRepository、settings/presentation、notification、stream 和 window command 的真实消费者。
- 每个迁移切片必须有 focused tests、Chat Kernel/UI、consumer gates 和受影响 Electron smoke。

### N4：Transcript/replay

- 记录关键请求、stream terminal、persistence outcome 和 projection outcome。
- 建立 keyless replay/snapshot，验证外部 DOM/ARIA、history、terminal 和错误结果。
- 只记录满足隐私和体积约束的事实，不默认永久保存全部 chunk。

### N5：生产级 session log 评估

- 以真实 crash recovery、session resume、跨 Surface audit 或插件共享需求为触发条件。
- 先做格式、版本、迁移、损坏恢复、隐私、写入成本和 authority 评审。
- 没有明确需求时，保持 transcript/replay，不引入第二份 production log。

## 每个切片的验收合同

- 代码边界：producer、consumer、owner、transport、durability、terminal、dispose 全部登记。
- 静态证据：源码引用与定义一致；未知事件、未登记 facade、provider 自证 consumer 失败。
- 单元证据：payload、顺序、错误、取消、重复 terminal、迟到结果、dispose drain。
- 集成证据：`test:chat-kernel`、`test:ui-system` 和受影响的 Classic/Next/consumer gate。
- 真实入口：主聊天、UI Apps、辅助窗口或 preload/插件 smoke，按影响面选择。
- 外部世界：IPC 顺序、持久文件、DOM/ARIA、listener/resource、detached roots 和进程树。
- 文档：只更新对应事实源，不复制过期测试数字；非平凡决策写入同一 PR。

任何未解释的 IPC、持久化、terminal、DOM、焦点、ARIA、listener、resource 或协议差异，都会阻止该切片宣称行为等价。

## 当前优先级

| 优先级 | 事项 | 原因 |
| --- | --- | --- |
| P0 | D7 发布证据和 packaged artifact 问题 | 这是当前完成声明和发布可信度的直接阻塞 |
| P1 | N1 事件 inventory/schema/graph | 范围小、能直接发现未登记边界和责任回流 |
| P1 | N3 窄 capability closure | 防止 `electronAPI` 和 renderer 重新膨胀 |
| P1 | N4 最小 transcript/replay | 以低风险获得恢复和诊断能力 |
| P2 | N2 全 stream 事件迁移 | 需要先有可靠定义和图谱 |
| P2 | N5 production append-only log | 只有真实需求成立才值得承担格式和迁移成本 |

## 结论

下一阶段的目标不是“让代码看起来像 DeepSeek Harness”，而是把已经在 Chat Kernel 中验证的原则扩展成可持续的制度：类型事件、最小 capability、可审计 owner、真实入口证据和可重放事实。顺序必须是先定义、再收窄、后持久化；先保护当前行为等价，再增加能力。

