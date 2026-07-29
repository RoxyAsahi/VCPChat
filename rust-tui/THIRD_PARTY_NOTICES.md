# Rust TUI third-party notices

## Grok Build: `xai-ratatui-textarea`

This worktree vendors a deliberately narrow UI primitive from the local Grok
Build checkout, not Grok's pager, shell, agent, tool, MCP, authentication, or
workspace subsystems.

- Source: `C:\VCP\vchat-develop\grok-build\crates\codegen\xai-ratatui-textarea`
- Source revision: local `grok-build` checkout at the time this branch was created
- Included files: `third_party/xai-ratatui-textarea/src/**` and its `NOTICE`
- License: Apache License 2.0
- Copyright: 2023-2026 xAI

The upstream `NOTICE` is retained verbatim alongside the copied source. VCP
specific code lives only under `crates/vcp-agent-tui`; no copied Grok source is
relabelled as VCP-owned code.
