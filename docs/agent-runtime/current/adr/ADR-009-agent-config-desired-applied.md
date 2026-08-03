# ADR-009：Session Desired/Applied 配置分离

状态：Accepted，R12 working tree。

Session 配置不再使用单一 Snapshot 同时代表“用户已保存”和“Runtime 已生效”。SQLite 保存版本化 `desiredConfig` 与 `appliedRuntimeConfig`，分别带 `configRevision` 和 `appliedRuntimeConfigRevision`。

设置 IPC 先以 CAS 提交 desired，再由独立 Apply Coordinator 调用 Codex 0.146。只有 `thread/settings/updated`、成功 resume 或携带目标配置的 Turn ACK 可以推进 applied。发送必须经过 barrier；失败时保持 desired 与错误，不静默回滚或继续使用错误配置。

Responses Adapter 只读 applied，避免 active Turn 中途读取尚未确认的提示词。该模型不宣称 VChat SQLite 与 Codex Thread 跨进程 ACID；失败通过 pending/error 和人工重试显式呈现。

后果：UI 可以准确区分“已保存”和“下一轮应用”；Runtime 状态写入前必须重新读取最新 Session，禁止旧对象整行覆盖配置 revision。
