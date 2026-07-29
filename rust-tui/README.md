# VCPAgent Rust TUI

This is the dedicated Rust TUI source workspace. It is intentionally a UI and
event-projection layer: it does **not** embed Grok Build's local tools, shell,
MCP, worktree, authentication, memory, or agent loop.

The first vendored primitive is Grok Build's Apache-2.0
`xai-ratatui-textarea`. It supplies the difficult terminal-input behaviour we
need on Windows: multiline editing, CJK display width, mouse selection,
scrollbar, bracketed paste, and cursor positioning.

Run the non-destructive visual event-projection demo:

```powershell
cd C:\VCP\vchat-develop\VCPAgent-rust-core\rust-tui
cargo run -p vcp-agent-tui
```

The demo opens on the same VCPCLI welcome screen used for the real product:
Nova, the selected model, workspace, ToolBox state and local permission state
are all UI projections, rather than a second agent implementation. `Ctrl+D`
loads a non-destructive visual transcript; it never calls ToolBox.

Run it against the real JS Host, Rust Core and VCPToolBox:

```powershell
cd C:\VCP\vchat-develop\VCPAgent-rust-core
npm run build:rust
npm run build:rust-tui
npm run agent:rust-tui -- . -- --model gpt-5.6-terra --agent Nova
```

The JS Host creates a local-only Windows named pipe and starts this executable
with `--bridge <pipe>`. The TUI inherits stdin/stdout only; JSON control
messages never enter the screen renderer. It uses the fullscreen alternate
screen by default; `--minimal` / `--no-alt-screen` now keeps the normal
terminal buffer. The Host keeps the VCP API key,
configuration, model SSE, marker protocol, workspace policy, ApprovalBroker,
secret redaction and ToolBox WebSocket bridge. The pipe is not a TCP listener.

Current interaction surface:

- `Ctrl+Enter`: submit a multi-line prompt to the host/Core. Slash commands
  such as `/theme` may use plain `Enter`; the theme chooser supports arrow
  keys plus Enter and direct mouse clicks.
- `/new`: safely closes the current daemon session and creates a new one.
- `/model <id>` and `/agent <id|name>` recreate a clean session; no-argument
  form shows the available catalog. `/steer`, `/queue`, `/clear-queue` and
  `/compact` expose the Runtime's active-interaction and safe-checkpoint flow.
- `/permissions ask|always-approve` changes the VCPAgent-local approval mode;
  it never bypasses ToolBox authorization. `/settings` still directs URL/API
  key changes to JS VCPCLI, so Rust TUI creates no second credential store.
- `/theme` or `Ctrl+T`: choose one of the seven VCPCLI themes locally.
- `Ctrl+R`: expand/collapse reasoning; `PageUp`/`PageDown` or the mouse wheel
  scrolls the transcript; `Ctrl+L` clears it.
- Approval defaults to **拒绝**; left/right changes the selection and an
  optional host-provided deadline is displayed as a deny-on-timeout countdown.
- `Esc` or `Ctrl+C` cancels a running Host/Core turn. When idle it exits.

When `--bridge` is supplied, submitted prompts, follow-up prompts, approvals,
cancellation and `/new` are all sent to the JS Host and the existing Rust
Agent Core. The no-bridge demo deliberately remains non-destructive.

See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for the retained Grok
Build notice and precise reuse boundary.
