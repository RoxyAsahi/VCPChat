# Rust Agent 交付、影响边界与下一阶段计划

状态规则：只有该行的代码、文档和指定验证都通过，才能改为 `complete`。过去某次通过、真实 ToolBox 曾可用或旧分支证据均不计入当前 revision。

| 阶段 | 门槛 | 状态 | 当前证据 |
| --- | --- | --- | --- |
| R0 | 仅 `current/` 定义产品；Pi/Driver/SQLite/submodule/`vcp_delegate` 均归档 | complete | 2026-07-29，hermetic 文档拓扑审计：`rg` 当前/根入口审计、`npm run check:rust-agent-runtime`、`git diff --check`；Rust source revision `73effc24b6ddb3453c8a21adc6d9b363f79558b960f8e647a0a9c1cdba7da982`。这些旧术语只在明确的 history 指针或“非当前”说明中出现。 |
| R1 | v1.2 command/ack/event schema、Rust/JS fixture、ready runtime 校验 | complete | 2026-07-29，hermetic：`node scripts/test-rust-protocol-fixture.mjs`、`npm run check:rust-agent-runtime`、`npm run test:rust-daemon-smoke` 与 `cargo test --manifest-path rust/Cargo.toml -p vcp-agent-protocol -p vcp-agentd`。direct command 仅保留本文件列出的集合；旧 `start-session`、`list-agents`、`list-models`、`tool-result` fixture 均 fail closed；Renderer 不再用 ACK/active Turn/旧工具状态推断关联。Rust source revision `73effc24b6ddb3453c8a21adc6d9b363f79558b960f8e647a0a9c1cdba7da982`。 |
| R2 | Topic 真源、单 attachment、snapshot-first、presence close、无 Main replay | complete | 冻结边界的证据保留在 R2 提交 `dc5330b7`；后续 GUI 变更必须重新跑下列当前门槛，不能用历史 revision 外推。2026-07-29：当前 Electron hermetic smoke 已通过 close/reopen、snapshot 恢复、显式 daemon crash/reconnect 和退出清理；当前 daemon workspace revision `8b3fb40aea55d7a711eebca4bccd8441dcd77726610c912506d133a9cc0c6303`。 |
| R3-A | 独立新建/打开 Topic 流程与 lease/checkpoint 状态页 | complete | 当前工作树已把创建配置来源、空闲 checkpoint、只读预览和安全接管做成明确页面状态，并移除了 Agent Workbench 对主聊天 sidebar DOM clone 的依赖。2026-07-29：`npm run test:agent-workbench`、`npm run test:agent-workbench-store`、`npm run test:electron-gui-smoke` 和 `npm run test:electron-topic-takeover` 通过；后者验证两个真实 Electron 窗口的协作 lease 释放、checkpoint 读取和安全接管。daemon workspace revision `8b3fb40aea55d7a711eebca4bccd8441dcd77726610c912506d133a9cc0c6303`。 |
| R3-B | streaming、工具、审批、WS Block 的长内容与响应式视觉回归 | complete | 2026-07-29，Rust source revision `a98c5991e1552ac6197dd9d6fb66366c505fc5d963b3486ad9023eaebe08c681`：default Electron smoke 通过 680/960/1440px 长消息布局与 crash/reconnect；真实 GUI gates 分别通过 FileOperator `requested → running → completed`、PowerShellExecutor 完整 binding 后的本地默认拒绝、只读 VCPLog/VCPInfo WS 卡和不少于 4,000 字符的流式回复。长流实际获得 6,800 字符，并验证打开活动面板后的非边缘阅读位置未被重置。收据在 `%TEMP%\\vcpchat-live-file-approval-current.json`、`%TEMP%\\vcpchat-live-file-ws-current.json`、`%TEMP%\\vcpchat-live-long-stream-current.json`。 |
| R4 | Rust daemon readiness 与 ToolBox/DistributedServer 可诊断性 | in progress | Host 发 `runtime.readiness`：共享 Server/API Key、共享 Agent/模型、受认证 ToolBox `/v1/models` 探测，以及 VCPLog 生命周期推导的 capability node。2026-07-29：`node scripts/test-rust-daemon-smoke.mjs` 断言 `checking → unavailable`；default Electron smoke 断言四张 daemon-owned 卡；live GUI 已断言 ToolBox `就绪` 与只读 WS 卡。`/vcp-distributed-server` 是 node 注册通道，禁止作为 observer。仍缺的是 observer 已启动后、现有 DistributedServer capability node 一次真实 reconnect 的 `capability=ready` 生命周期证据；未知必须继续显示未知，不能猜测。 |

