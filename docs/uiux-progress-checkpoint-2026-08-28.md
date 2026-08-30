# UIUX Progress Checkpoint: 2026-08-28

This checkpoint records the current evidence after the Agent Settings and
ModelPicker artifact synchronization. It is intentionally separate from the
ongoing roadmap edits owned by parallel workers.

## Passed Evidence

- `check:uiux:artifacts`: 78 generated files, source/artifact consistency.
- `test:uiux`: 63/63 focused UIUX tests.
- `check-settings-source-equivalence`: canonical Settings shell and extracted
  Settings modules satisfy the source-level ownership and legacy-deletion gate.
- `check:harness-reference`: 93 files / 45 primitive contracts.
- `check:harness-fixture-matrix`: 150 visual cases / 32 interaction cases.
- `check:visual-forensics`: light and dark themes at 800x600, 1280x800, and
  1680x1000.
- Agent Settings production evidence and ModelPicker Electron interaction pass.
- Agent lifecycle stress remains stable at 474 listeners, 312 active resources,
  11 scopes, and zero detached roots/options.
- `guard:chat-kernel-consumers`: frozen chat-kernel boundaries remain clean.

## Explicit Non-Completion

- ModelPicker same-engine pixel policy is still failing; geometry and semantic
  equivalence do not promote it to `verified-candidate` or `stable`.
- The legacy ModelPicker modal still owns hot/favorite/explicit-refresh
  capabilities; it cannot be deleted until feature parity is evidenced.
- Settings remains partially dual-track. Full field-by-field legacy
  presentation retirement is not complete.
- Provenance gaps and source-only candidates remain intentionally visible.

## Scope Guard

No changes in this checkpoint touch StreamCoordinator, StreamProjection,
MessageRenderer, ChatDomRenderer, chat protocol/IPC/persistence, Plugin Loader,
chat manifest, dynamic wallpaper, or frozen chat-content rendering.

