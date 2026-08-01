# Agent Workbench state ownership

The Workbench uses the Cherry-style separation between persisted conversation
selection and runtime activation. It is a clean-room mechanism reference only:
no Cherry AGPL code, SQLite, Claude SDK, Shell, MCP, or tool schema is used.

```text
Rust Topic Store: durable Topic/history/checkpoint/lease (only source of truth)
Rust daemon:     up to 8 independent Topic Hosts + daemon control plane
Electron Main:   one transport, request waiters, process lifecycle, identities
Renderer:        selectedTopic, activeRuntimes UI projection, cache, DOM state
```

`selectedTopic` decides only what the user sees. `activeRuntimes` is an
ephemeral map of daemon-returned `(sessionId, topicId, agentId)` identities.
The Renderer may display a cached Rust snapshot immediately, then revalidate it
with `read-topic`; it must not start a Host merely because a row was clicked.

Sending to a Topic is the only activation path:

```text
selected Topic has a resident runtime -> start-turn with its exact identity
selected Topic has no runtime          -> ensure-topic-runtime -> read-topic barrier -> start-turn
```

Other Topic Hosts continue running. A selected Topic is disabled only for its
own active Turn or local approval, not because some other Topic is busy. Every
runtime command carries both `sessionId` and `topicId`; no UI/Main code may
fall back to a daemon default Agent or a global attachment. Runtime activation
without an explicit Agent identity is rejected before a daemon command is sent.

Snapshot recovery is fixed: subscribe, start a snapshot barrier, `read-topic`,
apply the Rust snapshot, discard buffered events at/below `snapshotSequence`,
then apply only later events for the selected Topic. Nonselected Topic events
only update a lightweight runtime badge. On refresh, reopen, crash/reconnect,
or takeover, no JS transcript/localStorage/Main memory replay is allowed.

`localStorage` may contain only the final selected `topicId`. It must not hold
messages, turns, tools, approvals, runtime identity, paths, or attachments.
The Activity approval center is global: local approvals display their exact
Topic/Agent identity and four-tuple binding; ToolBox backend approvals display
as unassociated and can only be answered by ToolBox request ID. Closing the
Workbench sends `set-workbench-presence(false)`; Rust fail-closes all pending
approvals. A local approval pauses only its owning selected Topic; it remains
visible while another selected Topic stays send-capable.

**Verified 2026-07-31, revision
`a08bd985cd919d5bcb4b1969194c5ff01d7677947a8923c479efc6ef3fc74519`**:
`npm run test:agent-workbench-store` and `npm run test:agent-workbench` pass
the selected-Topic projection, snapshot barrier, local approval, ToolBox
observation, and Composer contracts. `npm run test:electron-gui-smoke` also
creates two Topic Hosts through the real preload/Main path in one daemon PID.
`VCP_AGENT_LIVE=1 npm run test:rust-stack:live` passed the direct real ToolBox
dual-Topic model/cancellation gate at the same revision. Neither receipt is a
claim of complete visual product acceptance or coverage of every ToolBox
approval/plugin path.
