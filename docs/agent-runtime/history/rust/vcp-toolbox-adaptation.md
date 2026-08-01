# VCPToolBox 黑箱适配边界与施工矩阵

最后更新：2026-07-30。状态：当前实现真源；未明确写为“已验证”的项目均不得视为完成。

## 固定架构

```text
Rust TUI / VChat Workbench
        -> daemon transport
        -> vcp-agentd (Rust 黑箱 Runtime)
        -> Rust Host/Core
        -> VCPToolBox
```

Electron Main 只监督进程并转发协议，Renderer 只投影 daemon 事件。VCPToolBox 继续是模型网关、Agent/placeholder、动态工具知识、插件、分布式工具路由和后端审批权威。Rust Host 只实现协议适配，不建立第二套插件、工具 catalog、Shell、MCP 或 capability node。

## 仍由 VCPToolBox 提供的正式能力

- `/v1/chat/completions`、SSE、语义模型路由及 provider 兼容。
- `{{Nova}}`、Agent 递归 placeholder、ToolBox placeholder 与动态工具说明展开。
- RAGDiary、Dynamic Fold、OneRing 等上下文预处理。
- 本机与分布式插件的真实可用 catalog；Rust 不镜像或伪造 schema。
- `/v1/human/tool` marker 执行与 VChat DistributedServer 的 FileOperator、Shell、Canvas 等能力转发。
- ToolBox 后端审批；客户端 `always-approve/yolo` 不得绕过它。
- VCPLog、VCPInfo、RAG 召回与全局通知观察。
- `/v1/interrupt` 与 `/v1/models`。

`[[VCPToolUse=Forbidden]]` 只禁止 ToolBox 启动自己的 marker Agent loop，不会关闭 Agent 展开、动态工具、RAG、OneRing、媒体预处理或模型路由。模型仍只看到原生 `vcp_invoke`；Rust Host 在模型不可见的边界将其编码成 `/v1/human/tool` marker。

## P0：阻塞正确性与安全

| 项目 | 2026-07-30 审计事实 | 完成条件 |
| --- | --- | --- |
| 模型请求身份与中断 | **已验证**：普通/压缩 chat body 携带 wire 中同一 `requestId`；取消先以同一 ID 调 `/v1/interrupt`，收到结果后再清理本地 stream task。daemon 只投影 `runtime.interrupt_result { accepted, source, outcome }`，不暴露内部 requestId、不写 Topic。2026-07-30 real lifecycle 收到 `accepted=true`；按当前 ToolBox `/v1/interrupt` 实现，这只会在该 ID 命中 `activeRequests` 时返回 HTTP 200 | 保持 live lifecycle 的严格 `accepted=true` 断言；ToolBox 返回 404/传输错误时仍完成本地 fail-closed 取消，但不得伪称后端已命中 |
| ToolBox 后端审批 | **已真实验证**：独立 `toolbox-approval` 命令和受限双向 VCPLog 只发送 `tool_approval_response`，ToolBox `requestId` 不与 Agent `toolCallId` 混用。VChat 本地 DistributedServer 在线时，`PowerShellExecutor` 真实请求经 `/v1/human/tool` 到达 ToolBox 后端审批；Rust 写回 deny 只在 WebSocket `send()` 成功后发出 completion，HTTP 请求返回 `approval_rejected`，sentinel 未创建 | 保持审批 ID 隔离、WS 真实写回 completion 和 ToolBox 配置逐字节恢复断言 |
| VCPLog replay | **已真实验证**：默认稳定无隐私 `deviceName=vcp-agent-rust`；显式受限的 `VCP_AGENT_VCPLOG_DEVICE_NAME` 仅用于并行 live/CI 实例隔离，避免已在线 Rust TUI 代测试实例记录 delivered ID。正常离线审批重连收到同一 ToolBox request ID 且 `_vcpReplay=true`；deny 后第三次连接不再补发。临时 3 秒 TTL 的真实离线审批由 ToolBox 超时拒绝，重连无旧 replay，随后新审批仍可观察并拒绝 | 保持对 `_vcpReplayOriginalAt + approvalTtlMs` 的 fail-closed 校验、受限的设备名覆盖和逐字节 ToolBox 配置恢复 |
| capability readiness | 已删除无权威输入的 DistributedServer 日志字符串解析；当前诚实显示 `unknown` | 没有公共权威接口时保持 unknown，以动态提示和真实工具结果为准 |
| 工具名权威 | 已删除 `FileOperator -> ServerFileOperator` 自动 fallback | 真实工具不存在时必须原样显示 ToolBox 错误 |
| WS 安全边界 | 已配置 256 KiB frame/message 限长、64 项审批发送队列、256 项审批去重/待处理上限和 1–30 秒退避；本地 WebSocket fixture 已验证 256 KiB+1 入站 Text frame 在到达 UI 投影前 fail closed | 仍缺真实 ToolBox 超大 WS 帧断连收据 |

