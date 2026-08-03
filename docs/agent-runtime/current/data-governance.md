# R12 Agent 数据治理

状态：**implemented / working-tree**（2026-08-03）。本状态不继承 R7-R10 的 `live` 收据；只有同一提交的 R12 hermetic、Electron 和真实设置交互门槛通过后才能升级。

## 权威数据

| 数据 | 权威 | 规则 |
| --- | --- | --- |
| Agent 默认 | `CodexAgents/<profileId>/config.json` | `AgentProfileV2`、原子替换、`expectedProfileRevision` CAS |
| Session 期望配置 | Projection SQLite `config_snapshot_json` | `SessionConfigV2`、`configRevision` CAS |
| Runtime 已应用配置 | Projection SQLite `applied_config_snapshot_json` | 仅由 App Server resume/settings confirmation/Turn ACK 推进 |
| Codex 上下文与执行 | Codex Thread Store | VChat 不读取 rollout、不伪造执行结果 |
| Composer 与 Dock 临时状态 | Renderer 内存 | 不写 transcript、SQLite 或 localStorage |
| 附件绝对路径 | Main `AttachmentRegistry` | Renderer 只持有 capability descriptor，发送前重新验证 |

`desiredConfig` 表示用户已保存的下一轮目标，`appliedRuntimeConfig` 表示 Runtime 最后确认的配置。两者 revision 不一致时 UI 必须显示 pending/applying/error，Responses Adapter 只能读取 applied 配置。

## 设置与 Runtime

- 每个 `profileId/sessionId + field` 独立维护 `dirty/saving/saved/pending-runtime/applying/conflict/error`。旧 Sidebar Snapshot 不得覆盖 Draft。
- 新 Session IPC 只接受 Agent identity 和标题，Main 从 Profile 权威副本构造完整 Session config。Profile 变更不传播到旧 Session。
- model、cwd、approvalPolicy、effort、personality 使用固定 Codex 0.146 experimental `thread/settings/update`；确认后从下一 Turn 生效。
- 每次发送前运行 config barrier；应用失败时不发送 Turn。
- VChat 身份指令在空闲 Thread 上 `thread/unsubscribe -> thread/resume`，运行中保持 pending。切换到 Codex 管理模式经确认创建派生 Session。
- YOLO 只映射 Codex `approvalPolicy=never`，不影响 ToolBox backend approval。

## 数据边界

- Profile/Session/Block JSON 必须带 schema version；未来版本 fail-closed。
- 配置 JSON 拒绝绝对路径、buffer/base64、transcript 等敏感字段。
- Renderer 附件格式固定为 `{ attachmentId, displayName, kind, byteLen }`；绝对路径仅在 Main 内存 Registry。
- Event 去重按 Session sequence watermark 与 512 项 eventId LRU；不同 Session 的同名 eventId 不冲突。
- Runtime generation、config revision 和 config apply generation 是独立身份，旧确认不得提交到新 generation。

## 当前门槛

```text
npm run test:agent-settings-interaction
npm run test:agent-config-apply
npm run test:agent-data-contracts
```

2026-08-03 已形成真实 Electron 收据：设置 UI 的 YOLO/cwd 不回跳并持久化，且独立两阶段测试在完整 Electron Main 进程重启后恢复 Session、YOLO、模型和 workspace。同日真实 ToolBox 下一 Turn gate 已验证 model/cwd/approval/effort 及 desired/applied revision。指令模式切换和 ToolBox backend approval 尚未形成 live 收据，因此当前仍不是 `product`。
