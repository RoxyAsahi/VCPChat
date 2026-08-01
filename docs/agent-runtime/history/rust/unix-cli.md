# Rust standalone Unix / script CLI

最后更新：2026-07-30。适用工作树：`codex/vcpchat-rust-agent-origin-sync`，基线 commit `4209a1ec` 加未提交的 R6 CLI 修改。

`vcp-agent.exe` 有两种 standalone 表面：正常终端上的交互 TUI，以及 `--print` 的单次、无界面脚本模式。两者共享同一个 Rust Host/Core；CLI 不通过 Electron、不调用 daemon 的 framed stdin/stdout，也不直接访问 VCPToolBox。

```text
stdin / CLI 参数
  → vcp-agent --print (Rust CLI projection)
  → Rust Host/Core
  → VCPToolBox
```

这保持 GUI 的黑箱边界不变：Electron 仍只通过 `vcp-agentd --direct` 做 transport，daemon 的长度前缀 JSON 协议绝不是用户文本管道协议。

## 用法

```powershell
git log --oneline | .\vcp-agent.exe --print "分析这些提交，找出可能的问题"
Get-Content error.log -Raw | .\vcp-agent.exe --print "分析这些错误" --output-format json
.\vcp-agent.exe --print "总结这个 diff" --stdin --workspace C:\repo < changes.patch
```

非 TTY stdin 加一个 prompt positional 也会进入 headless 模式：

```powershell
Get-Content error.log -Raw | .\vcp-agent.exe "分析这些错误"
```

脚本中推荐显式使用 `--print` 和 `--workspace`，避免 workspace 与 prompt positional 的歧义。没有 `--persist` 时，每个调用使用临时 Topic，并在 Host 释放 lease 后删除；`--resume` 自动使用持久 Topic，`--persist` 可保留新 Topic。

## 标准流契约

| 模式 | stdout | stderr |
| --- | --- | --- |
| `plain`（默认） | 仅 assistant 最终文本流 | 警告、取消、审批和诊断 |
| `json` | 恰好一个 JSON object | 警告和诊断 |
| `streaming-json` | JSONL：`start`、`text`、可见 reasoning/status、`end/error` | 警告和诊断 |

`json` 的终态字段为 `ok`、`text`、`stopReason`、`sessionId`、`turnId`、`topicId`、`persistent` 和可用时的 `usage`。`streaming-json` 不输出 ToolBox 参数或结果正文，避免把脱敏边界以外的工具数据意外写入 shell 管道。

标准输入以 UTF-8 文本读取，默认最多 1 MiB；`--stdin-max-bytes` 可在 1 到 8 MiB 范围内调整。超限或非 UTF-8 一律在请求模型前失败。stdin 被嵌入明确的 `<vcpscript-stdin>` 数据边界，并声明为不可信分析数据；这不是安全 sandbox，调用者仍不得把不可信内容当作可信 agent 指令。

## 取消与审批

`Ctrl+C` 发送同一个 Rust Host 的 `Cancel`，继而由 Host/Core 执行模型中断、ToolBox best-effort interrupt、interrupted checkpoint 与 Topic lease 释放。CLI 最多等待 10 秒完成清理，取消退出码为 130。

无界面模式不会弹出本地审批。默认 `ask` 遇到高风险工具时使用原始四元组 binding 立即发送本地 deny，并以退出码 3 标记 `approval-denied`；`--always-approve` / `--yolo` 只改变该客户端本地判断。ToolBox 后端审批仍独立，CLI 永远不能绕过它。

## 非目标

- 不把 daemon 的 framed stdin/stdout 暴露为 shell 文本管道。
- 不增加本地 Shell、文件工具、MCP、worktree、插件系统或工具目录。
- 不改变 GUI/Workbench、Electron Main 或 daemon v1.5 协议。
- 不把临时 CLI transcript 写入 localStorage、主聊天 Topic 或 VCP-CDS。

## 当前验证

2026-07-30，hermetic、未提交 R6 工作树：

```powershell
cargo test --manifest-path rust/Cargo.toml -p vcp-agent-cli
cargo test --manifest-path rust/Cargo.toml -p vcp-agent-tui --test headless_cli -- --nocapture
cargo clippy --manifest-path rust/Cargo.toml -p vcp-agent-cli -p vcp-agent-tui --all-targets -- -D warnings
cargo fmt --manifest-path rust/Cargo.toml --all --check
npm run build:tui:dist
```

以上命令均已通过。`headless_cli` 启动真实 `vcp-agent` 子进程和本地 mock ToolBox gateway，验证显式 `--print` 和非 TTY positional prompt 两种管道入口、模型请求的数据边界、JSON stdout 纯度、终态 usage 与临时 Topic 标记。第二个进程测试让模型请求高风险 `PowerShellExecutor`：CLI 使用完整 approval binding 以 exit 3 / `approval-denied` 拒绝，并证明没有请求 `/v1/human/tool`。CLI 单测还验证已落盘的 `turn.cancelled` 投影为 shell exit 130，并在关闭前发送 Host shutdown。`release-dist` 的 `vcp-agent.exe` 为 16,465,920 bytes，低于当前 18,962,944-byte release gate；普通 `release` profile 为 21,412,864 bytes，因超过同一 gate 而失败，不能作为发布产物。

2026-07-30 在显式 opt-in 的本机 ToolBox 环境中，`http://localhost:6005` 的 `/v1/models` preflight 通过；`Nova` + `gpt-5.6-terra` 的 `--print --output-format json` 精确回显 `VCP_RUST_CLI_SENTINEL_7F3A`，真实 stdin pipe 精确回显 `VCP_PIPE_SENTINEL_C94E`。两次均为临时 Topic、`stopReason=completed`，并得到 provider usage。这只验证普通文本与管道链路，不是工具、后端审批或 Ctrl+C 终端信号的 live 收据。

ToolBox 工具/后端审批、Windows Terminal/PowerShell 的 Ctrl+C 手工信号验收仍属于 opt-in live 门槛。因此 R6 仍是 `in progress`，不能宣称脚本模式已生产验收。
