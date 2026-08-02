# Codex Agent Risk Register

Status: **implemented**

| ID | Severity | Risk | Control | Verification |
| --- | --- | --- | --- | --- |
| AG-R01 | P0 | Selected Session is confused with a writable runtime | `selectedSessionId` and identity-keyed `activeRuntimes` are separate | Workbench store and Electron multi-Session tests |
| AG-R02 | P1 | Old approval request ID suppresses a new runtime request | Source + generation registry key, TTL, capacity and crash cleanup | `test:codex-interaction-registry` |
| AG-R03 | P1 | Follow-up is accepted remotely but replayed after Main crash | Stable client message ID and persistent dispatch state | `test:codex-reliability` fault injection |
| AG-R04 | P1 | Stale Thread snapshot overwrites live event | Projection mutation generation barrier | Projection store and runtime tests |
| AG-R05 | P1 | Codex mutation succeeds but SQLite write fails | Saga operation journal and `uncertain` recovery state | Projection migration/recovery tests |
| AG-R06 | P1 | Invalid ToolBox config blocks history | Projection-only IPC does not refresh ToolBox | IPC contract test |
| AG-R07 | P1 | Concurrent ToolBox reload applies stale credentials | Latest-wins generation drain | Runtime manager test |
| AG-R08 | P2 | SQLite corruption makes all Agent history unavailable | startup checks, migration backup, read-only degraded fallback | Projection degraded-mode test |
| AG-R09 | P2 | Timed-out workspace traversal continues in Main | bounded schedulers, AbortController and cancellation IPC | Workspace service test |
| AG-R10 | P2 | Agent renderer drifts from main-chat security behavior | shared malicious-content corpus and independent ownership | Agent presentation security/golden tests |
| AG-R11 | P1 | An uncertain start/fork is rebound to the wrong Thread | fixed-schema `thread/list`, exclude bound Threads, explicit user bind/delete only | Runtime manager and recovery UI tests |
| AG-R12 | P1 | Opening history unnecessarily depends on App Server or ToolBox | projection-only IPC and no eager Workbench startup | Workbench and Electron recovery smoke |

No item may be marked `product` while a P0/P1 entry lacks a same-commit hermetic or live receipt.