## 当前可重复验证

## 2026-07-29 上游整合记录

本分支基于 Rust Agent 集成提交 `9f083b24`，在独立整合分支中合入
`origin/main` 的 13 个上游提交（合并基线 `4b73a719`）。整合保留了 Rust
daemon 的唯一 Agent Runtime 边界、Workbench snapshot-first 投影、daemon
构建/打包资源和原有启动入口；上游的 VCP-CDS、DeepMemo、MobileSync、主聊天
渲染修复和主题资源则作为主聊天/DistributedServer 功能接入，未成为 Agent
Topic 的第二持久化来源。

本次仅计入下列当前 revision 的 hermetic 证据：

- `npm run build`（同时构建 VCP-CDS 与 `vcp-agentd`）；
- `node --test tests/deepmemo-central-adapter.test.js tests/mobile-sync-central-adapter.test.js`；
- `npm run test:rust-stack`、`npm run test:agent-workbench`、`npm run test:electron-gui-smoke`；
- `cargo fmt --manifest-path rust/Cargo.toml --all --check`、
  `cargo clippy --manifest-path rust/Cargo.toml --workspace -- -D warnings`、
  `cargo test --manifest-path rust/Cargo.toml --workspace`；
- 同等的 `rust_chat_data_service` fmt/clippy/test 门槛。

真实 ToolBox 和 DistributedServer capability 证据仍保持 opt-in，不能由这次上游
合并或 hermetic 通过替代；R4 继续为 `in progress`。

R0–R2 已在 2026-07-29 以 hermetic 模式完成本 revision 的验收。下列是每次 Runtime 修改后都必须重新运行的门槛；不得将本次结果外推到未来 revision。

```powershell
npm run build:daemon
node scripts/test-rust-protocol-fixture.mjs
cargo test --manifest-path rust/Cargo.toml --workspace
npm run test:rust-agent-runtime
npm run test:rust-daemon-smoke
npm run test:agent-workbench-store
npm run test:agent-workbench
npm run test:electron-gui-smoke
npm run test:electron-topic-takeover
```

还必须执行 `cargo fmt --all --check --manifest-path rust/Cargo.toml`、`cargo clippy --manifest-path rust/Cargo.toml --workspace -- -D warnings`、`cargo test --manifest-path rust/Cargo.toml --workspace`、`git diff --check` 与 R0 文档拓扑审计。Electron smoke 只有在明确显示通过后，才能作为 Topic attachment、Workbench projection、daemon crash/reconnect、close/reopen 和退出清理的证据。2026-07-29 default smoke 与 `test:electron-topic-takeover` 的双窗口收据均已通过；R3-B 的 GUI real ToolBox/WS/长流门槛仍须独立执行，不能由 hermetic smoke 或 direct Rust live 代替。

## R3-A：独立 Topic 产品流程（完成）

R3-A 的目标不是把主聊天的“新建会话”按钮复制到 Agent Workbench，而是把 Rust Topic 的创建、读取和 lease 语义变成可见且可确认的产品流程。

1. 任何新建入口先显示共享 Agent、共享模型、workspace 和标题；只有用户点击“创建并打开”才发送 `create-session`。
2. 点击持久 Topic 必须先 `read-topic`，展示 Rust checkpoint。空闲 Topic 只能由“打开并恢复”附着；占用 Topic 明确提供只读 checkpoint 或请求安全接管，不能由侧栏点击隐式夺取写入权。
3. 弹层的表单/读取/错误状态只存在 Renderer 内存；Agent/model catalog 继续来自 VCPChat 共享配置，Topic、lease、snapshot 和 attachment 继续来自 daemon。
4. 2026-07-29 的 JSDOM、680/960/1440 Electron layout、空闲恢复、daemon crash/reconnect 和双窗口安全接管均已通过。真实 ToolBox 流式、审批、WS 通知与长 Topic 的视觉交互仍归 R3-B/R4，不能因 R3-A 完成而外推。

## R3-B：真实 Block 与视觉回归（进行中）

