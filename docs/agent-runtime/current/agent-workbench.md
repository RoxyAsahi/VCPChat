# Agent Workbench

## 产品目标

Agent 页面应获得与 VChat 主聊天一致的消息阅读和操作体验，同时保持数据层正确：主聊天历史、Agent Projection SQLite、Codex Thread 三者不能混写。

借鉴 Cherry 的机制是“Session 持久展示与 Runtime 执行分离”，不是复制其 AGPL 代码、SQLite schema、Claude SDK 或工具系统。

目标页面结构以 [gui-capability-roadmap.md](gui-capability-roadmap.md) 为真源：左侧 Agent/Session 导航，中间规范消息与任务时间线及 Composer，跨 Session 的 Activity Center，以及承载 Plan、Diff、Context/Usage 和 Session 设置的 Inspector。选择 Session 只改变展示；后台 Thread、审批和任务状态独立存在。

## 持久展示与临时观察

- Codex reasoning、工具、Plan、Diff、Usage、Compaction 以及具有 Session/Turn identity 的 VCP marker 属于 durable Session projection，必须在 SQLite-first 重开后恢复。
- reasoning 的实时 `projection.updated` 与冷启动 `readProjection` 使用同一转换合同：标准 assistant 消息的正文为空，公开推理内容进入 `message.reasoning`，由 Full Fork Renderer 恢复为可展开的 `vcp-thought-chain-*` 卡片。
- ToolBox Chat 仅将模型明确公开的 `reasoning_content` 或字符串 `reasoning` 转换为 Responses reasoning Item；隐藏 Chain-of-Thought 不读取、不推断、不持久化。没有公开 reasoning 的 Turn 只显示临时“思考中”状态，完成后不生成空推理卡。
- `thread/read` 是后台对账来源，不得因为稀疏快照缺少某个展示 Item 就删除已经由事件写入 SQLite 的推理或工具记录；空的 completed payload 也不得覆盖已有流式内容。
- 无可靠 Thread identity 的全局 VCPLog/VCPInfo 是 Renderer-only bounded observation，Activity Center 明确标注“仅本次运行”，不写入任一 Session transcript。

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

当前实现已经将 Session 目录切到 projection-only SQLite 快路径：Main 负责 canonical Build Agent identity，
Build profile 位于独立 `CodexAgents/`，不得读取或写入主聊天 `Agents/`。schema v3 保存
`agentCatalogId/agentNameSnapshot`，旧 `Nova` 可受控迁移到 Build folder ID；Renderer 不再
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

### 连续工具折叠

2026-08-01 working tree 以 clean-room 方式借鉴 Cherry Studio 的 Block 分组机制，在 Renderer-only
timeline adapter 中增加连续工具折叠：

- 只聚合同一显式 `turnId` 内、时间线上相邻的两个及以上 Tool Part；message、reasoning、error、
  approval 或不同 Turn 都会打断分组；没有 Turn identity 的工具永不参与聚合；
- 分组只是临时展示 Part，不写入 SQLite，不创建新的 Codex Item，也不改变原始 `toolCallId`；外层稳定
  key 使用第一个真实 `toolCallId`，组内每张卡继续按自身 `toolCallId` keyed patch；
- 折叠标题在运行时显示最新等待中/执行中的工具、状态和累计耗时；全部终态后显示工具数量及失败/取消
  摘要；当前工具取消入口可在折叠标题直接操作；审批仍由全局 Interaction Center 展示和响应；
- 展开后保留每个工具原有的参数、结果、资源、warning、异步任务和单卡详情折叠；列表最大高度 300px，
  展开时将当前活动工具滚入视口；
- 单个工具继续直接显示。具体分组的展开状态只属于本次 Renderer 生命周期，不进入 transcript、
  localStorage 或 Projection SQLite。

该机制只降低长任务卡片密度，不能改变 `assistant -> tool -> assistant` 的真实顺序，也不能跨正文把不连续
的工具合并成伪造的批次。

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

