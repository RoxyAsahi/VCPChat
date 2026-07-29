# Agent Runtime 安全威胁模型（Pi-era 历史资料）

> 已归档：当前 Rust daemon/ToolBox 信任边界见 [current/README.md](current/README.md)。双层审批原则仍有效，但 Main ↔ Pi Worker 的具体机制不是现行实现。

决策依据：[adr/0005-capability-based-approval.md](adr/0005-capability-based-approval.md)。关联需求 AR-SEC-001~010。**Windows 上无内核沙箱**：本架构的安全支柱是"工具唯一出口（VCP 桥）+ 双层审批 + capability 最小授权 + 路径防护"，而非进程隔离。

## 1. 资产

| 资产 | 说明 |
| --- | --- |
| A1 用户凭据 | ToolBox token、模型 API key、插件密钥 |
| A2 工作区文件 | workspaceRoot 内的代码/文档 |
| A3 主机完整性 | 任意文件写、shell 执行能力（经 ToolBox 间接获得） |
| A4 会话数据 | 对话内容、工具参数、审计记录 |
| A5 审批可信度 | 用户看到的审批内容 = 实际执行的内容 |

## 2. 信任边界

| 边界 | 说明 | 跨越规则 |
| --- | --- | --- |
| TB1 Renderer ↔ Main | renderer 可被 XSS/被破坏的 Web 内容污染 | 仅 `agent-runtime:*` 窄 IPC；参数 schema 校验；无通用 invoke（AR-SEC-009） |
| TB2 Main ↔ Worker | worker 运行第三方 SDK（Pi）与模型生成代码路径 | stdio JSON-lines 协议；消息 schema 校验；worker 无窗口/无凭据持久化 |
| TB3 Worker ↔ VCPToolBox | 网络边界；ToolBox 执行真实副作用 | 工具唯一出口；marker 编码纪律；超时与大小限制 |
| TB4 模型输出 ↔ 一切 | LLM 输出（含被 prompt injection 污染的输出）不可信 | 输出永不直接执行；工具调用必须结构化上报且过审批（AR-SEC-010） |
| TB5 工具结果 ↔ agent loop | 工具返回文本可含注入载荷 | 结果按数据回填；不二次解析 marker；截断 |

## 3. 威胁登记

| ID | 威胁 | 攻击路径 | 缓解 | 验证 |
| --- | --- | --- | --- | --- |
| T-01 | Prompt injection 诱导危险工具调用 | 网页/文件内容污染模型 → 请求 `shell.exec` 类工具 | 结构化 tool call + capability 分级 + 高危强制双层审批；审批 UI 展示 argsPreview | ART-006 |
| T-02 | Marker 注入：参数/用户文本含伪造 `<<<[TOOL_REQUEST]>>>` | 构造嵌套 marker 骗 ToolBox 解析出非授权调用 | 编码硬拒绝定界字面量，不转义；解码不二次执行（AR-FR-013） | ART-016 |
| T-03 | 路径逃逸：`../`、符号链接、跨盘符、UNC | 工具参数指向 workspace 外 | Main 规范化 + 逃逸防护（AR-SEC-006）；Phase 3+ scoped token `allowedPaths` 双保险 | ART-017, ART-013 |
| T-04 | Shell 注入 | 参数拼接进 shell 命令行 | 桥不构造 shell 命令；执行语义全在 ToolBox 插件层；参数以结构化 JSON 传递 | ART-027 |
| T-05 | Confused deputy：ToolBox/插件被客户端身份滥用 | 长期凭据 + 无 scope → 任意调用 | Phase 3+ scoped token；Phase 2 凭据不出 Main、最小工具集快照 | ART-015 |
| T-06 | 审批 TOCTOU：批准后参数被改 | 异步窗口期内篡改 args | 审批绑定四元组 + 执行前 argsHash 复核（AR-SEC-001/003） | ART-008 |
| T-07 | 凭据泄漏：日志/事件/审批 UI 带密文 | 调试输出、错误堆栈、事件 payload | Normalizer 统一脱敏；日志规范（AR-SEC-005） | ART-015 |
| T-08 | 旧回调复活：已取消 turn 的迟到结果/审批污染新 turn | 无 correlation 的异步返回 | generation 单调递增 + 丢弃旧代回调（AR-FR-014） | ART-020, ART-021 |
| T-09 | Worker 崩溃被利用（如崩溃前泄露半成品状态）/ 崩溃后孤儿进程残留 | OOM、SDK bug | 崩溃检测 + session failed 广播 + 退出清理（AR-FR-008/011） | ART-011, ART-012 |
| T-10 | 恶意 MCP/插件工具描述（含链接、伪 UI） | 描述文本进审批 UI 诱导误点 | 描述按纯文本渲染、禁 HTML/外链；工具目录快照固定（AR-SEC-010） | ART-028 |