## P1：产品投影与完整能力

### VCPInfo 分类

Rust Host 将下列现有类型投影为只读结构化事件，而不是向 TUI/Workbench 输出原始大 JSON：

- `RAG_RETRIEVAL_DETAILS`
- `META_THINKING_CHAIN`
- `AI_MEMO_RETRIEVAL`
- `AGENT_PRIVATE_CHAT_PREVIEW`
- `DailyNote`
- `AGENT_DREAM_*`

这些事件不进入 Agent Topic、不回送模型，也不能在缺少关联字段时伪装成当前 Turn 的工具事件。

当前 hermetic 实现已将上述类型归类为 `rag`、`memory`、`agent-preview`、`diary`、`dream`。Workbench 将每类投影为受限的来源/数量/查询/摘要卡；完整的已脱敏元数据只在用户展开 Activity observer card 后显示。`META_THINKING_CHAIN` 与连接确认继续不进入 Conversation。该投影只使用 daemon 给出的 `kind + value`，不读取 Topic、不推断 Tool、也不写回模型。

### VCP 内容 marker

- `VCP_DYNAMIC_FOLD`：显示投影保留可展开详情，Topic 只保存紧凑摘要。
- `VCPINFO`：显示通知卡，Topic 只保存标题/摘要。
- 模型文本中的原始 `TOOL_REQUEST`：从历史移除并产生协议告警，绝不执行。

marker parser 只负责显示与历史净化。唯一执行入口仍是原生 `vcp_invoke`。

Core 在 SSE 分片边界使用有状态 marker filter：即使开始/结束标记跨 chunk，raw `TOOL_REQUEST` 也只会变成协议告警且绝不进入 transcript、Topic 或执行路径；完整 `VCP_DYNAMIC_FOLD` / `VCPINFO` 生成有界 `marker.observed` display-only 事件。Workbench Activity 和 Rust TUI 的专属卡片显示摘要，用户主动展开才显示已限长正文。Renderer 的 `markerObservations` 仅是页面存活期投影，不会变为消息、工具、ToolBox WS 或持久化 Topic。未闭合 marker 在 model done 时 fail closed。

### 多模态与结构化工具资源

Grok Build 的附件实现已按 `02d9359` 审计。采用其核心生命周期，而不导入 Grok Agent/session：

```text
UI preview / file selection
  -> Rust Host import
  -> magic-byte MIME + structural/full decode validation
  -> 1.5 MiB / 2,408,448 px / 2000 side normalization
  -> Topic attachments/<sha256>.<ext> atomic asset
  -> serializable AttachmentDescriptor
  -> model request 前临时 attachment_ref -> image_url data URL
```

当前已直接受控导入 Grok `image_validate.rs` 与 `image_compress.rs` 为
`vcp-grok-image-attachments`。`PastedImage` 的 `encoded_bytes / staged_temp_path /
session_image_path` 三层状态被改写成符合本架构的 UI 临时状态、一次性源路径和
Topic durable asset；没有导入 pager、ACP、JSONL、Agent、Shell 或本地工具。

`AttachmentDescriptor` 只包含 ID、显示名、受限 `kind`、真实 MIME、字节数、图片尺寸
（仅图片）、SHA-256 和 Topic 内 asset 文件名。Renderer 不读取文件，不接收 durable path 或 Base64；
Electron Main 只打开系统文件选择器并把一次性路径交给 daemon，读取、校验、重编码、
hash 和持久化全部在 Rust Host 内完成。

图片初始门槛复用 Grok：单图标准化后最多 1,500,000 raw bytes，最大编码像素
2,408,448，最大边 2000，任一边至少 8 且总像素至少 512。扩展名不可信，MIME
由 magic/decode 决定；截断 PNG/JPEG、CRC 错误、hash 不匹配和损坏恢复均 fail closed。