R3-B 只验证来自 daemon 的真实事件投影，不允许 Renderer 伪造工具、审批或 WebSocket 状态。现有 hermetic 测试覆盖事件渲染、8 KiB 参数文本、streaming DOM identity 与滚动锚点；Electron smoke 必须在 680/960/1440px 验证 Workbench、Topic flow、readiness 和真实 Tool/Approval Block 不溢出。

真实 ToolBox 验收仍是显式 opt-in，须在当前工作树重新记录通过结果：

```powershell
$env:VCPCHAT_E2E_LIVE_TOOLBOX = '1'
# 可按需打开；每个开关都有不可替代的断言。
$env:VCPCHAT_E2E_LIVE_TOOLBOX_HIGH_RISK = '1'
$env:VCPCHAT_E2E_LIVE_TOOLBOX_WS = '1'
$env:VCPCHAT_E2E_LIVE_TOOLBOX_LONG_STREAM = '1'
npm run test:electron-gui-smoke
```

`WS=1` 已在 2026-07-29 通过：Rust 只读 VCPlog/vcpinfo observer 产出真实卡片，Electron 在 680/960/1440px 完成卡片可视与无横向溢出检查；收据为 `%TEMP%\\vcpchat-live-file-ws-current.json`。`LONG_STREAM=1` 也已在同一 Rust source revision 通过：实际输出 6,800 字符，超过 4,000 字符门槛，并验证用户滚到历史位置后打开连接活动面板仍处于可读的非边缘位置；收据为 `%TEMP%\\vcpchat-live-long-stream-current.json`。此前 provider 的 3,429 字符短流和一次无输出超时仅作为历史失败记录，不计入当前通过。2026-07-29 同时修复了导致短流的真实 Runtime 差异：Rust Host 从共享 Agent `config.json` 读取 `maxOutputTokens`，Core 在模型请求中发送对应的 OpenAI-compatible `max_tokens`（`cargo test --manifest-path rust/Cargo.toml -p vcp-agent-host shared_agent_output_limits_are_loaded_without_creating_a_second_profile` 与 `cargo test --manifest-path rust/Cargo.toml -p vcp-agent-core model_request_uses_shared_agent_max_output_when_configured` 通过）。Agent feed 还显式脱离主聊天的 `column-reverse`/`content-visibility:auto` 优化，使用正常的时间顺序和可保持的滚动坐标；这仅作用于有界 Rust Topic，不影响主聊天。

## R4：daemon readiness（进行中）

`runtime.readiness` 是 Rust Host 事件而不是 Renderer probe：

1. `server` 只说明共享 VCPChat Server/API Key 是否齐备，绝不发送密钥。
2. `profile` 只说明共享 Agent/模型是否可用。
3. `toolbox` 由 Rust 的受认证 `/v1/models` 探测异步更新为 ready/unavailable。
4. `capability` 只从 VCPlog 中 `Distributed Server … authenticated and connected/disconnected` 生命周期记录推导；未知时必须显示未知。

`/vcp-distributed-server` 会注册一个 DistributedServer node，因而不是观察通道。Rust Host 只观察 `VCPlog` 与 `vcpinfo`，Electron/Renderer 不得连接、探测或伪造 capability 状态。R4 只有在 default Electron smoke 和真实 ToolBox 场景都重新通过后才可完成。

真实 ToolBox 验收仍是单独的 opt-in gate，必须设置 `VCP_AGENT_LIVE=1`，且不得回显密钥。它不属于 R0–R2 的完成证据，也不能被本次 hermetic 通过替代；普通聊天、真实工具、高风险拒绝、取消和长会话压缩须在有 ToolBox 环境时重新记录。

## Appendix：standalone TUI（独立于 GUI R3-A/R3-B/R4）

适用 Rust workspace revision：`8b3fb40aea55d7a711eebca4bccd8441dcd77726610c912506d133a9cc0c6303`。本次只把可重复证据计入状态，不把旧分支或旧协议下的成功记录外推到当前代码。

