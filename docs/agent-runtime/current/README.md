# Rust Agent Runtime: current source of truth

Last updated: 2026-07-31. Active branch: `codex/vcpchat-rust-agent-origin-sync`.

The supported GUI path is a black-box runtime integration:

```text
Agent Workbench Renderer -> preload allowlist -> Electron Main transport
  -> vcp-agentd --direct -> Rust Host/Core -> VCPToolBox
```

`vcp-agentd` protocol revision **1.7** is one control process supervising up to
eight independent Topic Hosts. A Topic has at most one writer lease and one
active Turn; different Topics can run concurrently. `selectedTopic` is only a
Renderer view. It does not select, stop, or otherwise replace another runtime.

Rust Topic data in `AppData/AgentRuntimeData` is the sole durable Agent source.
Renderer keeps an ephemeral snapshot cache and local UI projection only;
Electron Main only owns process supervision, framed transport, request waiters,
and short-lived runtime identities. VCPToolBox remains the authority for
models, dynamic prompts, plugins, tools, markers, and backend approvals.

Current documents:

1. [daemon-protocol.md](daemon-protocol.md): v1.7 framed command/event contract.
2. [topic-and-recovery.md](topic-and-recovery.md): durable Topic, lease, recovery, and continuation rules.
3. [agent-workbench-state.md](agent-workbench-state.md): Renderer/Main/Rust state ownership.
4. [delivery-plan.md](delivery-plan.md): current gates and non-completed work.

Pi, Driver API, `vcp_delegate`, Agent SQLite/submodule routes, and historical
single-attachment behavior are not current product paths. They only belong in
`docs/agent-runtime/history/` and may not be used as implementation authority.

**Current hermetic evidence, not product completion**: 2026-07-31, Rust build
revision `a08bd985cd919d5bcb4b1969194c5ff01d7677947a8923c479efc6ef3fc74519`.
`node scripts/test-rust-protocol-fixture.mjs`, `npm run test:rust-agent-runtime`,
`npm run test:agent-workbench-store`, `npm run test:agent-workbench`,
`npm run test:agent-workbench-timeline`, `npm run build:daemon`,
`npm run test:rust-daemon-smoke`, `npm run test:rust-topic-takeover`,
`npm run test:electron-gui-smoke`, `cargo test --manifest-path rust/Cargo.toml --workspace`,
and `cargo clippy --manifest-path rust/Cargo.toml --workspace --all-targets -- -D warnings`
passed. The matching opt-in live receipt,
`VCP_AGENT_LIVE=1 npm run test:rust-stack:live`, passed two concurrent Nova
Topics where A was cancelled without replay and B independently completed.
These receipts do not mark the broader Agent product as complete.