Core/Topic 保存 `attachment_ref` descriptor，不保存 data URI。Host 仅在真实
`/v1/chat/completions` 请求前水合成 OpenAI `image_url` content part；压缩、token
估算、日志和协议 fixture 均不扫描或持久化 Base64。Topic sanitizer 另有 data URI
兜底净化，防止旧/外来 snapshot 污染。

音频/视频**直接复用 VCPChat 与 ToolBox 已存在的媒体协议**：ToolBox 已识别
`image_url.url = data:(image|audio|video)/…;base64,…`，并由 `{{TransBase64}}` /
`{{TransBase64+}}` 与现有预处理器决定后续转换。Rust 不新建 `audio_url`、`video_url`
或 provider-specific part。资产层对音频只接受 WAV、MP3、AIFF、AAC、Ogg、FLAC，对视频
只接受 MP4、WebM、QuickTime、AVI 的 magic-byte 白名单；不转码音频/视频，最多分别 25 MiB /
50 MiB，仍以 SHA-256、原子 asset 和 descriptor-only Topic 持久化。图片继续使用 Grok 的
完整 decode/重编码实现。

当前施工状态：leaf crate、Rust import/validation/hydration、daemon v1.4 descriptor
协议、Workbench 媒体选择/chip 和 Native Rust TUI `/attach <图片、音频或视频路径>` 已接线。TUI 的
`/attach` 只发送一次性路径到 Rust Host；收到 `attachment-imported` 后仅暂存 descriptor，
下一次 Turn 才提交它。bridge 模式明确拒绝本地路径，绝不把路径交给 Electron/Renderer 或
另一 Agent Runtime。2026-07-30 的真实 ToolBox vision smoke 已完成 PNG 导入、颜色识别和
无 Base64 Topic snapshot 检查。已补 safe missing-asset 投影：Host 将缺失/篡改 asset
编码为 `turn.failed { code: "attachment-unavailable" }`，不泄露文件路径；Workbench 显示
“附件不可用”，TUI 显示重新选择附件的告警。Native TUI 的 `/paste-image` 已接到 Rust Host：
Host 用现有 `arboard` 读取 raster clipboard，规范化为 PNG 后仍走同一受控 Grok image
leaf、descriptor 和 Topic asset 流程；TUI 不读取像素、不保留 Base64。该入口已有命令转发
和 descriptor-only 单测，但尚未取得真实桌面剪贴板 smoke 收据。音频/视频已完成本地
magic、hash、descriptor、Topic 与 ToolBox request-shape 单测；真实短音频/视频的 provider
验收仍未取得收据，因此多模态保持 `in progress`。

- Base64、附件原文、源路径、凭据和原始大工具结果不得进入 Topic 或 Renderer。
- 导入失败也只能投影受控恢复提示；不得把文件系统路径、magic/parser 细节或底层 I/O 错误发给 Renderer。
- 工具结果兼容当前 `{status,result/error}`，并在检测到结构化数据时保留资源描述、warning 和任务状态供 UI 投影。Host 事件携带已脱敏、有界 `result` 与 `outputSummary`；Core 只把工具文本给下一轮模型，但将受限 `vcpAudit { toolName, resources, warnings, task }` 存入 Rust Topic。刷新/恢复通过 `read-topic(snapshot)` 重建工具卡及其 snapshot ordinal，不能依赖 Main 或 Renderer 的旧内存。`vcpAudit` 再次过滤本地路径、`file:` URL、data URI、Base64/bytes 字段、深层对象和超长值。
- ToolBox 的 Canonical Tool Result 文档目前是目标规范，不得假定已经上线。

## P2：按需或等待上游

- OneRing 只有在 Agent system prompt 明确包含 `[[OneRing::Agent::Frontend]]` 时启用；Rust 不为 Nova 默认配置擅自注入。
- `vcpchatExtensions.messageTimestampBindings` 等 OneRing 编辑/retry 元数据，在 Agent Topic 支持历史编辑后再评估。
- `archery=no_reply`、`ink=mark_history`、`river`、`vref` 当前会被 `/v1/human/tool` 忽略，继续 reserved/fail-closed。
- `accepted/task/resources/warnings` 按版本感知方式渐进兼容，不以规划文档替代真实接口探测。

