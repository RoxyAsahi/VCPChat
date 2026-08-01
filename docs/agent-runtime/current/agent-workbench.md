# Agent Workbench

## 产品目标

Agent 页面应获得与 VChat 主聊天一致的消息阅读和操作体验，同时保持数据层正确：主聊天历史、Agent Projection SQLite、Codex Thread 三者不能混写。

借鉴 Cherry 的机制是“Session 持久展示与 Runtime 执行分离”，不是复制其 AGPL 代码、SQLite schema、Claude SDK 或工具系统。

## Renderer 数据模型

```text
selectedSessionId
  -> SQLite snapshot
     -> AgentMessage[]
        -> AgentBlock[]

activeRuntimes: Map<sessionId, thread activity>
globalApprovals: Codex native + VCP local/backend（identity 分离）
```

Renderer 只保存当前页面 projection、草稿、展开状态、滚动锚点和菜单状态。完整 transcript 来自 SQLite；执行身份来自 Main/Codex。

## Session UI 状态机

R5.1 不再散落维护 `isLoading`、`isStreaming`、`waitingApproval` 等互相覆盖的布尔值。按 [reuse-register.md](reuse-register.md) 借鉴 vcp-code-2.0 `sessionStateMachine.ts` 的 transition 机制，建立纯 Renderer reducer：

```text
idle -> creating -> streaming
                  -> waiting-native-approval
                  -> waiting-vcp-approval
                  -> waiting-user-input
                  -> completed | interrupted | error | orphaned
```

所有 transition 输入必须携带已有 Session/Thread/Turn/request identity。状态机只决定按钮、徽标和提示的投影，不决定 Codex 是否正在执行，也不能根据当前选中 Session 猜测事件归属。取消 A、审批 B、查看 C 必须是互不污染的 fixture。

## Session 切换

点击 Session 的固定流程：

1. 立即更新 selected row。
2. 从内存 LRU 或 projection-only SQLite read 显示 snapshot。
3. snapshot 可见后，以 detached `ensure-session-runtime` 对当前 Session 做有界 `thread/start`/`thread/resume`
   预热；该步骤不创建 Turn、不发送模型请求，也不停止其他 Thread。
4. 后台 `thread/read` 对账。
5. 新 snapshot 仅在 selection 仍匹配且 generation 更新时应用；发送复用同一 warm promise。

当前实现已经将 Session 目录切到 projection-only SQLite 快路径：Main 负责 canonical Agent identity，
schema v3 保存 `agentCatalogId/agentNameSnapshot`，旧 `Nova` 可受控迁移到唯一 folder ID；Renderer 不再
用原始字符串二次过滤。迁移规则和性能门槛见
[workbench-experience-roadmap.md](workbench-experience-roadmap.md) UX-R1。

多个 Codex Thread 可同时运行。切换视图不禁用当前 Session composer，也不把后台 Thread 的 transcript 写入当前 feed。sidebar 只显示每个 Session 的轻量 running/approval/error 状态。

## Message/Block 适配

Codex Item 和 ToolBox 结果先转为规范 Block，DOM 不理解 JSON-RPC、SQLite 或 ToolBox 协议：

| Block | 来源 | 展示 |
|---|---|---|
| message | userMessage/agentMessage | 主聊天同构气泡、Markdown 和动作。 |
| reasoning | reasoning | 默认折叠 summary/detail。 |
| tool | command/file/MCP/dynamic tool | requested/running/completed/failed 卡片。 |
| attachment | image/audio/file/resource | 缩略图、文件名、大小、打开/复制安全动作。 |
| approval | Codex/VCP approval | 来源标签、风险内容、allow/deny。 |
| observation | plan/compaction/VCPInfo | 只读结构化卡片。 |
| error | runtime/projection/tool error | 明确错误和恢复动作。 |

Block 使用 `itemId/callId + ordinal` 作为稳定 key。delta 原地更新对应 row；完成后执行完整 Markdown/代码块后处理。不得对整个 feed 使用 `replaceChildren()`。

### VCP marker 净化

R4.2 优先复用 vcp-code `vcp-content.ts` 的 `VCP_DYNAMIC_FOLD`、`VCPINFO` display/history/notification 分离和测试 fixture，再适配为 `AgentBlock[]`。Marker parser 只负责展示与历史净化：

- `VCP_DYNAMIC_FOLD` 显示可展开正文，持久投影只保留受限摘要；
- `VCPINFO` 显示结构化 observation/notification，不把原始大 JSON 回送 Codex；
- `TOOL_REQUEST` 显示 protocol warning 并从正文净化，绝不执行；
- 正常工具调用只来自 Codex `item/tool/call`，不得建立第二条 marker 工具通道。

## 与主聊天复用

应复用：

- Message DOM 语义 class、头像、时间和设计 token；
- Markdown、LaTeX、Mermaid；
- 代码高亮和复制；
- 表格、链接、图片；
- reasoning 折叠；
- VCP marker 纯展示/净化；
- 完成后 post-processing；
- 滚动 follow mode 和 anchor；
- 上下文菜单视觉与通用复制/转发动作。

