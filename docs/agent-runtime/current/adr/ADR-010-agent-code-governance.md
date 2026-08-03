# ADR-010: Agent code governance boundaries

Status: accepted (working tree)

## Decision

Agent code exposes small stable facades for Workbench composition, Workbench Controller, Codex Runtime Manager, and the Full Fork message renderer. Stateful implementations remain private and are checked independently until further extraction reduces them below the final module ceilings.

Renderer lifecycle belongs to an instance scope. Agent code may reuse audited pure content helpers, but must not initialize or dispose main-chat image, visibility, animation, container, or session singletons.

Formal Workbench data access is split into Session, Projection, Interaction, and Workspace clients. Session identity is canonical; old Topic IPC is isolated in `modules/ipc/agentSessionCompatibility.js`, warns once, rejects conflicting identity, and is scheduled for removal at the next Agent protocol revision.

Historical Pi/Rust JavaScript runtimes live under `archive/agent-runtime/`. Product code and packaging may not import or include that directory. The Rust workspace remains because it still builds `vcp-toolbox-bridge`.

## Consequences

- Public entrypoints stay reviewable and stable while internal services are extracted.
- Runtime and Renderer lifecycle tests can reject stale-generation or cross-root cleanup.
- The temporary implementation ceilings are debt limits, not completion claims. They must only move downward.
- SQLite schema, Codex App Server protocol, ToolBox configuration, and main-chat renderer remain unchanged.