R4.2 增加统一 Interaction Center：`requestUserInput` 支持多问题、选项/其他答案、文本和 password；
permission 只允许精确批准 Codex 请求的 profile，scope 限于 turn/session；MCP elicitation 支持 typed form、
OpenAI/opaque JSON form 和 URL 模式。URL 必须由用户显式打开，打开链接不会自动接受请求。交互 payload
只在 Main 内存存在，按 `source + requestId` exactly-once 响应，秘密与答案不落 SQLite/localStorage。

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

R4.2 hermetic 已完成：Activity 外壳稳定挂载；Plan、Diff、Usage、Compaction、审批和 observation 进入
分 Tab 投影；每个 Tab 独立未读；Activity 支持搜索、来源/类型筛选，100 条临时 ring；连接页只显示
Codex App Server、Projection SQLite、VCPToolBox Bridge。SQLite 冷启动可恢复 Plan、usage provenance 和
compaction 摘要，Plan 不再重复成普通气泡。真实 MCP/permission 请求和视觉人工验收仍属 experimental。

R4.3 开始按 OpenCode 的信息架构收口右侧面板，但只 clean-room 借鉴机制，不复制其组件代码：

- 产品入口当前只保留一行“上下文 / 通知 / 审批”Tab，不再显示 Inspector、Activity Center 分组标题，
  也隐藏尚无可靠产品数据来源的 Plan、Changes 和内部 Diagnostics；各 panel DOM 在 Workbench mount
  后保持稳定，切换 Tab 不替换 panel identity；
- Header 使用 Context 水位环作为入口。百分比、used/limit 和 tooltip 只消费带来源的 usage；未知时显示
  空水位，不伪造 token 或费用；
- Context 展示 Session、provider、model、消息计数、时间、input/output/reasoning/cache read/cache write、
  usage provenance 和基于可见 Projection 的估算构成；估算构成不会写回 SQLite，也不冒充 Codex usage；
- Agent instruction 可在 Context 中只读展开。请求/Token safety budget 已迁回 Agent Settings，并明确只对
  新 Session 生效；
- 1440px 使用最大 420px 面板，1100px 以下以最大 380px overlay 展示，避免压缩聊天正文；
- Session 生命周期通知的持久索引、Plan composer dock、Diff 文件导航尚未完成。无 Thread identity 的
  VCPLog/VCPInfo 继续只存在于 100 条内存 ring，不能为了模仿 OpenCode 而写入 Session 历史。

`toolbox-only` 产品 UI 暂时隐藏“变更”Tab。当前底层 diff model 只接受 Codex 原生 `fileChange`，而真实
`vcp_invoke(FileOperator.WriteFile)` 在 Projection 中是 `dynamicToolCall`，ToolBox 成功响应只保留文本，
没有可靠最终路径或 before/after patch。Projection 与只读 Inspector 代码继续保留；只有 VChat Bridge
能够提供结构化、可验证的 mutation receipt 后才重新开放，禁止从工具参数或“写入成功”文本猜 diff。

仍未完成：

- 全面清理 Rust Topic/lease/takeover/compact/queue 文案和入口；
- 将安全的 Agent 转发 adapter 接入不依赖主聊天 history identity 的目标选择流程；
- archive、pin、restore 与 Session-scoped 草稿/附件/滚动状态的完整流程；
- Plan/Compaction/Unknown 的主时间线专用卡与 attachment/resource/warning 的 Electron 视觉验收；
- Codex requestUserInput、permissions、MCP elicitation 的真实上游触发验收；
- Activity 非交互卡的完整 keyed patch 性能门槛；
- Session completed/error/approval-needed 的持久通知索引、severity unseen 和点击跳转；
- composer 上方的结构化 Plan/Todo dock，以及 Diff 文件选择/导航；
- vcp-code marker fixture 到 `AgentBlock[]` 的受控移植及 TOOL_REQUEST warning-only gate；
- 1440×900/1024×720 深浅主题视觉截图与差异清单；
- 长流性能、每帧 patch 上限和非底部 scroll trace；
- Electron 关闭重开/crash smoke、截图、scroll trace 和真实双 Thread 验收。

后续能力与验收顺序统一按 GUI-R0–R6 执行。当前 Workbench 只能标记为 **hermetic integration in progress**，不能标记为 Cherry 等价体验或产品完成。