| 层面 | 当前判断 | 证据或缺口 |
| --- | --- | --- |
| Rust Core | 功能核心可用，约 90% | `cargo test --manifest-path rust/Cargo.toml --workspace -- --list` 注册 1126 个 Rust 测试；当前 workspace 全测的非 ignored 测试全部通过，覆盖 actor、工具循环、取消、steering/follow-up、压缩、Topic、审批 binding、VCP marker/SSE/WS、估算 usage 来源与 TUI 基础行为。 |
| Rust Host / ToolBox | 真实链路可用，约 88% | 2026-07-29 使用当前工作树执行 `VCP_AGENT_LIVE=1 npm run test:rust-agent-live`、`test:rust-agent-tools-live` 与 `test:rust-agent-lifecycle-live`：Nova 精确回显随机 sentinel；`FileOperator` 出现 `requested -> running -> completed`；`PowerShellExecutor` 在 `awaiting_local_approval` 被本地拒绝且未进入 running；取消、interrupted checkpoint、恢复和真实压缩落盘通过。lifecycle wrapper 仅因测试前已存在的用户 daemon 进程而以清理码 2 退出，功能断言已通过；后续清理门槛应比较测试前后 PID 集合。 |
| standalone TUI 执行链 | 真实任务链已验证，约 95% | `vcp-agent.exe` 直接调用 `vcp-agent-host::start()`，不依赖 Node/Pi。除 Host command-channel 单测外，`VCP_AGENT_TUI_LIVE=1 npm run test:rust-tui-live` 已用真实 ConPTY 键盘输入，经 Rust Host/Core 调用真实 `FileOperator` 并返回 `vcp-chat-desktop` package 名称。`Ctrl+Enter` 保留；Windows ConPTY 另提供可靠的 `Ctrl+S` 提交键。 |
| standalone TUI 产品体验 | 进行中，约 94% | Markdown、clipboard route/trust、长流自动跟随、结构化 usage/budget/settings、Topic 多动作选择器、queue 单项删除/替换/清空、Host-owned 审批截止时间、ToolBox observer Block、长工具结果详情，以及 8 个 hermetic Windows PTY 测试和 1 个真实 ToolBox PTY 测试已完成。跨 Block 系统选择、中文 IME 实机矩阵和发布终端手工 smoke 仍是最终产品体验门槛。 |

所有 direct Rust live 脚本现已显式发送 v1.2 必填的 `turnId`，`node scripts/test-rust-live-contracts.mjs` 对当前 7 个请求做 hermetic 回归。真实工具联调同时暴露并修复了 producer 关联 bug：Core 事件原先只在 event payload 内携带 `turnId`，Host 清除 active Turn 后无法再补齐外层关联，导致下一 Turn 被误判为仍有活动 Turn。`vcp-agent-core::emit_for_turn` 现在直接设置外层 `WireMessage.turn_id`，并有覆盖所有 Turn event 的回归断言；这保持 GUI adapter 为纯 transport，不引入 Electron 侧猜测。

2026-07-29 当前工作树的 live 证据如下；密钥只通过进程环境传入且不写入日志：

| 命令 | 模式 | 结果 |
| --- | --- | --- |
| `$env:VCP_AGENT_LIVE='1'; npm run test:rust-agent-live` | Nova + 真实 ToolBox | 通过，精确回显随机 sentinel |
| `$env:VCP_AGENT_LIVE='1'; npm run test:rust-agent-tools-live` | FileOperator + 高风险 PowerShellExecutor | 通过，低风险工具完整完成；高风险工具停在本地审批并拒绝 |
| `$env:VCP_AGENT_LIVE='1'; npm run test:rust-agent-lifecycle-live` | 取消、恢复、压缩 | 功能断言通过；wrapper 因测试前已存在的非本次 daemon 进程返回清理码 2，不能计作无残留进程门槛通过 |
| `$env:VCP_AGENT_TUI_LIVE='1'; npm run test:rust-tui-live` | 真实 ConPTY 键盘 → standalone TUI → Rust Host/Core → FileOperator | 通过，真实工具完成并返回 `vcp-chat-desktop` package 名称；使用隔离 settings/Topic root |

## Standalone TUI 产品化（不占用 GUI R3 编号）

R3 的目标是在不改变 Cherry-style 黑盒 GUI 架构的前提下，把 `vcp-agent.exe` 从“真实可执行的工程版本”收敛为可长期使用的 standalone 产品。执行顺序固定如下。

### Grok Build 受控复用计划

