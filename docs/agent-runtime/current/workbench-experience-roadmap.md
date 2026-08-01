# Agent Workbench 体验收口路线图

状态：UX-R0–R4 已进入 `29c2068a` 并通过 hermetic/DOM/Electron smoke；UX-R5 的
富消息截图、真实性能录制和人工视觉验收仍待完成。视觉基线是 VChat 主聊天；Cherry 只作为“视图选择
与 Runtime 恢复分离”的机制参考，不复制其代码或数据层。

## 本轮问题结论

### 1. 点击 Agent 后会话列表为空或很晚才出现

施工前不是单一的“渲染慢”，而是两个问题叠加：

1. `CodexRuntimeManager.listTopics()` 曾先执行 `start()`。读取本地 Projection SQLite 会话目录因此
   被 App Server、Responses adapter 和 bridge 的进程启动绑住；本应是本地数据查询，却落入 Runtime
   启动关键路径。
2. Renderer 用 `sameAgent(topic.agentId, selectedAgentId)` 做单字符串过滤。旧 Session 可能保存
   `Nova`，而当前 Agent catalog 的稳定 ID 是 `_Agent_...` 或 `univcp_...`；两者实际是同一个 Agent，
   却会被过滤成空列表。新建 Session 使用当前 catalog ID，所以会出现“必须新建一个，旧列表才出现”
   的错觉。

此外，`refreshControlPlane()` 先等待完整 Agent 目录（含 config/avatar）再读取 Session，Agent 点击又会
重建 sidebar shell 并重复刷新。这些都扩大了可见延迟。

### 2. 第一次发送才慢慢启动

施工前 Workbench mount 会启动 App Server 进程，但 Session 的 `thread/start`/`thread/resume` 被明确
推迟到 `startTurn()`。因此第一次发送会串行承担：

```text
ensure Session Thread
  -> thread/start 或 thread/resume
  -> snapshot hydrate/status refresh
  -> turn/start
```

进程预热和 Session/Thread 预热是两件事。施工前只部分完成前者，没有完成后者；UX-R2 已将后者
改为 snapshot 可见后的有界后台预热。

### 3. “正在启动/思考中”不像主聊天

施工前首发占位由 `renderTurnStartIndicator()` 手写 DOM：

```text
message-item assistant thinking agent-chat-turn-starting
  -> details-and-bubble-wrapper
     -> md-content
```

它没有通过 Full Fork 的 `renderMessage()`/`createMessageSkeleton()`，所以没有 Agent 头像、发送者名称和
完整消息骨架；它也没有 `.streaming` class，因此主聊天
`styles/animations.css` 的气泡边框流光不会生效。文档此前称其为“主聊天同构 thinking indicator”并不
准确，当前只复用了少量 class 名。

真实 assistant Item 到达后才进入 `createAgentMessagePresentation()` 和 Full Fork，所以启动占位与
正式流式消息之间存在可见换壳。

### 4. 工具卡视觉差异大

施工前 Message row 已走 Full Fork，但 Tool Block 仍走 Agent 自研的
`agent-presentation/blocks/tool.js`，DOM/CSS 是 `agent-chat-tool-activity`、自定义参数表和大段详情。
它没有复用主聊天的 `vcp-tool-use-bubble`、`vcp-tool-result-bubble`、状态色、折叠密度和 Markdown
结果排版，所以“消息像主聊天、工具又像另一个产品”。

## 目标体验

```text
点击 Agent
  -> 同一帧显示该 Agent 的缓存 Session 行
  -> 后台校验 SQLite 目录
  -> 不等待 App Server

点击 Session
  -> SQLite snapshot 立即显示
  -> 后台 ensure/resume Thread（不发模型请求）

点击发送
  -> 用户消息立即出现
  -> 使用已存在的 Thread warm promise
  -> 主聊天完整骨架的 Agent thinking/streaming row
  -> 真实 Item 原地接管

Tool call
  -> 主聊天视觉体系下的紧凑状态卡
  -> requested -> running -> completed/failed 原地更新
```

## UX-R0：增加真实性能与身份诊断

先增加只在开发模式启用的时间点，不凭体感施工：

- `agent-click`；
- `session-cache-painted`；
- `projection-list-returned`；
- `runtime-process-ready`；
- `thread-warm-started/completed`；
- `turn-start-ack`；
- `first-assistant-item`；
- `first-visible-delta`。

日志只记录 duration、Session/Agent 的脱敏短 ID 和状态，不记录 prompt、API Key、完整路径或消息正文。

退出门槛：能分别得到“列表慢”“Thread 冷启动”“模型首 token”三段耗时，不能把它们合并成一个
“发送很慢”。

## UX-R1：Session 目录脱离 Runtime 启动

### Main/数据层

