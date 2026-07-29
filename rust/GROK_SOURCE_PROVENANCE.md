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

## Local modifications

- `vcp-grok-compaction/lib.rs`: adds a crate-level allowance for the newer
  Clippy `doc_lazy_continuation` lint. This preserves upstream documentation
  wording while allowing the VCP workspace to use `clippy -D warnings`.
- All imported Rust sources were passed through `cargo fmt`; no execution,
  authentication, storage, local-tool, MCP, or worktree code was imported.