本轮复用基线固定为本地 `C:\VCP\vchat-develop\grok-build` revision `02d9359`（Apache-2.0）。VCPAgent 不直接依赖该外部 checkout，也不把整个 Grok workspace 作为 Git/path dependency；可采用的代码必须复制为独立可编译的 leaf crate 或最小抽取模块，并在落地时同步更新 `rust/GROK_SOURCE_PROVENANCE.md`、Apache LICENSE/NOTICE、原路径、revision、导入日期和本地修改清单。下表中的 `planned` 不等于已导入。

| Grok 来源 | 复用方式 | 纳入阶段 | 直接收益 | 采用边界 |
| --- | --- | --- | --- | --- |
| `xai-crash-handler` | **已直接受控导入**为 `vcp-grok-crash-handler` | R3.1 | 复用 Windows unhandled-exception / Unix signal 恢复，覆盖 raw mode、鼠标、bracketed paste、focus、光标、alternate screen、同步更新和 Kitty keyboard protocol | 已只保留 terminal-restore API，并接入 panic hook + RAII；未引入 Grok crash upload、遥测或产品级 crash store。强制 debug panic 的真实 ConPTY fixture 已通过。 |
| `xai-grok-markdown-core` + `xai-grok-markdown` | **已直接受控导入**，由无状态 VCP TUI adapter 驱动 | R3.2 complete，R3.3 gate complete | 472+45 上游测试及 VCP CJK/table/code/link stream/full parity 通过；当前 release 相对基线增加 3,162,624 bytes | 不持有 Session/Topic/Tool；主题由 VCP adapter 注入；`npm run build:tui` 执行 18,962,944-byte gate。 |
| `xai-grok-pager-render/src/clipboard` 的 route/trust 逻辑 | **已最小受控抽取**，未导入 pager-render | R3.3 complete | native、tmux、OSC52 与 confirmed/unverified/failed 已接 textarea provider | 无 Grok env/telemetry/config；敏感工具结果不会自动复制。 |
| `xai-grok-pager-pty-harness` 的通用概念 | **已抽取为 test-only VCP crate** | R3.3 PTY gate complete | 8 个 hermetic Windows PTY 测试覆盖 CJK 长流、resize storm、真实 prompt 提交、审批默认拒绝、取消/恢复、minimal、长工具结果、Session 切换和强制 panic；另有真实 ToolBox FileOperator PTY gate | 未导入 Grok scenarios/Agent/mock inference/ptyctl；场景只驱动 `vcp-agent.exe` 与 VCP Host/Core 事件。 |
| `xai-ratatui-inline` | **当前不导入** | R3.3 decision complete | `--minimal` PTY fixture 未复现重复 sentinel、resize 丢失或 alternate-screen 污染 | 若未来出现稳定 failing fixture 再重新评估；不得预防性引入。 |
| `xai-token-estimation` | **已直接受控导入**为 `vcp-grok-token-estimation` | R3.2 | ToolBox 当前不返回可靠 usage；以同一 leaf crate 统一 bytes/4 token 估算、context 百分比、free tokens、threshold/headroom 的饱和整数运算 | Core 已投影 `provider`/`estimated`/`mixed` 来源，TUI 显示 `est. tokens`，费用继续未知；未来真实 usage 仍优先。VCP 中文安全余量只存在于统一 message adapter。 |

已经导入并继续保留的 `vcp-grok-compaction`、`vcp-grok-interjection`、`vcp-grok-prompt-queue` 和 `xai-ratatui-textarea` 不重复复制。`xai-circuit-breaker`、`xai-grok-secrets` 只做差异审计：当前 Host 已有 WS 退避与 VCP 专属跨 chunk secret redaction，除非测试证明现有实现缺失 open/half-open 语义或脱敏覆盖，否则不引入新的并行抽象。

明确拒绝复用完整 `xai-grok-pager`、`xai-grok-pager-render`、`xai-grok-pager-minimal`，以及 Grok Agent、Shell、本地工具、MCP、sandbox、workspace、worktree、auth、memory、telemetry、插件和 SQLite journal。它们会扩大依赖面，并破坏“Rust Runtime 是 GUI 黑盒、VCPToolBox 是唯一能力权威”的当前架构。

复用实施顺序固定为：先导入 crash handler 并完成异常终端恢复测试；随后导入 token estimation、删除重复公式并贯通 `estimated` 来源标记；再接 streaming Markdown 与长流性能 fixture；随后抽取 clipboard/OSC52；最后根据 PTY failing fixture 决定是否采用 `xai-ratatui-inline`。每个导入项必须独立通过 `cargo fmt`、`cargo clippy -D warnings`、原始上游测试、VCP adapter 测试和 Windows release build 后，才能从 `planned` 改为 `imported`。