- 将 Projection SQLite bootstrap 从 `CodexRuntimeManager.start()` 拆开，提供幂等
  `ensureProjectionStore()`；`listSessions/readProjection/searchSessions` 只打开数据库，不启动 App Server、
  adapter 或 bridge。
- `agent-runtime:list-topics` 在 Main 按 canonical Agent identity 返回已经过滤好的 Session，不再把全部
  Session 交给 Renderer 用字符串猜测。
- Session 快照新增/补全：
  - `agentCatalogId`：Agent 目录稳定 ID；
  - `agentNameSnapshot`：创建时名称；
  - `agentAliases`/迁移来源只用于 Main 对账，不作为新的业务 identity。
- 旧 `agentId=Nova` 按 Agent config 的 `name/systemPrompt` 与目录 ID 做一次受控迁移；名称冲突时
  fail-closed 并显示“需要选择归属”，不能随便归给第一个同名 Agent。
- Main 缓存轻量 Agent metadata（id/name/avatar URL/config revision），Agent config watcher 只做增量失效。

### Renderer

- 为每个 canonical Agent 保留页面生命周期内的 Session-list cache。
- 点击 Agent 立即切 tab、更新选中态并绘制缓存；冷缓存显示 3–5 行固定高度 skeleton，不能显示错误的
  “还没有会话”。
- 本地查询完成后 keyed reconcile，不重建 sidebar、搜索框或滚动容器。
- 真正返回空数组后才显示空状态；绝不自动创建 Session。

### 性能门槛

- cache hit：Agent 点击到 Session 行可见不超过 1 animation frame；
- SQLite cold list：P95 不超过 150 ms；
- 列表读取期间 App Server PID 可以不存在；
- legacy `Nova` 与 canonical folder ID fixture 必须显示同一批 Session，且不重复。

## UX-R2：分层预热 Runtime 与 Thread

### Process warm

- Main window ready 后低优先级启动 App Server/loopback adapter；或 Workbench mount 后立即 detached warm。
- warm 不阻塞 Agent catalog、Session list、SQLite snapshot 和普通聊天页面。
- bridge 可与 App Server 一同 warm；配置缺失时记录 readiness，不弹重复错误通知。

### Thread warm

- Session snapshot 显示完成后，后台调用 `ensureSessionRuntime(sessionId)` 执行 `thread/start` 或
  `thread/resume`，但不创建 Turn、不发送模型请求、不执行工具。
- Runtime Manager 持有 `sessionId -> warmPromise`，发送时复用同一 promise，禁止重复 start/resume。
- 只预热当前选中 Session和最近一个 Session；空闲 warm Thread 使用有界 LRU，首轮上限 2，不能遍历
  全部历史会话启动 Thread。
- 切换 Session 不停止后台 Thread；warm 失败只显示行级状态，用户发送时再给出可操作错误。
- Workbench 关闭时不取消已经有 active Turn 的 Thread；纯 idle warm Thread 按资源策略延迟释放。

### 门槛

- warm Session 的发送路径不得出现 `thread/start/thread.resume`；只允许 `turn/start`；
- 用户在 warm 完成前发送时，草稿保留并等待同一 promise；
- 连续点击同一 Session 十次只产生一次 resume；
- 两个 Session warm/运行互不停止、互不串消息。

## UX-R3：首发占位使用完整主聊天消息骨架

- 删除手写 `renderTurnStartIndicator()` DOM。
- 将启动占位建模为 Renderer-only `AgentTimelinePart(message)`，拥有独立 `presentationKey`，但没有伪造
  Codex `messageId/itemId`，不进入 SQLite。
- 通过 Full Fork `renderMessage()` 创建完整 assistant row，显式注入当前 Session 的 Agent 名称、头像、
  avatar color 和主题设置。
- starting/thinking/streaming 都使用主聊天的 `.message-item.assistant.streaming`、`.md-content`、
  `.thinking-indicator`，直接获得相同头像、名称、气泡尺寸和边框流光。
- 第一条真实 assistant/reasoning Item 到达时 keyed reconciler 原地接管或无闪烁替换临时 row；不得出现
  两个“思考中”、重复头像或 feed 高度跳变。
- 流式正文继续按 animation frame 合并；不能因使用 Full Fork 恢复每 token 全量 Markdown。
- `prefers-reduced-motion` 下关闭流光，保留静态 running 状态。

门槛：主聊天与 Agent 的 thinking/首 token/streaming/complete 四态 DOM golden parity；Agent 头像在首发
占位第一帧可见；真实 Item 接管时 scroll anchor 变化不超过 2 px。

## UX-R4：工具活动卡统一到主聊天视觉体系

目标不是把 ToolBox JSON 塞进主聊天 marker，而是复用主聊天的视觉组件和设计 token，同时保留 Codex
结构化 tool identity 与生命周期。

### 展示结构

