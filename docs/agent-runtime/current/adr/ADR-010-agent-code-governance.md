# ADR-010: Agent code governance boundaries

Status: accepted (working tree)

## Decision

Agent code exposes small stable facades for Workbench composition, Workbench Controller, Codex Runtime Manager, and the Full Fork message renderer. Runtime, Controller, Workbench composition, and Renderer implementation now satisfy their final 600/600/800/600 physical-line ceilings. Business behavior lives in owned services, coordinators, Views, and instance-local Renderer modules.

Renderer lifecycle belongs to an instance scope. Agent code may reuse audited pure content helpers, but must not initialize or dispose main-chat image, visibility, animation, container, or session singletons.

Formal Workbench data access is split into Session, Projection, Interaction, and Workspace clients. Session identity is canonical; old Topic IPC is isolated in `modules/ipc/agentSessionCompatibility.js`, warns once, rejects conflicting identity, and is scheduled for removal at the next Agent protocol revision.

Historical Pi/Rust JavaScript runtimes live under `archive/agent-runtime/`. Product code and packaging may not import or include that directory. The Rust workspace remains because it still builds `vcp-toolbox-bridge`.

Agent Workbench CSS has one entry, `styles/ui-system/agent-workbench.css`, which imports the fixed owner sequence: shell, sidebar, composer, timeline, session dock, workspace, activity, responsive, and legacy shell adapter. The legacy adapter is the only owner for unlayered compatibility bridges.

Runtime shutdown and crash close the current generation first, fail-close approvals, reject waiters, cancel dynamic work and timers, stop transports, and close Projection storage last. External ToolBox interrupt and approval responses are at-most-once even if cleanup is invoked repeatedly.

## Consequences

- Public entrypoints stay reviewable and stable while internal services are extracted.
- Runtime and Renderer lifecycle tests can reject stale-generation or cross-root cleanup.
- Final composition and service ceilings are enforced by `check:codex-governance`; they may not be relaxed to accept new feature growth.
- SQLite schema, Codex App Server protocol, ToolBox configuration, and main-chat renderer remain unchanged.
