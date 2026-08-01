# Rust Agent delivery plan

Completion is evidence-based: an older pass never proves the current revision.
All verification entries name date, mode, command, and Rust build revision.

| Goal | Status | Current evidence / remaining gate |
| --- | --- | --- |
| R0 documentation truth | complete | Current documents describe Rust daemon only; Pi/Driver/Agent SQLite/submodule routes are historical only. |
| R1 protocol ownership | complete | v1.7 shared fixture and strict JS/Rust validation pass. |
| R2 durable state boundary | complete | Rust Topics are durable truth; Main has no transcript/tool/usage/approval store; Renderer is temporary projection. |
| R3-D presentation | hermetic verified | Timeline/store/Workbench tests passed previously in this working tree; real ToolBox visual review remains separate. |
| R3-M multi-Topic supervisor | complete for the defined scope | Direct v1.7 concurrent smoke, takeover, Electron two-Host/PID smoke, Rust workspace quality gates, and the opt-in ToolBox dual-Topic cancellation gate passed at the revision below. |

## R3-M validation scope

The v1.7 live receipt is `VCP_AGENT_LIVE=1 npm run test:rust-stack:live` (or
the equivalent narrower `test:rust-agent-concurrent-live`). It invokes only the
v1.7 concurrent script: two independent Nova Topics issue model requests in
one daemon PID, A streams then is cancelled without replay, and B independently
returns a random sentinel. It uses temporary Topics/settings and does not alter
ToolBox approval configuration.

The supervisor's local-approval four-tuple, global ToolBox approval replay/TTL,
and cross-Topic identity routing remain hermetically covered by the Rust Host,
protocol, daemon smoke, and Electron suites. They are not a claim that every
ToolBox plugin or approval policy has received live product acceptance.

## Current receipt

2026-07-31, hermetic, build revision
`a08bd985cd919d5bcb4b1969194c5ff01d7677947a8923c479efc6ef3fc74519`:

```powershell
node scripts/test-rust-protocol-fixture.mjs
npm run test:rust-agent-runtime
npm run test:agent-workbench-store
npm run test:agent-workbench
npm run test:agent-workbench-timeline
npm run build:daemon
npm run test:rust-daemon-smoke
npm run test:rust-topic-takeover
npm run test:electron-gui-smoke
npm run test:electron-topic-takeover
npm run check:ui-system
npm run check:rust-agent-runtime
cargo fmt --manifest-path rust/Cargo.toml --all --check
cargo clippy --manifest-path rust/Cargo.toml --workspace --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml --workspace
```

All commands above passed. Electron smoke creates two independent Topic Hosts
through the real preload/Main path in one PID. They do not establish product
readiness beyond their stated hermetic scope.

## Live receipt

2026-07-31, opt-in real ToolBox, build revision
`a08bd985cd919d5bcb4b1969194c5ff01d7677947a8923c479efc6ef3fc74519`:

```powershell
$env:VCP_AGENT_LIVE = '1'
npm run test:rust-stack:live
```

Passed. `test-live-rust-concurrent-topics.mjs` created two temporary Nova
Topics, observed an A stream delta, cancelled A with `replay: false`, and
verified B completed its own random sentinel in the same daemon process.
This proves the R3-M concurrent model/cancellation path, not general product
readiness or untested live approval/plugin behavior.