### TUI-0：修复验收真源

状态：`complete`。v1.2 live 请求形状、native TUI/Host integration、当前工作树核心 live 场景、按键级 TUI PTY live smoke 和独立 Electron smoke 均已取得当前 revision 证据。

1. **完成**：所有 Rust live 脚本的 `start-turn` 显式携带唯一 `turnId`；`test-rust-live-contracts.mjs` 已进入 `check:rust-agent-runtime`。
2. **完成（hermetic）**：`native_tui_submit_uses_the_rust_host_command_channel` 验证 TUI submit 直接生成 `HostCommand::StartTurn`，不经过 JS bridge；Core event 与工具循环继续由 workspace actor/host 测试覆盖。
3. **完成（live）**：`test:rust-tui-live` 从真实 ConPTY 键盘输入触发 FileOperator，并断言完整工具状态与指定 package 名称；普通对话、高风险拒绝、取消、恢复和压缩由同 revision 的 direct Rust live gates分别严格断言。
4. **完成**：live 文档矩阵只记录当前 revision 明确成功的命令，不以“响应非空”或旧二进制结果代替。

### TUI-1：状态真实性与失败安全

状态：`in_progress`。配置阻断、真实状态投影和异常终端恢复已完成；Host channel/Session 重建的完整可恢复交互仍未完成。

1. **完成（hermetic）**：配置失败不再进入 `Runtime::Demo`；TUI 显示阻断原因、禁用普通 prompt，并提供 `/settings`。
2. **完成（projection）**：`/status` 读取现有 Runtime/ToolBox/permission 投影，删除硬编码 Ready/Connected/Ask；它不会绕过 Host 主动探测 ToolBox。
3. **完成（hermetic）**：已受控导入 Grok `xai-crash-handler` 的 terminal-restore leaf code，为 raw mode、alternate screen、鼠标、bracketed paste、focus、光标和 keyboard protocol 建立 RAII terminal session、panic hook 与 Windows/Unix 异常恢复；未引入 Grok 遥测或 crash upload。真实 PTY crash fixture 归 R3.3。
4. Host channel 关闭、ToolBox 不可达和 Session 重建失败必须进入明确可恢复状态，不能让输入看似成功但命令被丢弃。

### TUI-2：完整控制面投影

状态：`in_progress`。结构化控制面已经接通，剩余工作集中在 Topic 多动作选择器与审批时间语义，不再是通用 JSON Notice 的大面积占位。

1. **完成（hermetic）**：`/usage` 展示请求轮次、输入/输出/reasoning/cache/total token、上下文窗口、估算来源和费用未知状态。
2. **完成（hermetic）**：`/budget` 从 Rust Host 非敏感 settings snapshot 读取真实限制；更新只在 `settings-updated` 后显示成功，并明确下一 Session 生效。`/settings` 同样读取 Host 摘要，API Key/Server URL 不进入 UI。
3. **完成（hermetic）**：`read-topic` 投影为有界只读 checkpoint Block；同一个 Topic 选择器支持 Enter 恢复、Ctrl+O 只读、Ctrl+T 接管、F2 预填重命名和 Delete 显式确认。TUI 不持有 lease 或 Topic 真源。
4. **完成（hermetic）**：`/queue` 支持稳定 `interactionId` 的单项删除、替换、清空和 consumed 展示。Host 先校验 ID，再通过 Core `replace-interaction-queue` 原子提交；缺失 ID fail closed。
5. **完成（hermetic）**：ToolBox log/info、distributed lifecycle 和未关联后端审批使用专属 observer Block；同一 query 的 `RAG_RETRIEVAL_DETAILS` 多数据库事件按 Grok 式折叠为一张两行摘要卡，命中数聚合，连接确认/元思考链不进入 Conversation，原始元数据仅在 `/toolbox` 后展开。`/vcp-distributed-server` 仍禁止作为观察通道，WS 不参与工具执行。
6. **完成（hermetic）**：客户端审批显示完整 binding、风险、脱敏参数和 Rust Host 生成的 60 秒绝对截止时间并默认拒绝；Host 到期后向 Core fail-closed 发送 deny。Renderer/TUI 只显示倒计时，不再自行制造超时决定。后端审批继续显示为 ToolBox 自己的独立阶段。
7. **完成（hermetic）**：受控导入 `xai-grok-markdown-core`/`xai-grok-markdown`，无状态 VCP adapter 通过 frozen-tail 增量渲染 assistant/reasoning；代码块、表格、链接、CJK 和主题切换保持 full/stream parity。
8. **完成（hermetic）**：已受控导入 `xai-token-estimation` 为 `vcp-grok-token-estimation`，统一 Core 的 token 与压缩阈值基础算法。上游 usage 缺失时累计估算，存在真实值时优先并形成 `provider`/`estimated`/`mixed` 来源；费用保持未知。

