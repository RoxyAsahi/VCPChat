# ADR-007: Codex Thread Store plus SQLite Projection Saga

Status: **implemented**

## Decision

Keep Codex Thread Store authoritative for context and execution, and keep VChat SQLite authoritative for durable presentation. Coordinate mutations with an operation journal and explicit `uncertain` state rather than claiming distributed ACID.

## Consequences

- Session opening remains fast because SQLite can return before `thread/read`.
- Snapshot reconciliation may rebuild Codex-owned Items but cannot manufacture Codex context.
- A remote mutation without a committed local binding is surfaced for recovery.
- Start/fork are never automatically repeated after an ambiguous failure.
- Archive/unarchive/delete may be retried only when their known Thread ID makes the operation idempotent.