## 4. Capability 权限模型（stable）

每个 agentConfig 声明 session 级 capability 集；Manager 据此裁剪 worker 可见工具集：

```jsonc
{
  "capabilities": [
    { "id": "fs.read",   "tools": ["FileOperator:read"],  "paths": ["<workspace>/**"], "approval": "auto" },
    { "id": "fs.write",  "tools": ["FileOperator:write"], "paths": ["<workspace>/**"], "approval": "user" },
    { "id": "net.fetch", "tools": ["WebSearch"],                                   "approval": "user" },
    { "id": "shell.exec","tools": ["CommandExecutor"],                             "approval": "user+backend" }
  ]
}
```

规则：

1. **未声明即禁止**：不在 capability 列表中的工具对 worker 不可见（工具集裁剪在 worker 注册时完成，非运行时过滤）。
2. **风险分级** `riskClass`：`fs.read`（低）→ `auto` 可本地放行；`fs.write`/`net.fetch`（中）→ 本地用户审批；`shell.exec`/跨路径写（高）→ 本地用户审批 + 后端审批必走。
3. **审批 UI 展示 capability 差异**：本次调用相对 session 既有授权的增量（新路径、新工具、参数放大）必须显著标出。
4. capability 提升（如 fs.read → fs.write）只能在新建/编辑 agentConfig 时由用户显式操作，session 运行中不可热提升。

## 5. 双层审批规则（stable，AR-SEC-001~004/007）

```
工具调用
  → 第一层：VCPChat ApprovalBroker（本地显式审批）
       策略 auto（低危）→ 放行，decidedBy="policy"
       策略 user → 审批窗：展示 toolName/argsPreview/riskClass/超时倒计时
       默认拒绝 | 超时(120s)拒绝 | 无可用审批窗口拒绝 | 无 always-allow
  → 执行前复核 argsHash（不匹配 → 作废重审）
  → 第二层：VCPToolBox 后端审批（VCPLog WS 往返）
       不被本地批准跳过；桥不伪造、不预答后端审批
  → 执行
```