### TUI-3：交互与发布质量

状态：`in_progress`。Markdown、clipboard、hermetic/真实 ToolBox PTY、minimal 决策、强制 panic 恢复与 release size gate 已完成；剩余门槛是跨 Block 系统选择、IME 实机矩阵和发布终端手工 smoke。

2026-07-29 hermetic 证据，Rust source revision
`8b3fb40aea55d7a711eebca4bccd8441dcd77726610c912506d133a9cc0c6303`：

- `cargo fmt --all --check --manifest-path rust/Cargo.toml`
- `cargo clippy --manifest-path rust/Cargo.toml --workspace --all-targets -- -D warnings`
- `cargo test --manifest-path rust/Cargo.toml --workspace`
- `cargo test --manifest-path rust/Cargo.toml -p vcp-agent-tui --test pty_acceptance -- --test-threads=1`（8 个 hermetic Windows PTY 测试）
- `VCP_AGENT_TUI_LIVE=1 npm run test:rust-tui-live`（1 个真实 ToolBox ConPTY/FileOperator 测试）
- 隔离 target 的 release build（9,542,656 bytes；18,962,944-byte gate；正式路径二进制在验证时被用户运行中的 TUI 锁定）
- 隔离 target 构建同 revision daemon 后，`check:rust-agent-runtime`、`test:rust-agent-runtime`、`test:rust-daemon-smoke`、`test:agent-workbench-store`、`test:agent-workbench` 通过。

默认 `test:electron-gui-smoke` 已通过 renderer boot、主聊天 Nova/Topic/composer、全局设置保存、Next UI reload、daemon readiness、budget readback 和显式 daemon crash/reconnect；旧 `.next-ui-create-dialog-host` blocker 未再复现。`test:electron-topic-takeover` 与真实 ToolBox PTY live gate 也已独立通过。

1. **部分完成**：60/80/120、CJK 和 Markdown parity 已有 buffer/PTY 证据；clipboard native/tmux/OSC52 已接 textarea。emoji、IME 和跨 Block 系统选择仍待补齐。
2. **完成**：test-only PTY harness 已覆盖长流、resize storm、真实 prompt 提交、审批默认拒绝、活动 Turn 取消、恢复投影、minimal、强制 panic、长工具结果详情和重复 Session 投影切换；opt-in live fixture 已完成真实 FileOperator 调用。
3. **完成**：minimal PTY fixture 通过，当前不导入 `xai-ratatui-inline`。
4. release `vcp-agent.exe` 通过 Windows Terminal 与 PowerShell 手工 smoke，并确认退出无残留任务。
5. 更新帮助、README 和开发命令，删除 JS bridge/demo 作为正式启动方式的陈旧说明。

## 架构保护规则

- R3 默认只修改 Rust TUI 和共享 Rust Runtime；不得把 Agent loop、Topic、审批、usage 或工具执行迁回 Electron Main/Renderer。
- TUI-only 改动不得要求 daemon 新协议。需要共享新语义时先修改 Host/Core，再决定是否由 v1.2 的既有 event 投影；确需扩协议则先改 fixture 和协议文档。
- `always-approve/yolo` 只影响本地客户端审批，永远不能绕过 ToolBox 后端审批。
- 不修改 VCPToolBox，不增加本地 Shell、文件工具、MCP、worktree 或第二套插件系统。
- 每个阶段完成前必须同时说明 standalone 证据和 GUI 回归证据；不能因为 TUI 可用就外推 GUI，也不能因为 GUI smoke 通过就宣称 TUI 产品化完成。
