# ADR-010: Agent code governance boundaries

Status: accepted (working tree)

## Decision

Agent code exposes small stable facades for Workbench composition, Workbench Controller, Codex Runtime Manager, and the Full Fork message renderer. Runtime, Controller, Workbench composition, and Renderer implementation now satisfy their final 600/600/800/600 physical-line ceilings. Business behavior lives in owned services, coordinators, Views, and instance-local Renderer modules.

Renderer lifecycle belongs to an instance scope. Agent code may reuse audited pure content helpers, but must not initialize or dispose main-chat image, visibility, animation, container, or session singletons.

Formal Workbench data access is split into Session, Projection, Interaction, and Workspace clients. Session identity is canonical. The old Topic IPC, preload aliases, compatibility adapter, and Topic-named UI boundaries have been removed; they are not supported extension points.

Long-running Runtime mutations use an immutable `RuntimeOperationContext` that binds the captured lifecycle generation with optional Session, Thread, and Turn identity. Turn, Config, Host, Interaction, ToolBox, and Recovery operations all use this boundary. A service must revalidate the captured generation and external authority after remote `await` before writing SQLite, sending UI events, or using a transport; Repository-backed work reacquires the active Repository before a write. The service graph and Workbench expose Session methods only.

Each Runtime service also freezes its `RuntimeServiceContext` dependency table at construction. Authority-bearing values such as the active Repository, transport, Bridge, settings, and generation remain getter-based, so services observe the current authority without allowing tests or runtime code to replace dependency functions after construction. Session attachment validation belongs to `RuntimeSessionService`; Workbench presence and approval fail-close behavior belongs to `RuntimeInteractionService`. The Manager only validates public arguments and delegates.

Workbench composition receives the preload object once and immediately wraps it in the four formal clients. Views and coordinators receive semantic controller actions only. Renderer attachments receive a narrow host adapter for image viewing, context menus, and external links rather than the full preload surface.

Historical Pi/Rust Agent implementations are available only through Git history and audit documents. Their JavaScript archive, Rust Agent crates, package commands, and workflow have been physically removed. The only product Rust workspace is `rust/toolbox-bridge/`, containing the protocol, VCP transport, and `vcp-toolbox-bridge` crates.

Agent Workbench CSS has one entry, `styles/ui-system/agent-workbench.css`, which imports the fixed owner sequence: shell, sidebar, composer, timeline, session dock, workspace, activity, responsive, and legacy shell adapter. The legacy adapter is the only owner for unlayered compatibility bridges.

Canonical Codex Runtime, Agent Workbench, and Agent presentation JavaScript is linted by `eslint.agent.config.mjs`. The initial cyclomatic-complexity ceiling is 170, matching the current event reducer peak and preventing silent regression; lowering it requires a behavior-preserving reducer split rather than inline disables. Circular dependencies remain an import-graph governance failure.

Runtime shutdown and crash close the current generation first, fail-close approvals, reject waiters, cancel dynamic work and timers, stop transports, and close Projection storage last. External ToolBox interrupt and approval responses are at-most-once even if cleanup is invoked repeatedly.

Workbench selection is represented by a canonical `SelectedSessionIdentity`. `selectedSessionId` is the only selection key; cached Session objects are display snapshots and cannot supply missing identity. Composer, Dock, Workspace, and Sidebar page-local state have separate Session-keyed owners and may not become alternate Runtime or projection truth.

## Consequences

- Public entrypoints stay reviewable and stable while internal services are extracted.
- Runtime and Renderer lifecycle tests can reject stale-generation or cross-root cleanup.
- Final composition and service ceilings are enforced by `check:codex-governance`; they may not be relaxed to accept new feature growth.
- Codex App Server protocol, ToolBox configuration, and main-chat renderer remain unchanged. Projection storage is owned by schema 12; schema 6-11 migrate transactionally to canonical schema-2 Blocks.
- CSS owner files and Runtime/Renderer/Controller facades have enforceable physical-line ceilings; legacy shell selectors outside the dedicated adapter fail governance checks.

## R14 amendment

R14 removes the old Topic IPC/preload surface and Runtime prototype adapter. Product code now exposes only canonical `agent-session:*` CRUD and Session-keyed Runtime operations.

Store events route through runtime, session, message, tool, approval, and activity slice reducers. `agent-store/**` has an enforced cyclomatic complexity ceiling of 29. The broader ceiling remains temporarily at 170 while Settings and projection conversion hotspots are extracted; inline disables are not permitted.

Runtime services receive named frozen capability contexts. A context cannot expose `manager` or `runtime` authority and dependency functions cannot be replaced after construction.

Workbench Views and coordinators use `agent-workbench-host-adapter.js` for VCPUI confirm/edit, account/theme/presentation state, clipboard, Markdown, and the narrow VCP render bridge. Native prompt/confirm and direct host globals outside the adapter fail governance.