## 明确禁止

- Rust Agent 连接 `/vcp-distributed-server`、发送 `register_tools/report_ip/update_static_placeholders` 或处理 `execute_tool`。
- 在 Rust、Electron Main 或 Renderer 建立 ToolBox catalog/schema 副本。
- Renderer 连接 VCPLog、读取密钥、判断审批或持久化 transcript。
- 将 VCPInfo、VCPLog 大消息写入 Topic/模型上下文。
- 自动重写工具名，或在客户端伪造 ToolBox 后端批准。
- 引入本地 Shell、MCP、worktree 或第二套插件系统。

VChat 的 DistributedServer、Canvas、音乐、Chrome、DailyNote 等继续属于 VChat 全局 capability/UI。Rust Agent 可以经 ToolBox 调用并观察结果，但不接管其生命周期与执行语义。

## 实施和验收顺序

1. request identity 与真实 interrupt。
2. 双向后端审批、device replay、TTL/去重和 WS 限长。
3. 删除工具名/readiness 猜测。
4. VCPInfo 与 marker 结构化投影/历史净化。
5. 多模态输入和结构化工具资源。
6. 最后单独评估显式 OneRing 模式。

每一步必须先补 Rust 单元/集成测试，再更新 GUI/TUI 投影测试。P0 全部通过前，R4 不得标记 complete；P1 全部通过前，不得宣称 VCPToolBox 特殊适配完整。

## 当前验证记录

2026-07-30，未提交工作树的 Rust source revision
`17c41756e2ee1b2d19050203f84c9884bddbd64c5abcea7e2964853d5bbefb56`
（`node --input-type=module -e "import { rustSourceRevision } from './scripts/rust-source-revision.mjs'; console.log(rustSourceRevision(process.cwd()));"`）：

- hermetic：`cargo test --manifest-path rust/Cargo.toml -p vcp-agent-vcp -p vcp-agent-host --lib`（11 + 28 tests）与 `cargo clippy --manifest-path rust/Cargo.toml -p vcp-agent-vcp -p vcp-agent-host --all-targets -- -D warnings` 通过。新增 interrupt fixture 精确断言 `/v1/interrupt` body 使用原 model request ID，并验证 HTTP 200 映射为 backend acceptance；Host 保持 requestId 仅在内部 command channel 中流转。
- hermetic：`npm run test:rust-agent-runtime`、`npm run test:agent-workbench-store`、`npm run test:agent-workbench` 与 `node scripts/test-rust-protocol-fixture.mjs` 通过。Workbench fixture 额外覆盖视频 chip 的紧凑 metadata 与发送前移除；不向 Renderer 交付源路径或字节。
- hermetic：结构化 `resources/warnings/task` 已覆盖 ToolBox normalizer → Host 事件 → Core `vcpAudit` snapshot → Topic history → Workbench restore。核心与 Topic 测试断言文件系统 path、`file:` URL 与 data URI 不可落盘；Workbench controller 测试断言刷新只从 Rust history 重建 `FileOperator` 工具卡和资源。

2026-07-30，Rust source revision
`17c41756e2ee1b2d19050203f84c9884bddbd64c5abcea7e2964853d5bbefb56`
（`node --input-type=module -e "import { rustSourceRevision } from './scripts/rust-source-revision.mjs'; console.log(rustSourceRevision(process.cwd()));"`）：

