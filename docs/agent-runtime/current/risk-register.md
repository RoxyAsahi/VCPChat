# Codex Agent Risk Register

Status: **live** for R7-R10 controls; **not product complete**

| ID | Severity | Risk | Control | Verification |
| --- | --- | --- | --- | --- |
| AG-R01 | P0 | Selected Session is confused with a writable runtime | `selectedSessionId` and identity-keyed `activeRuntimes` are separate | Workbench store and Electron multi-Session tests |
| AG-R02 | P1 | Old approval request ID suppresses a new runtime request or pending approvals exceed memory bounds | Source + generation registry key, TTL, hard capacity rejection and crash cleanup | `test:codex-interaction-registry` |
| AG-R03 | P1 | Follow-up is accepted remotely but replayed after Main crash | Stable client message ID, persistent dispatch state, pre-RPC/ACK fault injection and explicit Session-scoped resend/discard decision | `test:codex-reliability` and Workbench queue test |
| AG-R04 | P1 | Stale Thread snapshot overwrites live event | Projection mutation generation barrier | Projection store and runtime tests |
| AG-R05 | P1 | Codex mutation succeeds but SQLite write fails | Saga operation journal; known-Thread lifecycle operations resume idempotently; acknowledged start/fork retain their Thread ID for explicit binding and never auto-replay | Runtime ACK fault injection and Electron lifecycle recovery |
| AG-R06 | P1 | Invalid ToolBox config blocks history | Projection-only IPC does not refresh ToolBox | IPC contract test |
| AG-R07 | P1 | Concurrent ToolBox reload applies stale credentials | Latest-wins generation drain | Runtime manager test |
| AG-R08 | P2 | SQLite corruption or write failure makes all Agent history unavailable or still permits remote mutation | quick/foreign-key checks, migration backup, handle cleanup, read-only degraded fallback, and pre-transport mutation guards | Projection startup, Runtime no-transport assertions, and Electron degraded-mode test |
| AG-R09 | P2 | Timed-out workspace traversal continues in Main | bounded schedulers, AbortController and cancellation IPC | Workspace service test |
| AG-R10 | P2 | Agent renderer drifts from main-chat security behavior | shared malicious-content corpus and independent ownership | Agent presentation security/golden tests |
| AG-R11 | P1 | An uncertain or acknowledged start/fork is replayed or rebound to the wrong Thread | generation-start normalization, fixed-schema `thread/list`, exclude bound Threads, recorded Thread mismatch rejection, explicit user bind/delete only | Runtime manager fault injection and recovery UI tests |
| AG-R13 | P1 | Authoritative Codex reconcile deletes VChat/ToolBox-only observations | Message authority summary preserves local Blocks and removes only stale Codex Blocks from mixed Messages | Projection authority reconcile tests |
| AG-R12 | P1 | Opening history unnecessarily depends on App Server or ToolBox | projection-only IPC and no eager Workbench startup | Workbench and Electron recovery smoke |
| AG-R14 | P1 | Main registers an undefined or stale Agent IPC channel and blocks Electron startup behind an error dialog | single central Agent channel registry plus static Handler-reference validation | `check:agent-runtime` and Electron recovery/smoke |
| AG-R15 | P2 | Hermetic Electron tests share Chromium storage locks or unrelated CDS startup with a live VChat process | per-run `userData`, temporary AppData, CDS disabled in Codex E2E, bounded debugger/IPC waits | `test:electron-codex-recovery` and `test:electron-codex-smoke` |
| AG-R16 | P1 | Profile edits silently rewrite an existing Thread identity | frozen Session snapshot, CAS, identity-field diff and explicit derived Session | Runtime manager and Workbench settings tests |
| AG-R17 | P1 | Draft, attachment or steer/follow-up mode crosses Session identity | Renderer-only `composerStateBySession` keyed by durable Session ID; lifecycle cleanup | `test:agent-composer-state` and Workbench DOM test |
| AG-R18 | P1 | UI advertises unsupported reasoning effort or silently drops a rejected value | only explicit model metadata enables options; Main validates again; ToolBox rejection propagates | Runtime, settings UX and Responses adapter tests; live provider pending |
| AG-R19 | P1 | Renderer or unknown local request injects Codex-managed instructions | process-local loopback capability, Thread/Session lookup, 64 KiB limit and unknown identity rejection | Responses adapter and Runtime manager tests |

