# ADR-010: Agent code governance boundaries

Status: accepted (working tree)

## Decision

Agent code exposes small stable facades for Workbench composition, Workbench Controller, Codex Runtime Manager, and the Full Fork message renderer. Runtime, Controller, Workbench composition, and Renderer implementation now satisfy their final 600/600/800/600 physical-line ceilings. Business behavior lives in owned services, coordinators, Views, and instance-local Renderer modules.

Renderer lifecycle belongs to an instance scope. Agent code may reuse audited pure content helpers, but must not initialize or dispose main-chat image, visibility, animation, container, or session singletons.

Formal Workbench data access is split into Session, Projection, Interaction, and Workspace clients. Session identity is canonical; old Topic IPC is isolated in `modules/ipc/agentSessionCompatibility.js`, warns once, rejects conflicting identity, and is scheduled for removal at the next Agent protocol revision.

Long-running Runtime mutations use an immutable `RuntimeOperationContext` that binds the captured lifecycle generation with optional Session, Thread, and Turn identity. A service must revalidate this context and reacquire the active Repository after each remote `await` before writing. Deprecated Manager Topic method names are installed only by `runtime-topic-compatibility.js`; the service graph and Workbench use Session methods.

Workbench composition receives the preload object once and immediately wraps it in the four formal clients. Views and coordinators receive semantic controller actions only. Renderer attachments receive a narrow host adapter for image viewing, context menus, and external links rather than the full preload surface.

Historical Pi/Rust JavaScript runtimes live under `archive/agent-runtime/`. Product code and packaging may not import or include that directory. The Rust workspace remains because it still builds `vcp-toolbox-bridge`.

Agent Workbench CSS has one entry, `styles/ui-system/agent-workbench.css`, which imports the fixed owner sequence: shell, sidebar, composer, timeline, session dock, workspace, activity, responsive, and legacy shell adapter. The legacy adapter is the only owner for unlayered compatibility bridges.

Runtime shutdown and crash close the current generation first, fail-close approvals, reject waiters, cancel dynamic work and timers, stop transports, and close Projection storage last. External ToolBox interrupt and approval responses are at-most-once even if cleanup is invoked repeatedly.

## Consequences

- Public entrypoints stay reviewable and stable while internal services are extracted.
- Runtime and Renderer lifecycle tests can reject stale-generation or cross-root cleanup.
- Final composition and service ceilings are enforced by `check:codex-governance`; they may not be relaxed to accept new feature growth.
- SQLite schema, Codex App Server protocol, ToolBox configuration, and main-chat renderer remain unchanged.
- CSS owner files and Runtime/Renderer/Controller facades have enforceable physical-line ceilings; legacy shell selectors outside the dedicated adapter fail governance checks.