- 审批绑定：`sessionId + turnId + toolCallId + argsHash`，任一不符决议无效（ART-006/008）。
- 无窗口场景（Workbench 关闭、session 无订阅者）：直接拒绝并产生 `approval.resolved(denied, decidedBy="policy")`（ART-009）。
- vcp_delegate session 例外声明：本地无法逐调用审批，UI 必须标注"审批全部发生在后端"且 capability 上限为中危以下（见 [tool-bridge.md](tool-bridge.md#1-两种调用模式)）。

## 6. 验证与审计

- 每条威胁的验证测试见 [test-matrix.md](test-matrix.md) Security 列。
- 发布前安全门禁：ART-006/007/008/015/016/017 必须 complete，不得以 partial 发布（沿用 [ui-system-qa-matrix.md](../ui-system-qa-matrix.md) 的纪律）。

## 7. Workspace 与终端的单一执行边界

Pi/worker 只发结构化 `tool-request`，不得直接 `fs`/`spawn`，renderer 也不得获得 raw spawn。VCPChat 不再维护与 ToolBox 并列的本地执行器：文件统一走 FileOperator，终端统一走 PowerShellExecutor。

| ID | 威胁 | 缓解 | 验证 |
| --- | --- | --- | --- |
| T-17 | FileOperator 参数使用绝对路径、UNC、跨盘或 `..` 逃逸 session workspace | Main 将 FileOperator 路径参数解析并限制在 canonical workspaceRoot 内；Patch 只接受 relative path | `test-agent-tool-bridge.mjs`、`test-agent-diff.mjs` |
| T-18 | 文件内容包含 VCP marker，导致工具协议截断或注入 | 普通桥继续拒绝 marker；受控文件写入改用 escaped write/edit，插件落盘前还原字面量 | `test-agent-diff.mjs` |
| T-19 | Patch 审批后目标内容被替换（TOCTOU） | proposal 保存 before content/hash；apply 前后均经 FileOperator 重读并复核 hash | `test-agent-diff.mjs` |
| T-20 | 未审批写入、revert 覆盖用户后续编辑 | propose 不写；apply/revert 每次均单独绑定审批；revert 复核 after hash | `test-agent-diff.mjs` |
| T-21 | PowerShell 命令执行泄露凭据或造成主机副作用 | `vcp_invoke(PowerShellExecutor)` 归类为高风险并走本地审批；真实进程生命周期由既有插件负责 | `test-agent-tool-bridge.mjs` + live integration |
| T-22 | 多 session 共享 PowerShellExecutor PTY 导致输出或 cwd 相互干扰 | 当前明确记录为后端插件并发限制；后续在既有插件增加 session id/串行化，不恢复第二套 TerminalService | integration planned |

审批分类：`workspace_propose_patch` 为中风险但不写盘；`workspace_apply_patch/revert_patch` 为高风险；`vcp_invoke` 根据目标插件、command/action 和路径参数分类，PowerShellExecutor 与 FileOperator 写操作为高风险。ApprovalBroker 的四元组和参数 hash 仍是唯一批准绑定。

## 8. Phase 6–7 威胁补充

| ID | 威胁 | 缓解 | 验证 |
| --- | --- | --- | --- |
| T-11 | 恶意/被篡改 plugin manifest 注入配置密钥、HTML 描述或虚假低风险 | Catalog 只输出安全投影与 manifest hash；不输出 config；缺失 reliability/risk 显式 `unknown`；显示层仍须纯文本 | ART-029 |
| T-12 | allow 规则覆盖更具体 deny，或过期授权继续生效 | capability policy deny 优先；session/tool/action/path/expiry 全部匹配；默认拒绝 write/shell/subagent；snapshot hash 防静默篡改 | ART-030 |
| T-13 | 子代理递归爆炸、并发洪泛、token/cost/time 透支 | spawn 前检查 depth/concurrency/reserved budget，运行后核算 usage，超时 cancel，父取消级联 | ART-031 |
| T-14 | Team 并行成员写入重叠路径导致覆盖/供应链污染 | Ownership 对规范化父子路径做冲突检测；冲突 fail closed；Handoff 使用结构化摘要和 artifact refs | ART-032 |
| T-15 | Blackboard 作为命令/注入侧信道 | 仅接受结构化 object/array entry 与受限 artifact ref；拒绝裸字符串；消费者仍必须将其视为不可信数据 | ART-032 |
| T-16 | 客户端把 capability/catalog 风险标签误当成 ToolBox 服务端授权 | 文档和审计明确它们只是客户端约束；后端鉴权、审批与插件自身边界仍必须成立 | ART-030 |

### 7.1 边界声明

CapabilityPolicy 与 Catalog risk/reliability 均是 **VCPChat 客户端约束与决策辅助，不是服务端安全边界**。攻击者若绕过客户端直接调用 ToolBox，必须仍受后端鉴权、scoped token、审批、路径限制和执行环境隔离约束。VCPChat 不声明自己的“沙箱执行模式”；执行环境能力由 ToolBox 节点和具体插件负责。
