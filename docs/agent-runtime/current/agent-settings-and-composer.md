# Agent Settings 与 Composer 合同

状态：**R12/R16 implemented / working-tree**（2026-08-05）。本页与 [data-governance.md](data-governance.md) 共同构成设置真源；高级发送不在本阶段，旧 R11 收据不覆盖当前工作树。

## 三个作用域

### Agent 默认

`AgentProfile` 是新 Session 的模板，保存 `profileRevision`、名称、头像、指令来源、两类可配置指令、personality、默认模型、reasoning effort、workspace 和本地审批模式。`executionProfile` 固定为 `toolbox-only`。

新建 Session 只有一个动作：复制当前 Profile 形成冻结快照，不再弹出重复配置表单。修改 Profile 不传播到旧 Session。

### 当前会话

`SessionConfigV2` 保存创建时的 Profile ID/revision、desired/applied 配置和独立 revision。模型、workspace、reasoning、personality 与本地审批通过 `expectedConfigRevision` CAS 保存并从下一 Turn 生效。VChat 指令可在空闲 Thread 安全 reload；active Turn 时保持 pending。只有 VChat 身份切换到 Codex 管理模式需要确认后创建派生 Session。

### 高级

只放安全预算、Runtime/schema/build 信息、Saga/孤立 Thread 恢复、导出与诊断。高级区不改变 Agent 身份，也不把恢复表单常驻在普通设置中。

“配置与 Runtime 诊断”由 `agent-settings-advanced-feature.js` 独立组合，读取当前 Session 的权威配置，不从侧栏控件或其他 Agent Profile 猜测。它同时展示 desired/applied revision、应用状态、Runtime generation、只读存储状态和脱敏 ToolBox endpoint，并提供：

- 重新读取：只读 Main/SQLite，不启动或重配 ToolBox。
- 重新应用：Renderer 只发送 `sessionId`；Main 解析权威 Thread 并执行配置 barrier，不伪造一次保存或提升 config revision。
- 复制诊断：提示词只输出字符数，workspace 只输出 basename，endpoint 删除凭据/query/hash；API key、完整指令、消息内容、附件和绝对路径一律不进入摘要。

切换 Session 时，诊断 request generation 同步切换。Session A 的迟到读取、保存冲突或 Runtime 错误不得显示在 Session B。剪贴板不可用必须显示明确错误，不静默宣称复制成功。

每个 Profile/Session 的每个字段独立显示 `dirty/saving/saved/pending-runtime/applying/conflict/error`。Select 先更新 Draft 再保存；文本输入 500 ms 去抖；workspace 由 Main 重新解析和验证。CAS 冲突保留本地输入，不允许旧 Snapshot 重绘覆盖。

## 指令来源

`instructionMode` 只有：

- `vchat-identity`：`baseInstructions` 必填。Thread start/resume 只传 `baseInstructions`；Responses Adapter 丢弃 App Server 嵌入的身份指令，仅向 ToolBox 注入 Session 冻结的 VChat 身份。`{{Nova}}` 等占位符原样持久化，由 ToolBox 展开。
- `codex-managed`：Thread start/resume 不传 `baseInstructions`，可传 `personality` 与 `developerInstructions`。Responses Adapter 只接受带本地 loopback capability、已知 Thread/Session identity 的 App Server 指令，并限制为 64 KiB。协议没有返回的完整 Codex prompt 不展示、不猜测。

两种模式都严格注册和转发唯一动态工具 `vcp_invoke`；切换模式不会启用 Shell、file、MCP、Plan、Review 或 multi-agent。Profile 会保留另一模式的未生效字段，避免来回切换时丢失用户内容；`instructionMode` 决定实际发送路径。

## Reasoning capability

模型列表仍来自 Main 的 `/v1/models` 缓存。只有 metadata 明确提供 `reasoningEfforts`、`reasoning_efforts` 或等价 capability 数组时，UI 才显示具体档位；否则只显示禁用的“模型默认”。Main 再次验证请求值，非法档位返回 `REASONING_EFFORT_UNSUPPORTED`。

有效 effort 在下一次 `turn/start.effort` 发送。Responses Adapter 仅把 App Server 实际发出的 Responses reasoning effort 映射为 ToolBox Chat 的 `reasoning_effort`；ToolBox 拒绝时原样报错，不降级、不显示伪成功。

## Session Composer

Renderer 仅在页面生命周期内维护：

```text
composerStateBySession: Map<sessionId, {
  draft
  attachments
  activeInputMode: follow-up | steer
  scrollAnchor
}>
```

切换 Session 只切换 Map entry。成功接受普通 Turn 后清空该 Session 的 draft/attachments；失败保留。归档、永久删除或同 Session workspace identity 变化时清理对应临时内容。它们不进入 SQLite、localStorage、sessionStorage 或 transcript。

无 active Turn 时发送调用 `turn/start`。有 active Turn 时：

- `立即调整` 调用 `turn/steer`；`/steer` 仍作为兼容入口。
- `排队后续` 写入持久 follow-up queue。
- `停止` 独立调用 `turn/interrupt`。

空输入不会再隐式停止任务；重复点击仍受现有 per-Session turn-start barrier 约束。本阶段没有长按发送、右键发送、临时 Turn 指令或 Tavern 规则。

## 当前验证

2026-08-03 在 Windows x64、Codex App Server `0.146.0` 固定 schema 下通过：

```text
npm run test:codex-stack              PASS
npm run test:codex-reliability        PASS
npm run test:agent-settings-ux        PASS
npm run test:agent-settings-interaction PASS
npm run test:agent-config-diagnostics PASS
npm run test:agent-composer-state     PASS
npm run check:agent-runtime           PASS
npm run check:codex-governance        PASS
npm run check:ui-system               PASS
npm run test:electron-codex-smoke     PASS
node scripts/test-electron-codex-process-restart.mjs PASS
```

Electron smoke 已覆盖当前 Session 的 YOLO/cwd 真实点击、异步保存、诊断读取/重新应用、Session 切换和 Renderer reload；独立进程测试进一步覆盖 Electron Main 完整退出重启后的 SQLite 恢复。真实 ToolBox 下一 Turn 已验证 cwd/model/approval/effort 与 provider reasoning 参数。

2026-08-05 的 R16 诊断验收使用生产 View/CSS 在真实 Electron 中渲染 `thread/settings` 超时：139 px 侧栏下健康摘要、配置差异、影响、下一步和错误操作保持可读；脱敏 JSON 默认折叠，展开后不会推宽侧栏；错误码单行省略并提供完整 tooltip。浅色和深色截图均人工检查。诊断组合已拆为 health/details/errors、budget、recovery 等独立 Agent-only View，并纳入 `element/update/dispose` 治理。

双 Agent 并发设置交互、指令模式切换和 backend approval 仍不属于本页的产品完成证据，因此整体不标记 `product`。
