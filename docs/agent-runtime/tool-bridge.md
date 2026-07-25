# VCP 工具桥（tool-bridge）

Worker 内 agent loop 与 VCPToolBox 之间的客户端桥。Phase 2 基于旧接口实连（决策见 [adr/0004-legacy-vcp-tool-bridge.md](adr/0004-legacy-vcp-tool-bridge.md)）；旧接口缺陷与 Phase 3+ 契约见 [legacy-toolbox-compatibility.md](legacy-toolbox-compatibility.md)。Marker 语法唯一真源是 [VCP.md](../../VCP.md)，本文件不重复语法，只规定桥侧编码/解码纪律。

## 1. 两种调用模式

### vcp_invoke（首选，单工具调用）

- 传输：`POST /v1/human/tool`，body 为 marker 文本编码的工具调用（`<<<[TOOL_REQUEST]>>> ... <<<[END_TOOL_REQUEST]>>>`，字段用「始」/「末」定界，见 [VCP.md](../../VCP.md)）。
- 语义：请求 ToolBox 执行**一个**工具并返回结果文本。桥把结构化 `{toolName, arguments}` 编码为 marker 文本，把响应文本归一化为 `tool.result`。
- 适用：Pi agent loop 产生的每一次 tool call。

### vcp_delegate（整段委派）

- 传输：`POST /v1/chatvcp/completions`。
- 语义：把"模型 + 工具循环"整段委派给 ToolBox 内部 VCP loop，ToolBox 自行迭代工具调用直到产出最终回复。
- 适用：不经过 Pi 的直通 agent 模式（agentConfig 声明 `delegate: true` 的 session）；Workbench 将其作为一类特殊 driver 展示。
- 约束：delegate 模式下**本地看不到逐步工具调用**，本地审批无法逐调用介入——因此 delegate session 在 UI 必须显式标注"审批全部发生在后端"，且本地 capability 策略只允许 `auto` 级以下工具集（见 [security-threat-model.md](security-threat-model.md#capability-权限模型)）。

## 2. Marker 编码规则（stable，AR-FR-013）

编码方向（worker → ToolBox）：

1. `toolName` 必须匹配 `/^[A-Za-z][A-Za-z0-9_-]{0,63}$/`，否则本地拒绝（不进网络）。
2. 参数值一律序列化为 JSON 字符串后填入 value 字段；ToolBox 侧按既有规则解析。
3. **注入防护**：参数值中若出现 marker 定界字面量（`<<<[TOOL_REQUEST]>>>`、`<<<[END_TOOL_REQUEST]>>>`、「始」「末」作为独立定界token出现），编码器必须拒绝该调用并报 `tool.failed`（code=`PROTOCOL`），**不得**尝试转义——旧协议无转义语义，放行即注入（威胁 T-02，验证 ART-016）。
4. 单条编码后 marker 文本 ≤ 32KB；超限拒绝并提示缩减参数（AR-NFR-003 同源限制）。

解码方向（ToolBox → worker）：

- 响应按旧接口既有格式原样接收为文本；桥**不**在响应中再解析嵌套 marker（响应文本一律视为不可信数据，永不二次执行）。
- 响应 > 64KB 截断并置 `truncated: true`。

## 3. 参数 hash（stable，AR-SEC-001/003）

```
argsHash = "sha256:" + SHA256( JCS({ toolName, arguments }) )
```

- `JCS` 为 canonical JSON（RFC 8785）：键排序、无空白、数字最短表示。worker 与 Main 必须各自独立计算并一致；审批请求携带 argsHash，执行前 Main 复核，不一致则决议作废、重新走审批（TOCTOU 防护，ART-008）。
- hash 输入使用**未脱敏**的原始参数（否则决议绑定错对象），但 hash 输出与预览（argsPreview）脱敏后进入事件与 UI（AR-SEC-005）。

## 4. 取消与超时映射

| 场景 | 行为 |
| --- | --- |
| 用户取消 turn | worker abort → 在途 HTTP 请求 abort → best-effort `POST /v1/interrupt`（携带旧接口支持的标识字段）；`tool.failed` code=`CANCELLED` 或 `turn.cancelled` |
| 工具级超时（默认 120s） | 本地 abort + `/v1/interrupt`；`tool.failed` code=`TIMEOUT` |
| turn 级超时（默认 300s，上限 1800s） | 整 turn 取消，在途工具同上处理 |
| 后端审批等待 | 由 ToolBox 侧超时策略决定；桥等待上限 = 工具级超时 ×2，超时按 `backend-denied` 处理 |

注意：旧接口无 correlation ID，`/v1/interrupt` 是 best-effort——中断到达前 ToolBox 可能已完成执行。桥必须容忍"已取消的调用仍返回结果"：该结果按 generation 防复活规则丢弃（AR-FR-014），并在 audit 中记 `lateResult: true`（详见 [legacy-toolbox-compatibility.md](legacy-toolbox-compatibility.md#客户端补偿清单)）。

## 5. 结果归一化（stable）

`tool.result.payload`：

```jsonc
{
  "toolCallId": "tc_...",
  "ok": true,
  "result": "...",            // 文本结果；结构化结果序列化为 JSON 文本
  "truncated": false,
  "durationMs": 1234,
  "audit": { /* 见 §7 */ }
}
```

- `ok=false` 一律走 `tool.failed`（不混用 result 承载错误）。
- 后端审批拒绝归一化为 `tool.failed` code=`backend-denied`，`decidedBy` 经 `approval.resolved` 另发。
- agent loop 收到的工具输出 = 归一化后的 `result` 文本（截断形态），loop 不得索取"完整未截断版"。

## 6. 并行调用（Phase 2 约束）

- Pi 单 turn 可能产出多个 tool call。Phase 2：桥按 `toolCallId` 顺序**串行**执行，结果按同序回填 agent loop（AR-FR-002 延伸，ART-014）。
- 每个 tool call 独立走审批与 argsHash；不允许"批一次审批放行整批"。
- 并行执行（Phase 5）前提：capability 冲突矩阵 + 后端并发语义确认，届时修订本节并升 provisional → stable。

## 7. 审计字段（stable）

每次工具调用在事件与日志中携带：

| 字段 | 说明 |
| --- | --- |
| `toolCallId` | 本次调用唯一 ID |
| `toolName` / `argsHash` | 见 §3 |
| `transport` | `vcp_invoke` / `vcp_delegate` |
| `approvalId` / `decidedBy` | 本地审批关联与决议来源；无本地审批时 `decidedBy="policy"` |
| `backendApprovalId` | ToolBox VCPLog 审批往返的标识（若可取得；旧接口无 correlation 时为 null，UI 语义见 legacy 文档 §3） |
| `durationMs` / `truncated` / `lateResult` | 执行度量与截断/迟到标记 |
| `riskClass` | capability 风险分级（见 security 文档） |

审计记录 Phase 2 存内存事件缓冲，Phase 3 落 SQLite（见 [data-model.md](data-model.md)）。
