# daemon v1.7 protocol

`vcp-agentd.exe --direct` is the only GUI Agent Runtime. It uses four-byte
big-endian length-prefixed JSON on stdin/stdout, has no TCP listener, limits a
frame to 256 KiB, and fails closed on malformed frames, duplicate request IDs,
unknown commands, version mismatch, or pipe failure.

`ready` is mandatory and Electron validates all three fields:

```json
{"type":"ready","protocolVersion":1,"protocolRevision":"1.7","buildRevision":"<sha256>"}
```

`buildRevision` identifies the actual Rust source tree used for the executable;
it prevents a GUI smoke test from silently exercising an old daemon.

## Runtime supervisor

The daemon starts lease-free with one control Host. The control Host owns the
single VCPLog/VCPInfo observer and ToolBox backend-approval writer. It does not
own a writable Topic. `TopicRuntimeKey(agentId, topicId)` maps to independent
Host slots. There can be at most eight resident slots. A ninth request can evict
only an idle, approval-free, queue-free least-recently-used slot; otherwise it
returns `runtime-capacity` and leaves every existing Topic untouched.

## Commands

Every command includes `type`, `protocolVersion: 1`, and unique `requestId`.
Control replies retain the exact originating `requestId`; Main never pairs by
event name or arrival order.

| Command | Required identity/payload | Result |
| --- | --- | --- |
| `create-topic` | `agentId`; optional title/model/workspace | `topic-created`; durable empty checkpoint only, no Host/lease |
| `ensure-topic-runtime` | `topicId`, `agentId`; optional model/workspace/permission mode | immediate ACK with `{sessionId,topicId,agentId,...}`; starts or reuses only that Topic Host |
| `detach-topic` | `sessionId`, `topicId` | detaches only if that Host has no Turn/local approval/backend wait/queue |
| `list-active-runtimes` | none | ACK `{runtimes,capacity:8}` |
| `start-turn` | `sessionId`, `topicId`, `turnId`, prompt or descriptors | routes to exactly that Host |
| `cancel-turn`, `compact` | `sessionId`, `topicId` | routes to exactly that Host; compact completes only by event |
| `steer-turn`, `follow-up-turn` | `sessionId`, `topicId`, `turnId`, prompt | routes to exactly that Host |
| `approval` | session/topic/turn/tool IDs plus `argumentsHash` | local approval four-tuple is verified by Rust |
| interaction queue and attachment import | `sessionId`, `topicId` plus command payload | routes to exactly that Host |
| Topic/list/search/read/settings/presence | control-plane payload | final `control-event` with the request ID |
| `toolbox-approval` | ToolBox `approvalRequestId`, boolean decision | control Host only; never invents a Topic association |

Cross-Topic, expired, missing, or stale identity is `attachment-mismatch` or a
stable command error. There is no `switch-attachment`, `create-session`, or
`close-session` protocol fallback in v1.7.

## Events

Every daemon business event is `{type:"event",event:{...}}` and has
`eventId`, daemon-wide `sequence`, `timestamp`, `runtime:"rust"`, `sessionId`,
`topicId`, and `type`. Where applicable it also has `turnId`, `messageId`, and
`toolCallId`. Rust emits final names directly; Electron does not rename tool
events, infer missing IDs, or synthesize message IDs.

`runtime.*` and `toolbox.ws` are daemon-global observations. ToolBox backend
approvals remain global because upstream provides no reliable Topic correlation;
the Renderer shows them in the global approval center. Local approvals retain
their Topic/Turn/Tool binding.

Shared fixture rule: modify `rust/fixtures/daemon-v1.json` first, then Rust and
JS, then run `node scripts/test-rust-protocol-fixture.mjs`.

**Verified 2026-07-31, hermetic, revision
`a08bd985cd919d5bcb4b1969194c5ff01d7677947a8923c479efc6ef3fc74519`**:
fixture, runtime-manager, direct concurrent smoke, and Topic takeover commands
above passed. The opt-in real ToolBox concurrent receipt uses
`VCP_AGENT_LIVE=1 npm run test:rust-stack:live` at the same revision: it
verified two concurrent Nova model turns, cancellation of A without replay,
and independent completion of B in one daemon PID.
