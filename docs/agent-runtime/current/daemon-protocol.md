# daemon v1.2 协议（当前真源）

`vcp-agentd.exe --direct` 是 Workbench 的唯一 Agent Runtime。stdin/stdout 使用四字节大端长度前缀 JSON；没有 TCP 监听。`protocolVersion` 固定为 `1`，`protocolRevision` 固定为 **`1.2`**，单帧上限 256 KiB，模型 delta 上限 8 KiB。

未知版本、未知命令、重复 `requestId`、缺字段、超大帧、断管和 daemon crash 一律 fail closed。协议主版本仍是 v1，因此共享夹具文件名为 [`rust/fixtures/daemon-v1.json`](../../../rust/fixtures/daemon-v1.json)；其 `protocolRevision` 才是 v1.2。

Rust daemon 与 Electron transport 都在边界执行同一套严格校验：命令在写入 stdin 前校验，daemon frame 在进入 Main waiter 或 Renderer 之前校验。`HostEvent::Control` 的 `requestId` 是非可选类型，因而 Rust 内部也不能构造没有 originating request 的 control reply。

## 启动握手

daemon 首帧必须是：

```json
{
  "type": "ready",
  "protocolVersion": 1,
  "protocolRevision": "1.2",
  "buildRevision": "<7-64 位十六进制 revision>"
}
```

Electron transport 必须同时核对三个字段；只收到 `ready` 不代表可用。Host 随后发送 `hello { protocolVersion: 1, requestId }`，daemon 回 `ack { requestId, ok: true }`。`buildRevision` 是构建时对 `rust/` 源树（排除 `target/`）计算的 SHA-256，用来拒绝“GUI 启动了旧 exe”的漂移；它不假装等同于 Git commit，因此未提交的 Rust 修复也能被诚实核验。

## Host → daemon 命令

所有命令都有 `type`、`protocolVersion: 1` 和唯一 `requestId`。带身份的命令还必须包含已有的 `sessionId`；Turn 命令必须同时包含 `turnId`。

| 命令 | 必填 payload | 最终 control kind / 行为 |
| --- | --- | --- |
| `create-session` | 启动参数已通过 argv 传入 | `ack.result = {sessionId, topicId}` |
| `close-session` | `sessionId` | 停止 attachment |
| `start-turn` | `sessionId`, `turnId`, `prompt` | 异步 `event` 流 |
| `cancel-turn` | `sessionId`, 可选 `turnId` | 异步 terminal event |
| `steer-turn` / `follow-up-turn` | `sessionId`, `turnId`, `prompt` | `ack` |
| `approval` | `approvalId`, `allowed`, `sessionId`, `turnId`, `toolCallId`, `argumentsHash` | `ack`；binding 不匹配时 Rust 拒绝 |
| `compact` | `sessionId` | `context.compaction.*` event，ack 不是完成 |
| `list-topics` | — | `topics` |
| `read-topic` | `topicId` | `topic-read-only` |
| `takeover-topic` | `topicId` | `topic-takeover-pending` |
| `rename-topic` / `delete-topic` | `topicId`，rename 另含 `title` | `topic-renamed` / `topic-deleted` |
| `list-interaction-queue` / `clear-interaction-queue` | — | `interaction-queue` |
| `replace-interaction-queue` | `sessionId`, `interactions` | `interaction-queue` |
| `get-settings` / `update-settings` | update 另含 `settings` | `settings` / `settings-updated` |
| `set-workbench-presence` | `mounted: boolean` | `workbench-presence`；false 时拒绝未决本地审批 |
| `shutdown` | — | `ack` 后退出 |

## ACK 与 control-event

`ack` 仅说明命令已被 daemon 接受：

```json
{ "type": "ack", "requestId": "control_…", "ok": true }
```

数据型命令随后产生一个且仅一个关联的最终结果：

```json
{
  "type": "control-event",
  "requestId": "control_…",
  "kind": "topics",
  "payload": []
}
```

`control-error` 也必须带 originating `requestId`。Main 只以 `requestId` 找 waiter，绝不能按 `kind`、抵达顺序或当前 session 猜测归属；kind 不匹配、超时或重复 reply 均拒绝该调用。

`topic-read-only.payload.snapshotSequence` 是读取时已经包含进 Rust durable snapshot 的事件水位。它不是 Renderer 的 event cursor：Renderer 安装 snapshot 后只投影已缓冲且 `sequence > snapshotSequence` 的同 attachment event，绝不把水位以内的旧 delta 回放到 snapshot 上。

## daemon → GUI 业务事件

业务帧形状固定为 `{ "type": "event", "event": { … } }`。嵌套 event 的必填字段为：

```json
{
  "eventId": "session_…:42",
  "sequence": 42,
  "timestamp": 1700000000000,
  "runtime": "rust",
  "sessionId": "session_…",
  "topicId": "topic_…",
  "type": "assistant.delta",
  "payload": { "text": "…" }
}
```

适用时必须另有 `turnId`、`messageId` 或 `toolCallId`。所有 `assistant.*`、`reasoning.*` 流式事件都必须有 `turnId + messageId`；工具事件必须有 `toolCallId`。消息、Turn 或工具关联字段缺失时 Main/Renderer 丢弃事件并仅产生 diagnostic，不能合成 `assistant:${turnId}`、不能以 active Turn 猜测、也不能改名 `tool.running → tool.started`。

Main 只做 frame 限长、握手、requestId waiter、进程生命周期与信封校验；它原样转发 event。Renderer 只以 `eventId` 去重，并把 snapshot 与后续 event 投影为 UI Block。

当 `set-workbench-presence { mounted: false }` 关闭未决本地审批时，daemon 先向 Core 送入失败的 `tool-result`，随后发送最终 `approval.resolved`（`payload.approvalId`、`decision: "deny"`、失败原因）。因此前端不能把“页面已卸载”解释成保留、转交或自动允许审批。

## 夹具与修改规则

每次新增命令、event 字段或名称，必须先更新共享夹具，再更新 Rust 与 JS：

```powershell
node scripts/test-rust-protocol-fixture.mjs
cargo test --manifest-path rust/Cargo.toml -p vcp-agent-protocol
```

未经此双向门禁的协议改动不是 v1.2 的有效实现。