- hermetic：`cargo test --manifest-path rust/Cargo.toml -p vcp-grok-image-attachments -p vcp-agent-core -p vcp-agent-host -p vcp-agent-protocol -p vcp-agentd` 通过（66 tests）；覆盖 Grok leaf 图像 magic/decode 与标准化、VCP asset 篡改、descriptor 无 Base64、Host 水合和 Topic data-URI 净化。
- hermetic：Grok 生产 leaf 与 VCP 副本的审计确认仅移除了上游 `#[cfg(test)]` 模块；`image_validate.rs` 与 `image_compress.rs` 的非测试实现保持原 revision `02d9359` 语义，VCP 适配只位于 `lib.rs`，不引入 pager/ACP/session 依赖。
- hermetic：`node scripts/test-rust-protocol-fixture.mjs`、`npm run test:rust-agent-runtime`、`npm run test:agent-workbench-store` 与 `npm run test:agent-workbench` 通过；覆盖 v1.4 descriptor 与 Renderer 只持有 descriptor 的传递。
- hermetic：`cargo fmt --manifest-path rust/Cargo.toml -p vcp-grok-image-attachments -p vcp-agent-core -p vcp-agent-host -p vcp-agent-protocol -p vcp-agentd --check`、`cargo clippy --manifest-path rust/Cargo.toml -p vcp-grok-image-attachments -p vcp-agent-core -p vcp-agent-host -p vcp-agent-protocol -p vcp-agentd --all-targets -- -D warnings` 与上述 66 个测试通过；覆盖 `/attach` 的 descriptor-only 交接、附件-only Turn 和 missing-asset 安全告警。TUI clipboard 的既有 focused check 也通过；真实桌面剪贴板读取仍是单独的人工 smoke 门槛。
- hermetic：`cargo fmt --manifest-path rust/Cargo.toml -p vcp-agent-vcp --check`、`cargo clippy --manifest-path rust/Cargo.toml -p vcp-agent-vcp --features direct-host --all-targets -- -D warnings` 与 `cargo test --manifest-path rust/Cargo.toml -p vcp-agent-vcp --features direct-host --quiet` 通过（10 tests）；覆盖真实 WebSocket handshake 的后端审批 request/deny response，以及 256 KiB+1 入站 WebSocket message 在 UI 投影前 fail closed。
- hermetic：`npm run test:agent-workbench` 通过；JSDOM fixture 覆盖 `rag`、`memory`、`agent-preview`、`diary`、`dream` 五类 VCPInfo 的紧凑 observer 投影，确认它们不变为 Conversation/tool card。关联 Rust source revision 为 `3be0430538a760b30b932647529d4527baa1ad07c72bd1376b797f8f32814f33`；真实 ToolBox VCPInfo/marker 仍需独立收据。
- hermetic：`cargo test --manifest-path rust/Cargo.toml -p vcp-agent-core --quiet`（22 tests）、`cargo clippy --manifest-path rust/Cargo.toml -p vcp-agent-core -p vcp-agent-tui --all-targets -- -D warnings`、`cargo test --manifest-path rust/Cargo.toml -p vcp-agent-tui --bin vcp-agent --quiet`（11 tests）、`npm run test:agent-workbench-store`、`npm run test:agent-workbench` 与 `node scripts/test-rust-protocol-fixture.mjs` 通过。覆盖分片 marker、未闭合 marker fail-closed、display-only store/card、TUI 编译以及 daemon v1.4 fixture。关联 Rust source revision 为 `62313507415ad2fc68e0a9ab3ece5c945f52d12a7af09f43baf1fb3779770f92`；真实 ToolBox VCPInfo/marker 仍需独立收据。
- release/hermetic：`npm run build:daemon` 后 `npm run test:rust-daemon-smoke` 通过。smoke 核验 daemon ready 的 `buildRevision` 与当前 Rust source revision 一致，避免旧 v1.2/v1.3 exe 被误验收为 v1.4。
- real ToolBox：2026-07-30，`VCP_AGENT_LIVE=1 node scripts/test-live-rust-agent.mjs`（Nova 随机 sentinel）、`test-live-rust-attachments.mjs`（PNG import → vision → Topic redaction）、`test-live-rust-tools.mjs`（FileOperator `requested → running → completed`）、`test-live-rust-backend-yolo.mjs`（本地 allow → `PowerShellExecutor(Get-Location)` completed）、`test-live-rust-long-task.mjs`（FileOperator → SciCalculator → marked answer）和 `test-live-rust-lifecycle.mjs` 均以 exit 0 完成。当前 lifecycle 先等待真实 SSE delta，再取消，并严格断言 `runtime.interrupt_result.payload.accepted === true`、不可重放 checkpoint、恢复和真实压缩；这构成当前 ToolBox `activeRequests` 的可关联命中收据。它们不修改 ToolBox 审批配置；YOLO 场景只执行 `Get-Location`。
- real ToolBox + VChat DistributedServer：2026-07-30，Rust source revision `af36524897eb02024fc32d276ee34c6483279799a56b279c69cd840d02cadd9f`，保持 `start.bat` 启动的 VChat Electron Main 在线且 `enableDistributedServer=true`，执行 `$env:VCP_AGENT_LIVE='1'; $env:VCP_AGENT_LIVE_MUTATE_TOOLBOX_APPROVAL='1'; $env:VCP_TOOLBOX_ROOT='C:\VCP\VCPToolBox-upstream-latest'; $env:VCP_AGENT_RUST_DAEMON_PATH='<revision-matched isolated vcp-agentd.exe>'; node scripts/test-live-rust-backend-approval-replay.mjs` 以 exit 0 完成。该测试先用在线 Rust VCPLog 观察并拒绝一次 VChat `PowerShellExecutor`，确认设备状态已建立；再在 Rust 设备离线期间发起第二次真实 `/v1/human/tool` 请求，重连严格收到 `_vcpReplay=true`，写回 deny 后 HTTP 返回 `approval_rejected`，两个 sentinel 均未创建，第三次连接不再 replay。测试 finally 逐字节恢复 `toolApprovalConfig.json`，退出后无测试 daemon 残留。
- real ToolBox + VChat DistributedServer：2026-07-30，Rust source revision `3e35bc4cea29ce188d363b79b8dd5f26c137c98a7b57b73619bacad6fd3ec8bb`，保持 `start.bat` 启动的 VChat Electron Main 在线且 `enableDistributedServer=true`，执行 `$env:VCP_AGENT_LIVE='1'; $env:VCP_AGENT_LIVE_MUTATE_TOOLBOX_APPROVAL='1'; $env:VCP_TOOLBOX_ROOT='C:\VCP\VCPToolBox-upstream-latest'; $env:VCP_AGENT_RUST_DAEMON_PATH='<revision-matched isolated vcp-agentd.exe>'; node scripts/test-live-rust-backend-approval-replay.mjs` 以 exit 0 完成。该测试先用在线 Rust VCPLog 观察并拒绝一次 VChat `PowerShellExecutor`，确认设备状态已建立；再在 Rust 设备离线期间发起第二次真实 `/v1/human/tool` 请求，重连严格收到 `_vcpReplay=true`，写回 deny 后 HTTP 返回 `approval_rejected`，两个 sentinel 均未创建，第三次连接不再 replay。同一 revision 以 `node scripts/test-live-rust-backend-approval-expiry.mjs` 临时将 ToolBox TTL 设为 3 秒：离线请求真实超时并返回 500，重连无旧 approval replay，后续新 `PowerShellExecutor` 审批可观察、拒绝且不执行。两个测试的 finally 逐字节恢复 `toolApprovalConfig.json`，退出后无测试 daemon 残留。
- 尚未验证：TUI 粘贴图片的真实桌面 clipboard smoke、真实短音频/视频、ToolBox 真实超大 WS frame 和真实 VCPInfo/marker notification。