No item may be marked `product` while a P0/P1 entry lacks a same-commit hermetic or live receipt.

| AG-R20 | P1 | Old Sidebar or Main Session object overwrites a newer setting/apply confirmation | field-keyed Draft state; CAS; desired/applied revisions; Runtime state updates re-read durable Session | `test:agent-settings-interaction`, `test:agent-config-apply` |
| AG-R21 | P1 | Renderer attachment leaks an absolute path or is reused across Sessions | Main-only bounded AttachmentRegistry, capability descriptor, TTL and pre-send stat validation | `test:agent-data-contracts` |
| AG-R22 | P1 | Global unbounded event dedupe drops another Session event or leaks memory | Session bucket + sequence watermark + bounded eventId LRU | `test:agent-data-contracts`, Workbench store |
| AG-R23 | P1 | A future Agent module bypasses the facade and reintroduces main-chat mutable renderer ownership | Static singleton import checks, instance lifecycle scope, facade size ceilings | `check:codex-governance`, renderer isolation/lifecycle tests |
| AG-R24 | P2 | Retired Pi/Rust Agent/Grok/TUI routes are mistaken for supported product code | Physical deletion, product import/package/workflow scan, Git history as the only source recovery path | `check:agent-runtime`, `check:codex-governance` |
| AG-R25 | P1 | Runtime stop/crash closes SQLite or transport while approvals and old waiters can still complete | generation-first six-step shutdown; approvals before waiters; process stop before Repository close | `test:codex-runtime-lifecycle`, `test:electron-codex-recovery` |
| AG-R26 | P1 | Repeated stop/crash cleanup writes ToolBox interrupt or approval response more than once | dynamic-call map drain, interaction registry completion, duplicate cleanup test | `test:codex-runtime-toolbox-service`, Electron recovery |
| AG-R27 | P2 | Agent CSS ownership split changes cascade or grows another monolith | fixed nine-file import order, AST parse, rule/declaration parity, expanded-CSS Workbench assertions | `check:codex-governance`, `check:ui-system`, `test:agent-workbench` |
| AG-R28 | P1 | A cached Topic or Session display object routes an action to a different selected Session | canonical `SelectedSessionIdentity`; `selectedSessionId` is the sole key; incomplete or conflicting identity fails closed | `check:codex-governance`, Workbench Store/client tests |
| AG-R29 | P1 | An old-generation ToolBox, Interaction, Host, Config or Recovery completion writes through a new Runtime authority | immutable operation context, generation validation after remote awaits, captured Bridge/Transport authority and replacement-safe map cleanup | Runtime lifecycle/service tests and Electron recovery |
| AG-R30 | P1 | Runtime tests or late code replace a service dependency function and bypass current generation, Repository or transport authority | frozen RuntimeServiceContext dependency tables with getter-based live authority; Manager business-behavior governance checks | Runtime service tests and `check:codex-governance` |
| AG-R31 | P2 | Canonical Agent JavaScript accumulates syntax hazards or silently regrows a giant event reducer | ESLint correctness rules, Store complexity ceiling 29, temporary broader ceiling 170, mandatory `lint:agent` in `test:codex-ci`, import-graph cycle check | `npm run lint:agent`, `check:codex-governance`, `test:codex-ci` |
| AG-R32 | P1 | A Workbench View bypasses VCPUI and silently falls back to native prompt/confirm or mutable host globals | explicit Host Adapter plus canonical source scan; unavailable capabilities fail visibly | `test:agent-workbench-host-adapter`, `test:agent-workbench`, `check:codex-governance` |
| AG-R33 | P1 | Removed Topic compatibility is accidentally re-exposed by IPC/preload or Runtime prototypes | canonical `agent-session:*` contract and zero legacy symbol governance | `check:agent-runtime`, `check:codex-governance`, Electron smoke/recovery |