首阶段不直接调用原 `renderer.js`、主聊天 `streamManager` 或隐式全局 refs，因为它们仍绑定：`currentChatHistoryRef`、`currentSelectedItemRef`、`currentTopicIdRef`、`saveChatHistory`、普通聊天编辑/重试/分支和全局消息容器。

当前实现已采用完整 Fork + 纯 presentation adapter：`agent-presentation/fork/agentMessageRenderer.js` 以主聊天展示代码为基线，所有 Session、participant、messages 和 settings 均显式注入；业务动作由 Agent action adapter 提供。主聊天 legacy renderer 未修改。

## 动作语义

| UI 动作 | Agent 实现 |
|---|---|
| 复制消息/代码 | 只读展示内容。 |
| 转发 | 生成普通聊天/目标输入的内容副本，不修改 Codex Thread。 |
| 取消 | `turn/interrupt(threadId, turnId)`。 |
| 编辑旧消息 | `thread/fork(lastTurnId)` 后在新 Session 发送编辑内容。 |
| 从旧消息重试 | `thread/fork(lastTurnId)` 后新 Turn。 |
| 分支 | `thread/fork` 创建新 VChat Session。 |
| 删除 Session | 先 VChat archive；Codex archive/delete 单独确认。 |
| 工具详情 | 展示原生 item/bridge 结构化结果，不重新执行。 |

任何动作都不得仅修改 SQLite 并声称改变了 Codex 上下文。

## Composer 与附件

- 使用主聊天按钮尺寸、自动高度、IME、快捷键和 disabled 视觉。
- Session snapshot 可见后会通过 `ensure-session-runtime` 后台有界预热；发送复用同一
  `sessionId -> warmPromise`，不会重复 `thread/start/thread.resume`。VChat proactive warm LRU 首轮上限为 2。
- 首发占位已改为 Renderer-only presentation Message Part，通过 Full Fork 获得完整头像、名称、气泡骨架
  和主聊天 `.streaming` 流光；它不进入 SQLite，也不伪造 Codex Item identity。真实 assistant/reasoning
  Item 到达后由 keyed timeline 移除临时 Part。
- 图片/音频/文件只通过 Main 选择和验证，Renderer 持有 descriptor。
- 草稿按 Session 保存在 Renderer 生命周期内；切换失败不清空。
- App Server ACK 后显示 sending；Codex user Item/SQLite projection 确认后转 durable。
- crash 时显示 unconfirmed，不自动重放，重连后以 `thread/read` 对账。

设置页的模型选择遵循 Cherry 的 Session-scoped 机制：有选中 Session 时保存到该 Session 的 `configSnapshot.model`，从下一次 Turn 生效；未选中 Session 时才写入新 Session 默认模型。模型-only 保存不得覆盖该 Session 已有的审批策略。

## 审批中心

- Codex 原生 command/file approval 按 Thread 显示。
- VCP local approval 保留 Session/Turn/call 绑定。
- ToolBox backend approval 在无法可靠关联 Thread 时作为全局审批。
- 切换 Session 不隐藏审批。
- Workbench 关闭、请求过期或 Runtime crash 时 fail-closed。

## 通知与观察中心

R5.3 借鉴 vcp-code `VcpInfoNotifications` 和 ExtensionState 的 200 条 bounded ring、未读水位及 typed status，但不复制 `VcpCapsule` 视觉。Main/Rust Bridge 先完成限长、去重、脱敏和分类，Renderer 只维护最近 N 条临时 observation projection：

- 有可靠 Thread identity 时显示 Session/Agent 标签；没有时保持全局；
- Session 切换不能清空未读通知；
- 原始大 JSON、API Key 和凭据不得进入 Renderer 或 SQLite；
- observation 默认不进入 `agent_messages`，需要持久展示时写有大小上限的独立 Block；
- 通知不能自动写回模型，也不能伪装为当前 Turn 的工具事件。

## 性能要求

- SQLite/cache 命中：同一帧或下一个 animation frame 显示 feed。
- 冷 Session：只显示 feed 局部 loading，不清空 sidebar/header/composer。
- 10 个 Session 连续切换：App Server PID 不变，后台 Thread 不停止。
- 流式 delta 按 animation frame 合并，避免 O(N^2) Markdown 重绘。
- 用户不在底部时，delta、tool status、详情展开不得抢走滚动位置。
- sidebar keyed row 更新，刷新不改变 row identity、搜索值和 scroll anchor。

## 当前实现状态

已完成基础接线：SQLite snapshot -> Workbench projection、单 Message keyed patch、active runtime 与 selected Session 分离、fork controller/API、Full Fork presentation/animation-frame batcher、首发 thinking barrier、Session 模型保存、JSDOM mount/store 回归，以及真实 Electron preload/IPC 的空 Session/Thread/Projection smoke。Workbench Message row 现在默认使用 Full Fork；`legacy` 仅作为隐藏环境回退保留。结构化工具等非 Message Block 继续使用 Agent 专用 keyed renderer，不建立第二套 transcript 真源。

