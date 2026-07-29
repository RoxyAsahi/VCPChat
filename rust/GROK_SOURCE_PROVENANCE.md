# Grok Build source provenance

The following leaf crates were mechanically imported from the local
`C:\VCP\vchat-develop\grok-build` checkout at source revision `47348d1` on
2026-07-27. They remain Apache-2.0 and are compiled independently; VCPAgent
does not import `xai-grok-shell`, local tools, MCP, worktree, authentication,
or persistence crates.

| VCP crate | Original Grok path | Intended use |
| --- | --- | --- |
| `vcp-grok-compaction` | `crates/common/xai-grok-compaction` | safe tool-pair tail selection, token and sampler seams |
| `vcp-grok-interjection` | `crates/common/xai-interjection-core` | mid-turn steering/interjection buffer |
| `vcp-grok-prompt-queue` | `crates/codegen/xai-prompt-queue` | queue version and serialization primitives |

The upstream Apache-2.0 text is retained as `third_party_grok_build_LICENSE`.
Any local modifications must be documented in this file and preserve upstream
copyright and notice requirements.

## Audited imports and conditional reuse

The current delivery plan audits the newer local Grok Build revision `02d9359`.
The following items were audited against that revision. Imported and extracted
rows are now part of this source tree; the inline renderer remains conditional:

| Upstream source | Planned reuse | Status |
| --- | --- | --- |
| `crates/codegen/xai-crash-handler` | controlled leaf import for abnormal terminal restoration | imported; see below |
| `crates/codegen/xai-grok-markdown-core` and `xai-grok-markdown` | controlled imports for incremental terminal Markdown rendering | imported; see below |
| `xai-grok-pager-render/src/clipboard` | extract only environment-independent clipboard route/trust logic | extracted; see below |
| `xai-grok-pager-pty-harness` | extract generic PTY runner/test concepts, not Grok scenarios | extracted into test-only crate; see below |
| `crates/codegen/xai-ratatui-inline` | import only if a VCP minimal-mode PTY regression first demonstrates the need | rejected for now: PTY baseline passes |
| `crates/codegen/xai-token-estimation` | controlled leaf import as `vcp-grok-token-estimation`; replace duplicate VCP estimates and label all projected values as estimated | imported; see below |

Before any row becomes imported, record its exact source revision, original
path, import date, copied files, local modifications, license/NOTICE changes,
upstream tests, VCP adapter tests, and Windows release-build result here.

## Imports from revision `02d9359`

Imported on 2026-07-29 from the local Grok Build checkout:

| VCP crate | Original Grok path | Copied scope | Verification |
| --- | --- | --- | --- |
| `vcp-grok-crash-handler` | `crates/codegen/xai-crash-handler` | terminal restore sequence and minimal Unix signal / Windows unhandled-exception restore path | upstream restore-sequence test retained; VCP TUI workspace tests, Clippy and Windows release build pass |
| `vcp-grok-token-estimation` | `crates/codegen/xai-token-estimation` | bytes/4 estimate, percentage, free-token and threshold/headroom primitives | focused upstream-derived tests retained; Core provider/estimated/mixed tests and full workspace tests pass |
| `vcp-grok-markdown-core` | `crates/codegen/xai-grok-markdown-core` | complete `src/` library surface; playground, benches and fuzz targets excluded | 45 upstream tests pass |
| `vcp-grok-markdown` | `crates/codegen/xai-grok-markdown` | `src/` plus `assets/tokyo-night.tmTheme`; bin/playground entry points excluded | 472 upstream tests and VCP streaming/full CJK-table-code-link parity pass |

The Markdown adapter is `rust-tui/crates/vcp-agent-tui/src/markdown.rs`.
It consumes message text and emits ratatui lines only. Session, Topic, tool and
approval state remain outside the imported crates, and VCP themes are injected
by the adapter. The current Windows release binary grows from the 6,380,032
byte pre-Markdown baseline to 9,542,656 bytes (3,162,624 bytes) after the
structured control-plane and scrollable tool-detail additions.
`npm run build:tui` enforces an 18,962,944-byte gate.

The clipboard work is a minimal semantic extraction into
`rust-tui/crates/vcp-agent-tui/src/clipboard.rs`: native clipboard, tmux
buffer/passthrough, OSC52 fallback, and `Confirmed/Unverified/Failed` delivery
evidence. Grok environment names, telemetry, host/config dependencies and the
rest of pager-render were not copied. The provider is attached only to the
textarea, so transcript and sensitive ToolBox results are never auto-copied.

The PTY work is a test-only Apache-2.0 crate at
`rust-tui/crates/vcp-agent-pty-harness`. It extracts portable-pty lifecycle,
resize/drain, terminal query replies, screen parsing and OSC52 decoding
concepts. It does not import `ptyctl`, Alacritty, Grok mock inference,
sandbox, Agent fixtures or pager scenarios. VCP scenarios launch the real
`vcp-agent.exe` and inject only VCP UI events over the existing named-pipe
bridge. Current hermetic tests cover long CJK streaming, resize storms, real
ConPTY prompt submission, local approval default-deny, active-turn cancellation,
interrupted-checkpoint recovery projection, minimal mode, forced debug panic
cleanup, long tool-result inspection and repeated Session projection switches.
An opt-in live test drives real keyboard input through `vcp-agent.exe`, Rust
Host/Core and ToolBox `FileOperator`, and verifies the requested package result.
The minimal-mode fixture passed without duplicate sentinel, alternate-screen
pollution or resize loss, so `xai-ratatui-inline` was not imported.

Local crash-handler changes deliberately omit Grok crash blobs, backtraces,
upload, telemetry, version storage and product crash directories. VCP adds a
panic-hook adapter and an RAII terminal session around the imported abnormal
restore path.

Local token-estimation changes omit the unused image estimate and rounded-u8
helper. VCP adds conservative multilingual message headroom on top of the
single bytes/4 primitive so automatic compaction does not regress for Chinese
sessions. Projected usage now carries `provider`, `estimated`, or `mixed`
source metadata; estimated values are never described as billing usage.

## Local modifications

- `vcp-grok-compaction/lib.rs`: adds a crate-level allowance for the newer
  Clippy `doc_lazy_continuation` lint. This preserves upstream documentation
  wording while allowing the VCP workspace to use `clippy -D warnings`.
- `xai-ratatui-textarea/lib.rs`: allows Rust 1.93's
  `single_range_in_vec_init` lint because it only flags two retained upstream
  tests whose one-range collection semantics are intentional.
- All imported Rust sources were passed through `cargo fmt`; no execution,
  authentication, storage, local-tool, MCP, or worktree code was imported.