2026-07-30，Rust source revision
`3e35bc4cea29ce188d363b79b8dd5f26c137c98a7b57b73619bacad6fd3ec8bb`：

- hermetic：`cargo test --manifest-path rust/Cargo.toml -p vcp-grok-image-attachments -p vcp-agent-core -p vcp-agent-host -p vcp-agent-protocol -p vcp-agent-vcp -p vcp-agentd`通过（Core 25、Host 29、Protocol 3、VCP adapter 11、daemon 3、attachment leaf 7）。覆盖 marker 分片/未闭合 fail-closed、VCPInfo 分类、结构化 tool resources/`vcpAudit`、图片与音视频 descriptor、data-URI/path 净化、审批 replay TTL 和设备名覆盖字符集。
- hermetic：`cargo clippy --manifest-path rust/Cargo.toml -p vcp-grok-image-attachments -p vcp-agent-core -p vcp-agent-host -p vcp-agent-protocol -p vcp-agent-vcp -p vcp-agentd --all-targets -- -D warnings`、各 crate `cargo fmt --check`、`npm run test:rust-agent-runtime`、`npm run test:agent-workbench-store`、`npm run test:agent-workbench`和 `node scripts/test-rust-protocol-fixture.mjs` 通过。Workbench 收据包含 renderer-only VCPInfo/marker 卡、工具资源和 snapshot-first 恢复，不将它们变成第二执行通道或 JS 持久化。
- release/protocol：`npm run build:daemon && npm run test:rust-daemon-smoke && node scripts/test-rust-protocol-fixture.mjs` 通过；`ready.buildRevision` 与本 revision 一致，可避免旧 daemon 产物被用作适配验收收据。