- 建立纯 presentation `VcpToolActivity`：稳定 key 为 `threadId + turnId + callId`；不理解执行协议。
- compact header 默认只显示：图标、工具/动作名称、单行参数摘要、状态、耗时、展开按钮。
- `requested/running/completed/failed/cancelled` 原地更新；running 使用与主聊天一致的克制流光/状态色。
- 展开区复用或 clean-room fork 主聊天：
  - `vcp-tool-use-bubble` 的参数视觉；
  - `vcp-tool-result-bubble` 的结果、Markdown、表格、图片和折叠；
  - 现有代码复制、链接、资源预览与主题 token。
- FileOperator、PowerShellExecutor、Canvas/resource 只提供纯展示 adapter；未知工具使用紧凑 fallback。
- 原始 JSON 默认不展开；参数和结果按 schema/资源类型显示，warning 独立且可见。

### 布局

- 工具活动归入所属 Turn 的 assistant activity group，不再表现为脱离对话的宽大 system row。
- 同一 Turn 连续多个工具可折叠成一组摘要，展开后仍按 callId 查看各自状态。
- 审批卡视觉与工具卡关联，但 approval ID 与 callId 继续严格分离。

### 门槛

- `vcp_invoke(FileOperator)` 必须可见 `requested -> running -> completed`，DOM root 不替换；
- 长参数默认不撑高 feed，展开/收起不抢滚动；
- success/failure/cancel/warning/resource 深浅主题截图与主聊天 token 对齐；
- tool card 不得读取 Renderer 当前 selected Session 来猜归属。

## UX-R5：视觉与性能验收

- 1440×900、1024×720，深色/浅色及至少一个自定义主题；
- 空会话、thinking、长流、reasoning、单工具、多工具、审批、失败、图片/文件结果；
- 主聊天与 Agent 并排截图，记录允许差异与缺陷；
- 10 Agent/50 Session 目录切换性能录制；
- cold App Server、warm process/cold Thread、warm Thread 三种首发 latency 对比；
- 非底部阅读位置在 delta/tool patch/详情展开后偏移不超过 2 px；
- Electron crash/restart 后 SQLite 先显示，Thread 后台恢复，不闪回空页。

全部完成前状态保持 `experimental / Workbench UX in progress`，不能仅凭“可以聊天”标记产品体验完成。

## 推荐施工顺序

1. UX-R0 埋点和 Agent identity fixture；
2. UX-R1 Projection catalog 与 canonical identity，先解决“会话不出现”；
3. UX-R2 process/thread warm，解决首发启动等待；
4. UX-R3 主聊天同构 thinking/streaming row；
5. UX-R4 工具活动卡；
6. UX-R5 截图、性能和 Electron 恢复验收。

该顺序避免先美化一个仍会错误隐藏 Session、首发仍被 Thread 冷启动阻塞的页面。

## UX-R0–R4 checkpoint 实现收据

- UX-R0：Renderer 记录 `agent-click/session-cache-painted/projection-list-returned/turn-start-ack/
  first-assistant-item/first-visible-delta`；Main 记录 `runtime-process-ready/thread-warm-started/completed`。
  日志只包含 duration、数量和截断 identity。
- UX-R1：`ensureProjectionStore()` 已与 `start()` 分离；projection-only list/read/create 不启动 App Server。
  schema v3 持久化 `agent_catalog_id/agent_name_snapshot`，Main 将 legacy Agent 名称受控迁移到 folder ID；
  Renderer 删除二次原始字符串过滤并使用按 Agent 的页面缓存与 skeleton。
- UX-R2：新增窄 IPC `ensure-session-runtime`；选择 Session 后 detached warm，发送复用同一
  `sessionId -> warmPromise`。VChat 的 proactive warm LRU 上限为 2，active Turn 不被淘汰。
- UX-R3：删除手写 thinking DOM；首发占位成为不落库的 presentation-only Message Part，通过 Full Fork
  创建头像、名称、消息骨架和 `.streaming` 行，真实 Codex Item 到达后由 keyed timeline 移除临时 Part。
- UX-R4：Tool Activity 保留 `threadId/turnId/callId` 生命周期，根节点和详情使用主聊天
  `vcp-tool-call-summary/use/result` class 与 UI token；状态、耗时、参数、结果、资源和 warning 保持 keyed
  原地更新与按需展开。
- 验证命令：`npm run test:codex-runtime-manager`、`npm run test:codex-projection-store`、
  `npm run test:agent-presentation`、`npm run test:agent-workbench-store`、`npm run test:agent-workbench`、
  `npm run check:ui-system`、`npm run check:agent-runtime`、`npm run test:electron-codex-smoke`。
- 模式：Windows x64，VChat checkpoint `29c2068a`，Codex App Server hermetic/local；真实富消息视觉和
  ToolBox 产品门槛仍未升级为 live verified。
