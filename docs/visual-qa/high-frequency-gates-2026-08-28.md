# 高频 UIUX 门禁复核（2026-08-28）

当前 HEAD `ba0bfb8e` 之后复核结果：

- `npm run check:uiux`：通过；
- `npm run check:uiux:artifacts`：78 generated files 一致；
- `node scripts/check-vcpui-consumers.mjs`：通过（12 个已有生产证据、20 个候选、32 个展示项）；
- `node scripts/check-harness-parity-status.mjs`：`pass=false`，保留 4 个 capture gaps；
- `node scripts/check-visual-forensics-evidence.mjs` 与 `check-visual-forensics-baseline.mjs`：light/dark 与六个 viewport baseline 全部通过；
- `node scripts/check-chat-kernel-consumers.mjs`：通过，冻结聊天内核边界未被触碰。

该复核支持继续推进高频非冻结组件，但不改变 source-only、ModelPicker legacy parity、artifact-only Electron、Windows 或整体 pixel-equivalence 的未完成状态。