Full Fork 已清除 `currentChatHistoryRef`、`currentSelectedItemRef`、`currentTopicIdRef`、`saveChatHistory`、主聊天 `streamManager` 和主 context menu 依赖。主聊天/Fork golden fixture 覆盖 reasoning、Markdown 表格、LaTeX、代码、Mermaid、链接、图片、VCP marker 与附件，并比较规范化关键 DOM。编辑、重试、分支、取消已接真实 Codex action adapter；转发目前为安全的剪贴板交接，不调用绑定主聊天 history identity 的旧转发 modal。

### 2026-07-31 首发与模型设置收口

- 新 Topic 首次发送在等待 Runtime warm、`turn/start` ACK 和首个 Codex Item 期间，会显示不落库的
  presentation-only Message Part；它由 Full Fork 渲染完整 Agent 头像、名称、消息骨架、
  `thinking-indicator` 与 `.streaming` 流光。真实 assistant/reasoning Item 到达后 keyed timeline 接管。
- 设置页模型保存按 Cherry 的 Session-scoped 机制写入当前 `configSnapshot.model`；模型-only 更新保留原审批策略。无选中 Session 时才更新新 Session 默认模型。
- 当前实际 Message renderer：`VCP_AGENT_PRESENTATION_RENDERER` 未设置时为 `fork`，入口是 `createAgentMessagePresentation()` -> `agent-presentation/fork/agentMessageRenderer.js`；`legacy` 仅为显式回退。

checkpoint 收据：以上实现进入 `29c2068a`；`npm run test:agent-workbench`、`npm run test:codex-runtime-manager`、`npm run test:agent-presentation`、`npm run test:codex-projection-store`、`npm run check:agent-runtime`、`npm run check:ui-system`、`npm run test:electron-codex-smoke` 已对同一内容通过。真实 Nova/ToolBox 长任务仍不由这些命令覆盖。

结构化 Agent Block 已从 Workbench 页面迁入 `agent-presentation/blocks/`。Tool、Approval、ToolBox/VCP observation、marker、error 和 unknown fallback 由统一 registry 创建；Workbench 只提供取消和审批动作。Fork/legacy 灰度仅影响 Message renderer，不再产生第二套工具或审批卡。Tool patch 保留根 DOM，在 terminal 状态移除取消动作，并在展开状态使用最新 Projection payload 重建详情。

Tool Block 仍保留 Agent 专用结构化 adapter 与 `agent-chat-tool-activity` identity hook，但视觉根节点和
详情已复用主聊天 `vcp-tool-call-summary-bubble`、`vcp-tool-use-bubble`、`vcp-tool-result-bubble` 与 UI token；
这不会让 DOM 解析 ToolBox 语义，也不会改变调用路由。UX-R5 仍需真实富结果截图与人工密度验收。

**Checkpoint 验收收据（VChat `29c2068a`）**：`previewTopic()` 和已存在 runtime 行使用
`agent-runtime:read-projection` 作为唯一 awaited 冷打开步骤；随后才 detached 调用
`agent-runtime:read-topic` / Codex `thread/read`。Renderer 同时以 selection generation 和每 Topic live projection revision
拒绝迟到的 A 对账覆盖 B 选择或新的 Item patch。已通过 `npm run test:agent-workbench-store`、
`npm run test:agent-workbench` 与 `npm run check:agent-runtime`。这证明 hermetic 行为，不是 10 Session 性能录制或真实 ToolBox 验收。

仍未完成：

- Session 目录脱离 Runtime start、canonical Agent identity 迁移和 Agent 点击性能门槛；
- 选中 Session 后的有界 Thread warm 与首发 warm-promise 复用；
- 首发占位的头像、完整消息骨架、主聊天流光和无闪烁真实 Item 接管；
- 主聊天视觉体系下的紧凑 Tool Activity 卡；
- 全面清理 Rust Topic/lease/takeover/compact/queue 文案和入口；
- 将安全的 Agent 转发 adapter 接入不依赖主聊天 history identity 的目标选择流程；
- Codex native/VCP tool Block registry；
- usage、资源、warning、VCPInfo 展示；
- Session UI reducer、transition fixture、bounded observation ring 和未读游标；
- vcp-code marker fixture 到 `AgentBlock[]` 的受控移植及 TOOL_REQUEST warning-only gate；
- 1440×900/1024×720 深浅主题视觉截图与差异清单；
- 长流性能、每帧 patch 上限和非底部 scroll trace；
- Electron 关闭重开/crash smoke、截图、scroll trace 和真实双 Thread 验收。

因此当前 Workbench 只能标记为 **hermetic integration in progress**，不能标记为 Cherry 等价体验或产品完成。
