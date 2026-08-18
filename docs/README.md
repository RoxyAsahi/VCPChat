# UI 架构文档索引

本目录包含当前规范、专项设计和历史迁移记录。文件名中的 `next-ui` 多为历史命名；
主窗口现在只有一个 `main-chat` Surface。

## 当前权威文档

| 文档 | 用途 |
|---|---|
| [`next-ui-current-state.md`](./next-ui-current-state.md) | 当前实现、边界、验证状态与 PR 就绪定义 |
| [`next-ui-development-roadmap.md`](./next-ui-development-roadmap.md) | 从当前状态继续开发的阶段顺序 |
| [`next-ui-lifecycle-architecture.md`](./next-ui-lifecycle-architecture.md) | Scope、Task、Overlay、View 与 dispose 合同 |
| [`vcp-ui-provider-architecture.md`](./vcp-ui-provider-architecture.md) | VCPUI、native DOM 与 Web Awesome 的职责边界 |
| [`main-chat-operation-sequence-testing.md`](./main-chat-operation-sequence-testing.md) | 主聊天操作序列、故障注入和资源不变量 |

## 支撑资料

`appearance-design-system.md`、`ui-components-wa-matrix.md`、`ui-engineering-standard.md`、
`ui-system-qa-matrix.md` 和 `ui-system.md` 提供专项细节。若与当前状态文档冲突，以
`next-ui-current-state.md` 为准。

## 历史记录

以下文档保留迁移背景，不再指导当前实现：

- `classic-retirement-architecture.md`
- `classic-retirement-inventory.md`
- `design-system-upstream-pr-convergence.md`
- `upstream-function-parity.md`
- `ui-active-surface-policy.md`
- `ui-applications-webawesome-migration-plan.md`
- `next-ui-webawesome-roadmap.md`

历史记录可以出现 Classic/Next 双 presentation、`uiMode` 和旧 PR 策略，但不得被测试、
代码注释或新设计文档引用为当前合同。

## 维护规则

1. 当前事实只写入当前权威文档。
2. 一次性调查结果进入专项文档或 Git 历史，不追加到状态页末尾。
3. 新增公共 API 必须同时记录生产消费者、owner、dispose 和删除条件。
4. 无生产消费者的 mode facade、测试 Store 或迁移脚本应删除，而不是长期禁用。
