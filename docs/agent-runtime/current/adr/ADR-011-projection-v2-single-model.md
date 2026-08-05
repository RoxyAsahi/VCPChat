# ADR-011: Projection V2 Single Model

Status: accepted and implemented; current-worktree live gate passed, same-commit receipt pending.

## Context

The Agent Workbench previously combined SQLite snapshots, live `projectionMessage` entries, selected-Session
`messages/tools`, and Session-switch caches. Those paths had different identity and freshness rules, so switching away from a
streaming Session could discard reasoning or tool cards even though Main had already persisted them.

Codex App Server 0.146 also has ordering and snapshot constraints that must be represented explicitly: idle status may precede
Turn completion, partial `itemsView` is not deletion-authoritative, and reasoning summary/content indexes are separate spaces.

## Decision

1. Main writes every projection mutation to SQLite before notifying Renderer.
2. Main emits only `AgentProjectionPatch`; Renderer no longer consumes `projectionMessage`.
3. Patch identity is `sessionId + threadId + baseProjectionRevision + projectionRevision`. A mismatch causes a full SQLite read.
4. Cross-Session Renderer truth is `sessionsById + blocksById + projectionRevisions`. The current `messages/tools` shape is a
   derived compatibility view for existing presentation coordinators, never a recovery cache or background Session owner.
5. V2 Block identity is Session-scoped. Known Items are normalized; Unknown Items are bounded and non-executable.
6. Reconcile deletes Codex-owned Items only for a matching Thread with full Turn item views. Local authority is preserved.

## Consequences

- Streaming, cold-open, reload, reconcile, and Session switching use one reducer and one durable source.
- Revision gaps are observable and recoverable instead of silently merging incompatible snapshots.
- SQLite database schema is 12; Block content and Renderer contracts are V2. Schema 12 canonicalizes legacy Block identity/content and retains a pre-migration backup.
- Tool cards are first-class Timeline entries, not a Turn-level collection. A live card is shown between the assistant Items that surround its tool event; Session switching and cold reopen must reproduce that same position. Only adjacent cards from the same Turn may be visually folded into one batch. Main owns legacy order repair; Renderer does not infer a second order or move a Turn's cards to its beginning/end.
- A later removal of the derived `messages/tools` view is a presentation API migration, not another data-model migration.
- Projection hydration, snapshot barriers and stale Session-switch guards are isolated in `agent-projection-hydration-coordinator.js`; the Workbench Controller owns only Runtime event and command composition.
- The current worktree has hermetic, Electron, real App Server and ToolBox evidence. A committed same-revision receipt remains required before this revision can be called live; product completion remains broader still.
