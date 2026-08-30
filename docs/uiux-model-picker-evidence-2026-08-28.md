# Agent ModelPicker 证据更新（2026-08-28）

本轮只核验 Agent Settings 的 ModelPicker，不改变聊天参数组装、IPC、持久化或冻结的 composer/消息区域。

## 已有证据

- `node scripts/check-vcp-agent-model-picker-trusted-keyboard-evidence.mjs`：通过。固定 800×600 下，键盘可达 `menuitemradio`，focus-visible 生效，关闭后触发器焦点恢复，owner 已 dispose。
- `node scripts/test-vcp-model-picker-b1-state-matrix.mjs`：通过 `candidate-lab-state-matrix-complete`，覆盖 loading、disabled/locked、selecting、retry、Toast/error 等状态。
- `npm run test:uiux`：82 项通过，包含 AgentModelPicker 的 popup、晚到结果、目录动作、锁定和失败状态测试。

## 仍未闭合

上述结果证明 generated Candidate 的交互与生命周期，不证明 Harness 生产等价。当前状态保持：

```text
production-consumer-active / visual-equivalence-pending
```

以下事项仍是独立缺口：

- Harness/VCP 同语义 DOM、computed-style、hover/focus/disabled/selected 截图对照；
- `modelSelectModal` legacy presentation path 的完整 parity 与删除条件；
- packaged artifact-only Electron smoke；
- Windows 真实证据。

在这些缺口闭合前，ModelPicker 继续作为真实 consumer + legacy fallback 的迁移切片，不晋级 Stable，也不扩展到低频 bespoke picker。
