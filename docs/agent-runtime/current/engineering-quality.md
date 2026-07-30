# Rust Agent 工程质量与复用边界

最后更新：2026-07-30。当前分支：`codex/vcpchat-rust-agent-origin-sync`。

## 不变架构

```text
VCPChat Renderer
  -> Electron Main（参数校验、进程监督、事件转发）
  -> vcp-agentd
  -> Rust Host/Core
  -> VCPToolBox
```

Electron 不保存 transcript、usage、工具结果或审批真状态。Rust Topic 是唯一持久真源；VCPToolBox 是模型、Agent 身份、插件、工具执行和后端审批权威。

当前 VChat 内嵌 `rust/` 比独立 `VCPAgent-rust-core` 多出 Markdown、token estimation、crash handler 和集成协议修复。独立仓库不再作为反向合并真源，只保留历史参考。

## Grok Build

Grok Build revision `02d9359` 为 Apache-2.0。已经受控导入 compaction、interjection、prompt queue、token estimation、crash handler、Markdown 与 textarea；clipboard 和 PTY harness 只抽取必要部分。完整来源见 `rust/GROK_SOURCE_PROVENANCE.md`。

附件复用同样遵守 leaf-only 边界：`vcp-grok-image-attachments` 受控导入
`xai-grok-tools` 的图像验证/压缩实现，保留 NOTICE。它只产出带 SHA-256 的 Topic
asset descriptor；Base64 仅由 Rust Host 在向 ToolBox 发送模型请求前临时生成。不得导入
Grok pager、session JSONL、Agent 或 Shell。

后续候选：

| 候选 | 决定 | 边界 |
| --- | --- | --- |
| `xai-circuit-breaker` | 先写失败/洪峰 fixture，再决定受控导入 | 仅保护模型 catalog、模型请求和 WS；不得自动重试已发送的工具执行 |
| `xai-grok-secrets` | 可受控导入 pattern sanitizer | 必须叠加现有跨 SSE chunk 精确密钥脱敏，不能替换它 |
| `xai-grok-pager/src/headless.rs` | 已受控裁剪 output format/emitter 形状 | 仅 `plain/json/streaming-json` stdout 合约；不导入 ACP、Grok session、认证、Shell、MCP、sandbox 或工具策略 |
| `xai-grok-test-support/src/headless.rs` | 已借鉴进程验收结构 | VCP 使用自己的 mock ToolBox gateway；不导入 Grok sandbox、Agent 或认证 |
| `xai-ratatui-inline` | 条件式拒绝 | 只有 minimal PTY regression 先失败才采用 |
| lifecycle/tracing/http/sampler | 不导入 | 会增加第二套扩展、遥测、认证或模型策略 |

## Pi Agent Rust

本地 revision `b27abd57` 采用 MIT + OpenAI/Anthropic Rider。该 Rider 不允许把源码复制、修改、分析后纳入衍生工程，因此本项目不直接导入任何 Pi Rust 源码。以下只作为独立实现的通用工程方法：

- machine-readable contract/verdict，阻止文档提前宣称完成；
- Loom 并发状态模型；
- property、snapshot、fuzz 与损坏恢复测试；
- 有界队列、背压、溢出计数和 soak stability；
- CI、benchmark、coverage、semver、release、publish、weekly certification 分层；
- JSONL 测试证据中的 run ID、correlation ID、revision、artifact 和复现命令。

明确拒绝 ACP、SQLite/JSONL Session Store、内建文件/Shell 工具、QuickJS/WASM 扩展、provider registry、Pi TUI 和 `asupersync`。这些能力会与 VCPToolBox 或现有 Tokio actor 重叠。

## 当前缺口

- Core Session channel 有界，但 Host command/event 与旧 TUI bridge 仍存在 unbounded channel。
- 当前约 1100 个 workspace 测试多数来自导入 crate；VCP 自有 Core/Host/Protocol/VCP/daemon/TUI/PTy 测试约 99 个。
- 旧 `rust_assistant_engine` workflow 不覆盖当前 Rust Agent 产品链。
- 尚无 framed protocol、SSE、marker、Topic 和 secret redaction 的 property/fuzz lane。
- 尚无 cancel/approval/Topic takeover 的 Loom 证明。
- Host 的 Windows PID liveness 使用一小段 Win32 FFI；它必须保持局部、带平台测试并单独审计，不能用 workspace-wide `unsafe_code=deny` 掩盖实际边界。
- 尚无持续记录的启动、首 delta、RSS、Topic 恢复和 TUI frame 性能预算。

## R5 验收门槛

### 当前证据

2026-07-29，Rust source revision
`63ce97ed3b4bdb6f84b0300687a3a49023d2a91395cffb49790c9e7289b25e0f`：

- `cargo fmt --manifest-path rust/Cargo.toml --all --check` 通过。
- `cargo clippy --manifest-path rust/Cargo.toml --workspace --all-targets -- -D warnings` 通过。
- `cargo test --manifest-path rust/Cargo.toml --workspace` 通过：1128 个测试通过，1 个真实 ToolBox opt-in PTY 测试按设计忽略。
- `npm run check:rust-agent-runtime` 与 `npm run test:rust-stack` 覆盖 v1.5 fixture、daemon framed stdio、Topic takeover、Renderer projection、Electron crash/reconnect 和双窗口协作接管；每次协议变更后必须重新取得当前 revision 的完整收据。
- `npm run build:daemon:dist` 通过：`vcp-agentd.exe` 3,838,464 bytes。
- `npm run build:tui:dist` 通过：`vcp-agent.exe` 6,958,080 bytes，较 Markdown 导入前基线增加 578,048 bytes，低于 18,962,944-byte gate。
- `release-dist` daemon 通过 revision-aware framed stdio smoke；`release-dist` TUI 的 `--version` 启动 smoke 通过。CI distribution job 已固定执行相同检查后才上传产物。

这些证据只将 `rust-quality`、`protocol-hermetic` 和 `windows-distribution` 标为 pass。真实 ToolBox 的当前 revision 验收尚未重跑，因此 `live-toolbox` 仍为 pending，整体 verdict 必须保持 `NOT_READY`。

### Fast PR

```powershell
npm run check:rust-quality
npm run test:rust-unit
npm run check:rust-agent-runtime
npm run check:rust-readiness
```

### Windows hermetic

```powershell
npm run test:rust-stack
```

### Distribution

```powershell
npm run build:daemon:dist
npm run build:tui:dist
```

`npm run check:rust-readiness:release` 是最终发布判定，不是普通构建步骤。只有 live opt-in 收据也绑定当前 Rust revision 后才应通过；在此之前失败是正确行为。

### Live opt-in

真实 ToolBox 门槛继续要求 `VCP_AGENT_LIVE=1`，不能在默认 CI 中读取 API Key。普通聊天、低风险工具、高风险本地拒绝、取消、压缩、恢复和 capability lifecycle 必须分别生成脱敏收据。

## 性能策略

Windows 首发保持系统 allocator。Grok 和 Pi Rust 的 jemalloc 都只用于 Unix；没有 Windows A/B benchmark 前不得更换 allocator。

正式产物使用 `release-dist`：thin LTO、单 codegen unit、关闭 incremental、panic abort、保留 line tables/PDB。不得使用 `target-cpu=native` 构建分发二进制。

首批预算覆盖 daemon ready、首 delta、100 Turn RSS 漂移、10k 消息 Topic 恢复、64 KiB 工具结果、1 万 SSE chunk、Markdown frozen-tail、压缩取消延迟和退出残留进程。
