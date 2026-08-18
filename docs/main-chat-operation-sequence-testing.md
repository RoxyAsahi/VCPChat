# 主聊天操作序列测试设计

## 定位与边界

本文定义 VCPChat 主聊天的 stateful model-based / operation-sequence 测试。主窗口已经是单一规范 presentation；测试继续描述共享业务事实，不能把具体 CSS、DOM 结构或兼容 facade 当作产品状态。

本项目明确不覆盖前端插件运行时，不增加动态壁纸、AutoTTS 或其他插件专属场景，也不借测试改造插件 Loader。Ask Nova、Appearance Studio 和内嵌应用只作为低权重 Overlay/故障样本；测试主体是助手、群组、话题、消息、流式生成、输入区、左右侧栏和通知。

## 可借鉴的成熟实践

### QuickCheck / fast-check：命令式模型测试

[fast-check model-based testing](https://fast-check.dev/docs/advanced/model-based-testing/) 延续 QuickCheck state machine 的经典结构：维护一个轻量模型，每个 command 声明前置条件并同时作用于模型和真实系统，失败输入可以 shrink，seed/path 可以重放。

借鉴：action 前置条件、模型与真实状态对照、seed/path、失败序列缩减。

不照搬：第一阶段不增加 `fast-check` 依赖；先用 Node 内置测试、固定 PRNG 和小型 delta-debugger 验证模型是否合适。模型稳定后再单独评估是否采用库提供的 shrinker。

### XState Test：从状态图生成覆盖路径

[XState model-based testing](https://stately.ai/docs/xstate-test) 展示了从状态节点和事件生成 simple/shortest paths，并用 meta assertions 检查到达状态的方式。

借鉴：显式状态节点、合法 transition、路径覆盖统计。

不照搬：VCPChat 不把 XState 引入生产运行时，也不要求测试模型精确复制全部实现状态。

### FoundationDB：确定性模拟、故障注入和 seed 重放

[FoundationDB simulation testing](https://apple.github.io/foundationdb/testing.html) 的核心经验不是随机本身，而是把随机选择和故障调度确定化：一次失败必须能由 seed 与操作日志稳定重放。

借鉴：可控时钟/网络/故障点、固定 seed、失败 trace 永久进入回归、并发完成顺序作为显式 action。

不照搬：不模拟整个 Electron 或浏览器；只控制 VCP HTTP 响应、关键 IPC 完成、renderer reload/crash 和原生 View 故障。

### Playwright/Puppeteer：保留可诊断运行证据

[Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer) 代表成熟 UI E2E 的常见做法：失败时保留动作、DOM、网络、console、截图和时间线，而不是只有一条 assertion。

VCPChat 已使用 Puppeteer，因此继续复用现有 CDP/Electron 启动设施；失败工件至少包含 seed、动作 trace、模型/真实 snapshot、console/page errors、主进程 stderr 和关键截图。

### DeepSeek Harness：property 与 replay 分层

本地 DSH 使用 `fast-check` 覆盖 Session、Agent Loop、LLM 和 Tool 等纯逻辑 property，并把真实 Web/E2E 场景做成可提交、无密钥的 snapshot replay。当前源码未发现 `fc.commands()` / `modelRun()` 驱动浏览器 UI，因此 DSH 是“property + replay 分层”的参考，不是现成的 UI 状态机实现。

借鉴：纯模型高频运行、浏览器场景低频运行、失败 fixture 可提交、真实模型调用不进入常规 CI。

## 为什么不能只做随机点击

盲目随机点击会产生大量非法动作、固定 sleep 和无法复现的失败。操作序列测试必须是 model-aware：

- 没有助手/群组时，不生成发送消息动作。
- 没有活动流时，不生成停止动作。
- 设置已打开时，可以保存、放弃、Escape 或触发模式变化，但不重复打开同一实例。
- IPC 请求未完成时，可以切换助手、切换话题、reload 或让请求逆序完成。
- 每个动作等待语义事件或显式 settle 条件，不等待“应该够了”的毫秒数。

## 测试架构

```text
Seeded Runner
├── Reference Model
├── Action Catalog
│   ├── precondition(model)
│   ├── execute(driver, fixture)
│   ├── transition(model, result)
│   └── settle / postcondition
├── Electron Driver (Puppeteer + CDP)
├── Controlled VCP Fixture
├── Snapshot Oracle
├── Invariant Checker
└── Artifact + Trace Reducer
```

### Reference Model

模型只记录用户可观察事实和测试可控制的 in-flight operation：

```js
{
  boot: 'fresh' | 'unconfigured' | 'ready' | 'reconnecting',
  identity: null | { type: 'agent' | 'group', id: string },
  topicId: null | string,
  conversation: 'empty' | 'history' | 'sending' | 'streaming' | 'cancelling' | 'failed',
  messages: { durable: number, visible: number, hasThinking: boolean },
  draft: { text: string, attachments: number },
  shell: { left: string, right: string, activeTab: string },
  overlayStack: string[],
  embedded: null | { action: string, state: string },
  inFlight: Map<requestId, { kind: string, owner: string, phase: string }>,
}
```

模型不保存 CSS class、具体 HTML 或内部 manager 对象。未来 presentation 细节变化仍必须投影成同一种 `ObservedSnapshot`。

### ObservedSnapshot

第一版 snapshot 至少包含：

- renderer ready、当前 presentation 与主窗口存活状态。
- 当前助手/群组 ID、名称、当前话题 ID。
- 历史消息数、活动流式消息数、空状态可见性。
- 输入值、附件数、发送/停止按钮状态。
- 左右面板可见性、宽度、`aria` 状态和主聊天有效 bounds。
- Overlay 栈、活动焦点所在 surface。
- 活动标签、renderer 可见 action、主进程 embedded session。
- Lifecycle Scope、listener、TaskHandle、IPC sender task、Overlay owner、page/process 数。

snapshot API 必须只读，不包含 API Key、消息正文、文件路径或用户私密数据。

## Action Catalog

### A. 主聊天动作（默认权重 65%）

- 选择、切换助手；选择、切换群组。
- 创建助手/群组并确认或取消。
- 创建、切换、删除话题；删除最后一个话题。
- 输入、清空和保留草稿；添加/移除测试附件。
- 发送非流式消息。
- 开始流式消息、发送一个 chunk、完成、失败、停止。
- 流式期间切换助手/话题，再让旧请求完成。
- 删除最后一条消息、重新生成、reload 后加载历史。

### B. 主 Shell 动作（默认权重 25%）

- 展开/收起/拖拽左栏和通知栏，进入/退出窄栏。
- 打开/关闭通知、切换过滤、清空允许清理的通知。
- 打开/关闭设置，修改、保存、放弃或制造保存失败。
- 搜索助手/话题、切换主题和聊天显示模式。
- 打开、切换和关闭一个内嵌应用；Escape 只关闭当前层。
- 组合 Overlay 链：通知菜单 → 创建 Surface → Ask Nova → 全局设置 → 内嵌应用上的设置；每次 Escape 只能关闭当前最上层，链尾核对 owner、lease、View 和活动 DOM。

### C. 故障与恢复动作（默认权重 10%）

- 延迟、拒绝或逆序完成受控 VCP/IPC 请求。
- renderer reload、renderer crash、原生 View crash。
- 断网/恢复、窗口 suspend/resume。

Ask Nova 与 Appearance 只作为 Overlay 动作的少量固定回归 seed，不占随机序列主体。

## Controlled VCP Fixture

主聊天测试不能连接真实模型。新增本地、进程内 HTTP fixture，模拟项目当前使用的 OpenAI-compatible JSON/SSE 协议，并通过测试控制端提供：

- `hold(requestId)`：保持请求不完成。
- `chunk(requestId, textToken)`：发送一个受控流式片段。
- `complete(requestId)`：完成请求。
- `fail(requestId, status/code)`：返回确定性错误。
- `disconnect(requestId)`：中断连接。
- `pending()`：只返回 requestId、状态和 owner，不返回正文或凭据。

fixture 只在 `VCPCHAT_E2E_TEST=1` 的临时 AppData 中使用，不向生产 preload 暴露测试控制能力。

## Invariants

### 持续成立

- 选中 ID、标题、列表选中态和 manager 权威状态一致。
- 空状态不会与真实历史或活动流式消息同时可见。
- 同一发送动作只有一个 requestId；同一 requestId 只有一个终态。
- 主窗口始终存在；Escape 只影响 Overlay 栈顶。
- 面板宽度和主聊天 bounds 有限、非负并可恢复。

### Quiescent checkpoint 成立

- 模型与 ObservedSnapshot 的 identity、topic、conversation 和消息计数一致。
- 没有无 owner 的 thinking/streaming DOM、IPC Task、Overlay 或 WebContentsView。
- Scope、listener、page、renderer process 和 Electron process 不超过预热基线。
- 所有预期持久化的历史在 reload 后重建；取消或失败状态不会伪装成完整回复。

## Seed、重放与缩减

- PRNG 算法和版本写入工件，不能只保存一个随实现变化就失效的数字。
- 每个 action 序列保存具体参数、故障完成顺序和 checkpoint，不依赖重新随机生成。
- 首轮缩减使用 deterministic delta debugging：按块删除动作并重放，再缩短字符串、附件和 chunk 数量。
- 失败 trace 缩减后进入 `tests/fixtures/main-chat-sequences/`，名称记录缺陷语义而不是 seed。
- CI 失败打印一条可直接复制的 replay 命令，不要求人工从日志还原操作。

## 防止测试自身制造竞态

- runner 不直接改业务 DOM；用户动作通过真实控件，故障控制通过受限 fixture。
- snapshot 可以调用只读诊断接口，不调用 dispose、cancel、register 或 session mutation。
- 除 CDP 连接轮询外不使用固定 sleep；所有业务等待都有明确状态谓词和超时诊断。
- 不把 Chromium detached-node 原生计数作为单独泄漏结论。
- 每个 seed 使用独立临时 AppData；失败时保留，成功时清理。

## 实施阶段

### S0：设计验证

- 定义纯 `ModelState`、`ObservedSnapshot` schema、PRNG 和 trace 格式。
- 用 6–8 个无网络动作验证 runner：选择助手、切换话题、侧栏、通知、设置、Escape。
- 支持 replay 和失败工件；此阶段不做自动 shrink。

### S1：主聊天闭环

- 增加 Controlled VCP Fixture。
- 覆盖发送、SSE chunk、完成、失败、停止、切换助手/话题后迟到完成。
- 建立空状态、历史、thinking/streaming 和持久化不变量。

### S2：故障与缩减

- 增加 reload/crash、逆序 IPC、断网恢复和原生 View 故障动作。
- 实现 delta-debugging 与固定 fixture 回归。
- 接入现有 Lifecycle Inspector 和主进程安全 snapshot。

### S3：CI 分层

- 每次提交运行纯模型与固定短 seed。
- PR 运行固定回归集和 10–20 条生成序列。
- 定期运行长序列与环境恢复，不让概率性长测阻塞每个本地提交。

## 第一版验收标准

- 同一 trace 在相同 fixture 与版本上可重复得到相同结果。
- 人工注入“旧助手请求迟到覆盖新助手”“Escape 级联关闭主窗口”“空状态覆盖历史”三类缺陷时测试确定失败。
- 删除故障代码后对应 trace 稳定通过。
- 失败工件不包含消息正文、凭据或用户路径。
- 运行 20 条 30-step 主聊天序列后，Scope、listener、Task、page、process 和活动 DOM 回到预热基线。
- 不修改前端插件 Loader、插件脚本或插件测试。

## 2026-08-16 实施记录

已完成的 S0/S1 基线：

- `tests/support/main-chat-sequence.js` 提供版本化 PRNG、模型感知 Action Catalog、trace 序列化/重放和确定性 delta-debugging。
- `scripts/test-electron-main-chat-sequences.mjs` 使用隔离 AppData、真实 Electron/Puppeteer、两名助手、多话题以及本地 OpenAI-compatible JSON/SSE 服务运行主聊天序列。
- 当前固定动作覆盖助手与话题快速切换、设置/通知往返、流式期间切话题、主动取消、HTTP 失败和连接中断；失败输出完整 seed 与具体动作参数。
- seed `1..5` 各运行 32 步通过，共覆盖 40 次受控 VCP 请求（含每轮 warm-up）；默认 seed 24 步进入 `test:electron-stability`。
- 这份文档早期曾记录 Classic/Next 双 presentation 的序列结果；主窗口现已收敛为单一 `main-chat` Surface，旧双布局结果仅作历史记录。
- 纯模型及选择竞态回归进入 `test:ui-system`，不会依赖 Electron 或真实网络。

操作序列已发现并修复四个可复现缺陷：

1. Agent A 的迟到 topics 请求可覆盖后来选择的 Agent B。修复后，助手选择从开始到历史落地共享同一 generation owner。
2. 旧话题的迟到 watcher 可在新话题之后启动历史加载。修复后，话题选择拥有独立 generation，并把 ownership guard 传入历史加载。
3. 话题视觉状态已切换、但持久化等到历史加载结束；快速离开会丢失“最后话题”。现在选择意图与可见状态同步提交，历史加载仍可取消。
4. 快速 SSE 完成/取消时，磁盘历史尚未包含仅存在于内存的 thinking placeholder，finalize 会找不到消息并让发送按钮永久停在中止态。当前视图现在优先完成其拥有的内存事务，并在所有流清理后重新计算按钮状态。

第二阶段继续发现并修复：

5. 用户消息保存期间切换会话，旧发送流程会清空新会话草稿，并从新的 `currentChatHistoryRef` 借用历史、插入旧 thinking。发送现在持有源 Agent/Topic、历史快照和独立持久化事务；迟到 UI 投影会被撤回。
6. 两个话题同时流式并逆序完成时，测试可通过 fixture 的 `hold/release` 精确控制完成顺序，并验证两个历史各自落盘、无 thinking 残留。
7. 旧助手的新建话题请求迟到后会抢占当前助手；旧助手的删除回调也会改写当前助手。创建使用 item/topic generation，删除回调显式携带源身份并拒绝迟到提交。
8. 新话题创建时若话题页签隐藏，权威 topic ID 已改变但列表仍高亮旧行。创建完成现在始终刷新列表投影。

第二阶段验证证据：Next 下 5 个 phase2 seed 各 36 步通过；包含并发流、失败、断连、取消和切换，共 97 次受控请求。创建/删除固定 seed 的 40 步序列曾在收敛前的 Next 与 Classic 双 presentation 上通过，旧 Classic 结果仅保留作历史记录。

第三阶段阻塞项收敛：

9. 发送事务现在先以源 Agent/Topic 为 owner 串行合并并持久化用户消息，成功后才消费完全相同的文字与附件快照；保存失败撤回该消息的乐观投影并保留草稿，同话题重复启动会被明确拒绝。
10. thinking/stream placeholder 不再写入 `history.json`。Stream Manager 在 renderer 内存保存带 `replyToMessageId` 的 pending entry，后台流完成时按所属用户消息位置重建并提交最终回复；失败或 setup 中止会按 message ID 精确释放，不再删除其他请求的 thinking。
11. history watcher 从 Renderer 的“返回后丢弃”升级为主进程 lease：新选择在异步工作前 claim，主进程串行 start/stop，拒绝旧 lease，并在 renderer destroyed 时撤销 owner。Chokidar 的 `close()` 现在被真正等待。
12. 同一助手并发创建话题拥有独立 creation generation；只有最后一次操作能选择其结果。双流测试键也全部由版本化 PRNG 生成，相同 seed/trace 不再混入 `Date.now()` 或 `Math.random()`。

阻塞项固定验证：聊天选择/发送和 watcher lease 单元回归共 11 条；Next 36 步 Electron 序列通过，且历史文件不含 `isThinking` 或 `isPendingStream` 临时记录。Classic 结果属于收敛前历史。

第四阶段已完成的 S2 能力：

- 增加 `reload-during-stream` 与 `crash-during-stream`。恢复后同时检查助手/话题、活动 DOM、磁盘临时标记、renderer Stream Manager 和主进程 chat task；多种子运行主动 crash 总预算低于产品的 60 秒三次熔断，reload 仍可逐 trace 覆盖。
- 增加内嵌应用 create 尚未完成就 close 的逆序场景，验证迟到完成不会复活标签、host、主进程 session 或 overlay owner。
- 失败自动写入忽略目录 `screenshots/main-chat-sequences/<time>-<seed>/`：版本化 trace、错误栈、业务 snapshot、renderer/main 生命周期、console/page errors、活动页面 URL、截图与 Electron stderr。工件不写消息正文、API Key 或真实用户 AppData。
- renderer Stream Manager 提供只读、无正文的资源计数；运行时故障测试验证后台历史读取异常会释放 prebuffer、context、pending finalization 等全部强 owner。消息编辑则通过真实 DOM 保存路径验证 watcher 恢复失败不能回滚已落盘内容。
- 多种子模式由 `VCPCHAT_SEQUENCE_RUNS` 启用。每个 checkpoint 先恢复相同测试历史、清理已完成流的延迟表并执行三轮 GC，再比较 heap/listener/DOM 回归斜率以及 Scope、WebContents、renderer/Electron process、embedded/chat IPC task 的精确基线。

第四阶段发现并修复三个共享主聊天缺陷：

13. 设置文件一直保存 `lastOpenItemId/lastOpenTopicId`，但 renderer 启动从未读取。现在启动通过共享 `chatManager.restoreLastOpenState()` 恢复，删除目标安全降级；恢复途中发生的显式用户选择通过同一 generation owner 取胜。
14. renderer reload/crash 后，旧 SSE 会继续向复用的 WebContents 新 document 发送 chunk/end，形成不可见 prebuffer 与 deferred finalization。主进程流任务现在绑定 sender document，在 navigation 或 `render-process-gone` 时 Abort，并在终态解除 sender 引用。
15. 上次选择采用 fire-and-forget 整份 settings 写入，且重复选择当前助手/话题直接 return，导致可见话题与重载恢复话题不一致。last-open 提交现在有序且被选择事务等待；幂等选择也会重新确认持久状态。

快速回归（当前 canonical 主窗口）：

```bash
npm run test:electron-main-chat-sequences
```

序列 harness 不再接受布局模式参数；它只验证单一 `main-chat` Surface。独立业务子页面由 Electron UI Apps gate 验证。

发布前资源斜率：

```bash
VCPCHAT_SEQUENCE_SEED=m9-resource-slope \
VCPCHAT_SEQUENCE_RUNS=20 \
VCPCHAT_SEQUENCE_STEPS=30 \
npm run test:electron-main-chat-sequences
```

2026-08-16 验收：`m9-final-normalized` 在 Next 下完成 20×30，共 600 个动作、216 次受控 VCP 请求；heap/listener/DOM 斜率、Scope、WebContents/page、renderer/Electron process、embedded task 与 chat stream task 均通过。Classic 的 reload/crash 固定 40 步结果属于收敛前历史，当前 harness 不再运行主窗口 Classic。

## 2026-08-17：动作覆盖与领域静止契约

序列 runner 现在除步数外还输出五类有意义的覆盖：Action、相邻 Action Pair、压缩后的模型状态转换、故障注入和 trace 终态。报告使用稳定、有限的状态标签，不序列化消息正文或完整业务对象。20-run 资源门禁会先执行一段确定性的 required-edge 前缀，再检查声明的关键动作、动作对、故障点与完成终态；缺失边会直接使门禁失败。失败目录同时写入 `coverage.json`，成功日志输出各类边数及 required-edge 通过比例。

等待策略不引入全局 `whenIdle()`。四个独立 owner 各自提供有边界的 `whenSettled()`：

- Identity 等待助手目录最新 load token 与状态 revision 都终止，旧 load 不能满足新 revision。
- Creation 以 controller generation 与 operation ID 区分打开、模型加载和提交，失败但仍可编辑属于已静止终态。
- Settings 只跟踪 Agent/Global form 的保存 operation 和 `vcp-settings-save-result`，不把 dirty form 当成异步工作，也不创建第二份设置 Store。
- AppTabHost 为同步 Map 变更提供 revision；Shell controller 另行覆盖 restore、native create/close 与 teardown 等真实异步所有权。

所有等待都支持 `AbortSignal` 和超时，并在 resolve/reject/abort 后解除订阅。它们不等待动画、通知 timer、插件、VCPLog 或动态壁纸。测试只在对应 domain 有明确完成语义时替换 sleep；GC、CDP 连接、浏览器布局和受控网络故障的物理等待继续保留。

尚未宣称整个 M9 完成：群组基础发送与 reload/crash 已进入模型，但附件、重生成、输入草稿以及更多通知/侧栏动作仍需逐步覆盖。当前 S2 已覆盖本轮约定的 reload/crash、关键非聊天 IPC 逆序、失败工件和资源斜率基础设施；插件运行时与动态壁纸继续明确排除。

## 2026-08-18：流式归属与故障注入自包含

`send-stream-switch` 现在使用受控 `sequence-hold-*` 请求和唯一 nonce：先让源话题
进入未完成状态，再切换到目标话题，随后逆序释放响应。终态同时检查源/目标磁盘
history 与当前消息 DOM，要求完整响应只出现在源话题，目标话题不能出现 nonce。
`reload/crash-during-stream` 则只要求恢复后 user nonce 持久化、无 pending/thinking
残留，且 renderer 销毁后的迟到 assistant 片段不得污染新 history；当前 renderer-owned
流式协议不承诺跨 reload/crash 自动补写完整 assistant 回复。

每个 embedded overlay 故障 action 现在自己创建并清理 hide-failure gate；默认序列不
启用该故障时走正常 Escape 关闭，只有设置 `VCPCHAT_E2E_FAIL_EMBEDDED_HIDE_ONCE=1`
才等待 test-only rejection 文件，避免随机 action 顺序造成测试假死。固定 seed 三次
（72 actions）和 hide-rejection 单次序列均通过。

同一轮新增真实 Group fixture：`AgentGroups/SequenceGroupA/config.json` 使用现有
`SequenceAgentA` 与 `SequenceAgentB` 作为 sequential 成员，群组 topics/history 写入隔离 AppData，选择路径实际
经过上游 Group renderer 与 `sendGroupChatMessage` IPC。新增 `send-group-stream-switch`
使用群聊请求中的完整 messages 查找 hold nonce，并要求响应只写入源 group topic，
history 同时具备 `groupId/topicId/isGroupMessage` 语义；目标 topic 与当前 DOM 不得出现
该 nonce。fixture 为每个 nonce 维护递增 request ordinal（`:2` 等），因此两个成员
响应必须分别 release 和持久化，不会因共享业务 nonce 互相覆盖。
`group-smoke` 固定 seed 3×30（90 actions、32 次受控 VCP 请求）通过；默认 agent seed 也
保持通过。

新增 `send-cross-identity-stream`：在 Agent 与 Group 之间交叉切换持有中的流式请求，
验证源 identity/topic history 收到完整响应，而目标 identity 的 history 和当前 DOM
均不出现源 nonce。该路径覆盖 Group renderer 与 Agent renderer 两条不同的消息归属
分支；`VCPCHAT_SEQUENCE_SEED=cross-identity VCPCHAT_SEQUENCE_STEPS=40` 已通过。

另有 `VCPCHAT_SEQUENCE_GROUP_RELOAD_ONCE=1` 与
`VCPCHAT_SEQUENCE_GROUP_CRASH_ONCE=1` 两个显式故障入口：在双成员群聊第一位成员
hold 期间重载或撞毁 renderer，恢复后依次释放两个成员请求。真实主进程继续持有
group IPC，最终 history 必须出现两条且仅两条带 nonce 的 group assistant 响应，恢复
后的 DOM 也只能出现两条 assistant 响应；user nonce 必须唯一，history 不得保留
pending/thinking。crash 路径会优先接受新 Page target；Electron 复用 BrowserWindow/Page
包装器时则显式 reload，并用变化后的 `performance.timeOrigin` 证明新 renderer document，
避免把仍残留在 `browser.pages()` 的旧执行上下文误判为恢复成功。reload 路径 24 actions、
15 次受控请求，crash 路径 24 actions、8 次受控请求均通过。该证据不代表群组附件、
重生成或删除最后消息已经覆盖。

可重复命令：`npm run test:electron-main-chat-group-sequences`（默认
`group-smoke`、3×30；可通过 `VCPCHAT_SEQUENCE_RUNS`、`VCPCHAT_SEQUENCE_STEPS` 覆盖），
固定故障仍使用 `VCPCHAT_SEQUENCE_GROUP_RELOAD_ONCE=1` 或
`VCPCHAT_SEQUENCE_GROUP_CRASH_ONCE=1`。这些路径暂未列入 20-run required edge，避免在
没有 Windows/CI 资源预算时把平台专用 fixture 静默当成完整覆盖。

Group 取消故障曾在独立注入中验证出上游缺陷：本地 abort 后共享发送按钮可能保持
`interrupt`，因此暂不将其包装成 Next 设计系统回归测试；修复应进入上游 Group manager
变更，而不是通过 Next facade 旁路收尾。

Group 503 failure preflight 已通过；disconnect preflight 目前为红色诊断：服务端关闭
连接后 stream 已清理，但随后切换 Agent 时 topic list 为空，导致选择状态无法完成。
这属于上游 Topic/Group 同步问题，保留为上游修复项，不纳入本分支绿色门禁。

## 2026-08-17：Overlay generation 集成回归

`scripts/test-next-ui-tab-lifecycle.mjs` 现在额外重放一条跨 owner 序列：旧 modal 激活 → native hide 失败 → modal 关闭 → 同 ID 新 generation 激活 → 迟到 failure 完成 → 新 modal 关闭。每一步检查 `OverlayCoordinator.snapshot()` 的 `modalIds/active`，并确认失败事件不会移除新 modal。该 fixture 只使用受控 IPC 和无正文 DOM，不改变插件 Loader、动态壁纸或上游 Classic 子页面。

同一 fixture 还验证 feedback 的两条所有权路径：scoped owner 必须在 native session 的异步 close 完成后释放；没有 owner 时 global fallback 可以继续显示 toast，但不能在 Next teardown 中释放共享 singleton。这防止“先清空引用、后启动异步 close”造成的静默泄漏或跨 Surface 误清理。

内嵌会话的故障注入还覆盖同 action replacement：延迟旧 V1 的 `loadURL`，关闭标签并启动 V2，先释放 V1 再释放 V2。主进程 `EmbeddedAppSessionManager.close(action, expectedView)` 以 WebContentsView identity 校验关闭权，旧 completion 不能删除或关闭 V2。该序列是 Next 新增宿主边界；底层 WebContentsView 创建/销毁仍由主进程负责。

嵌入会话单元还覆盖旧 view 的失败分支：V1 释放后触发 `render-process-gone` / `did-fail-load`，通知数量必须保持不变；同一测试随后触发 authoritative V2 的两类失败并校验 payload/state 正常发布，并确认子帧和 `ERR_ABORTED` 不产生错误通知；独立 abort controller 使 `loadURL` reject 后只清理自己的 session。当前仍缺少真实 Electron `loadURL` reject 与 destroyed event 的跨进程序列，保留为下一批故障矩阵入口。

通知三点菜单已由 `NotificationMenuController` 持有，单元序列覆盖打开、Forum/Memo、过滤左键/右键、清空、Escape、外部点击、失败命令、filter subscription dispose 和重新挂载；主聊天 Electron smoke 继续验证通知菜单与主壳、Classic child host 同时存在时的边界。

当前工作树以 seed `next-overlay-regression` 运行 5×32：160 actions、16 action kinds、94 action pairs、48 transitions、4 faults、54 次受控 VCP 请求全部通过；其中新增 embedded WebContentsView + Overlay + renderer reload 交叉动作。该动作通过独立的 E2E Electron entrypoint 在真实 `embedded-vchat-app:activate(null)` IPC 响应上设置 gate，等待 hide 已开始后 reload，恢复 renderer 后释放旧响应，并验证唯一 session、active action、overlay lease、IPC/chat task 和 host ready 状态；reload 后显式重新预热设置/通知 Surface 再进行资源不变量比较。随后 lifecycle stress 运行 2 次预热 + 10 次测量，858 listeners、8 scopes、174 resources、5 个 Electron process 恒定，detached root/icon/option 始终为 0。这是本轮改动后的回归证据，不替代 Windows 真机与 30–60 分钟 soak。

## 2026-08-18：Provider 与 Overlay 组合复核

本轮对抗审查又收敛了四个边界：WA/Next 的 Escape dispatcher 在消费事件后使用
`stopImmediatePropagation`，避免同一 Escape 被 legacy/WA listener 级联关闭第二个
surface；Overlay generation 替换先取得新 hide lease，再释放旧 lease，消除
release→reconcile 的可见空窗，并在关闭竞态中同时撤销 replacement 的旧 lease。
OverlayCoordinator 只接管 `globalSettingsModal` 或显式标记为 Next 的 modal，不再从
整个 document 劫持 Classic/第三方 modal。SettingsActionBar 的保存/删除终态必须带
匹配 operationId，删除按钮也有重复提交锁和超时清理，迟到或无 ID 终态不会污染新操作。

修复后验证：`test-ui-system.mjs`、Overlay/Escape/Settings 单测通过；主聊天状态机
20×30（600 actions、165 次受控 VCP 请求、17 action kinds、187 pairs、55
transitions、4 faults）通过全部 16 个 required edges。首次门禁暴露的
`embedded-overlay-reload` 非法动作来自“先生成随机尾部、再拼接 required prefix”
的测试模型错位，现改为先应用 prefix transition 再生成 tail，避免测试自身制造
不可执行 trace。

- WA-owned Select 的真实 Electron 路径新增到 `test-vcp-ui-select-proxy`：Web Component 内部派发的 untrusted `input`/`change` 各到达消费者一次，controller value 在后续无关更新中保持，程序化 `setValue` 不合成事件。Native fallback 的 `required` 属性也有对照契约。
- 主聊天序列新增 `overlay-surface-chain`：通知菜单 → 创建 Surface → Ask Nova → 全局设置 → 内嵌 Notes 上的全局设置，每个 Escape 只关闭当前最上层，链尾核对活动 DOM、Overlay lease、embedded session、native active action 和主 renderer 存活。
- 该序列首次暴露 Next 的真实遗漏：全局设置是上游模板 modal，没有注册 Next Escape owner；现在由 `EscapeDispatcher` 直接拥有其关闭命令，Classic 不加载该 owner。
- Next teardown 改为先等待 native embedded hide/close，再通过 lifecycle tree 释放 scoped feedback，避免 WebContentsView 的迟到绘制与 renderer feedback 清理交错。
