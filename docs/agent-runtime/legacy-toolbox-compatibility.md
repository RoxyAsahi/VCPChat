# 历史兼容说明（非当前真源）：VCPToolBox 旧接口与补偿

> 本文记录早期接口讨论与未来后端提案，不是当前 VCPAgent 产品路径，也不授权修改 VCPToolBox。当前约束和 daemon 边界以 [current/README.md](current/README.md) 为准。

Phase 2 用旧接口实连（`legacy-frozen`）：`POST /v1/chatvcp/completions`（vcp_delegate）、`POST /v1/human/tool`（vcp_invoke）、`/v1/interrupt`、VCPLog WebSocket 审批往返。本轮**不修改 VCPToolBox**。

> **核心立场：接通 ≠ 达到目标安全架构。** 旧接口满足功能连通，但缺 scoped token、缺稳定 Tool Catalog/JSON Schema、缺 correlation ID。本文件列出缺陷与客户端必须实施的补偿，并把结构化 API 固化为 Phase 3+ 的正式后端契约提案。

## 1. 旧接口行为（描述，不改）

| 接口 | 行为 |
| --- | --- |
| `POST /v1/human/tool` | 接收 marker 文本编码的工具调用，ToolBox 按 VCP 协议解析并执行，返回文本结果。工具若需人工审批，ToolBox 经 VCPLog WebSocket 发起审批往返，等待期间 HTTP 请求挂起。 |
| `POST /v1/chatvcp/completions` | 整段聊天补全；开启 VCP 工具循环时 ToolBox 内部迭代"模型输出 marker → 执行 → 回填"，直到产出最终回复。 |
| `POST /v1/interrupt` | 请求中断当前正在进行的处理；语义为 best-effort，无调用级定向。 |
| VCPLog WebSocket | ToolBox 推送日志与审批请求；审批决议经同一通道回传。 |

## 2. 缺陷清单（承认，不掩饰）

| # | 缺陷 | 安全/工程影响 |
| --- | --- | --- |
| D1 | 无 scoped token：客户端持长期凭据，无按 session/工具/路径的最小授权 | confused deputy 面大；凭据泄漏=全权限泄漏（T-05/T-07） |
| D2 | 无稳定 Tool Catalog / JSON Schema：工具列表与参数 schema 需从插件层间接推断，无版本化契约 | 审批 UI 无法可靠展示参数语义；客户端无法预校验 |
| D3 | 无 correlation ID：HTTP 调用、interrupt、WS 审批三者无法可靠互相关联 | 审批结果与工具调用的绑定是启发式；中断可能误伤/漏伤 |
| D4 | marker 文本编码无转义语义 | 注入风险必须由客户端编码侧硬拒绝（见 [tool-bridge.md](tool-bridge.md#2-marker-编码规则)） |
| D5 | 审批与执行间无参数绑定证明 | TOCTOU 只能靠客户端 argsHash 自检，后端不复核 |
| D6 | interrupt 为全局/会话级语义，非调用级 | 并发场景中断粒度粗 |

## 3. 客户端补偿清单（必须实现，否则不得发布 Phase 2）

| 缺陷 | 补偿（实现位置） | 需求/测试 |
| --- | --- | --- |
| D1 | 凭据仅存 Main 进程内存/安全存储，永不进 renderer、事件、日志；worker 经 Main 注入式获取且不落盘（ApprovalBroker 统一持有出站配置） | AR-SEC-005 / ART-015 |
| D2 | 工具目录以 ToolBox 运行时实际返回为准做**快照缓存**，session 创建时固定；审批 UI 展示的是快照中的名称/描述，且描述按不可信文本渲染（不执行 HTML） | AR-SEC-010 / ART-028 |
| D3 | 桥侧自构关联：`toolCallId` 贯穿本地事件；对 WS 审批用"时间窗 + 工具名 + 在途唯一性"启发式匹配，匹配置信度写入 audit；**置信度不足时 UI 显示"后端审批（关联未证实）"而非假装精确对应** | AR-FR-006 / ART-023 |
| D3/D6 | 取消后收到的迟到结果按 generation 丢弃并记 `lateResult`（见 [tool-bridge.md](tool-bridge.md#4-取消与超时映射)） | AR-FR-014 / ART-020 |
| D4 | marker 编码硬拒绝（定界字面量出现即拒绝，不转义）；用户输入与工具结果文本永不进入编码通道 | AR-FR-013 / ART-016 |
| D5 | 执行前 Main 复核 argsHash；不一致则审批作废重来 | AR-SEC-003 / ART-008 |
| D6 | Phase 2 同 session 串行工具调用，把"误伤范围"收敛到当前调用；UI 在中断时提示"中断为尽力而为" | AR-FR-005 / ART-010 |
| 全部 | 大小限制（marker ≤32KB、结果 ≤64KB）、超时（工具 120s / turn 300s）本地强制，不依赖后端 | AR-NFR-003 / ART-019 |

## 4. Phase 3+ 后端结构化 API 契约提案（stable 目标；落地另立项目）

以下为本客户端对 VCPToolBox 的正式契约需求。后端实现前，客户端不得依赖其存在。

### 4.1 Tool Catalog

```
GET /v1/tools
Authorization: Bearer <scoped-token>

→ 200 {
  "catalogVersion": "2026-07-25T00:00:00Z",
  "tools": [{
    "name": "FileOperator",
    "description": "...",            // 不可信文本，渲染侧负责安全
    "inputSchema": { /* JSON Schema 2020-12 */ },
    "riskClass": "fs.write",
    "requiresApproval": true,
    "sensitiveParams": ["targetPath"]
  }]
}
```

要求：`catalogVersion` 单调可比较；schema 变化必须升版本；客户端按版本缓存并校验。

### 4.2 结构化调用

```
POST /v1/tools/invoke
Authorization: Bearer <scoped-token>
{
  "toolCallId": "tc_...",          // 客户端生成，全链路 correlation
  "toolName": "FileOperator",
  "arguments": { /* 按 inputSchema */ },
  "sessionId": "sess_...",
  "approval": { "argsHash": "sha256:...", "localDecision": "approved" }
}

→ 200 { "toolCallId", "ok": true, "result": ..., "truncated": false, "audit": {...} }
→ 4xx { "toolCallId", "ok": false, "code": "denied"|"invalid"|"timeout", "message" }
```

要求：服务端复核 `argsHash`（JCS+SHA256）与实际执行参数一致；不一致返回 `409`；`toolCallId` 在响应、事件流、审批报文中全程回显（治愈 D3/D5）。

### 4.3 事件流

```
GET /v1/sessions/{sessionId}/events   (SSE 或 WebSocket)
```

审批请求/决议、工具进度作为结构化事件推送，携带 `toolCallId` 与 `approvalId`，替代启发式匹配（治愈 D3）。信封与 [event-protocol.md](event-protocol.md) 对齐或提供无损映射。

### 4.4 Scoped token（声明式字段）

```jsonc
{
  "tokenId": "tok_...",
  "subject": { "app": "VCPChat", "sessionId": "sess_..." },
  "allowedTools": ["FileOperator", "WebSearch"],   // 显式枚举，无通配
  "allowedPaths": ["D:/work/project/**"],          // 规范化后的路径 glob
  "expiresAt": "2026-07-25T12:00:00Z",             // 短寿命，建议 ≤ 1h，可续期
  "singleUse": false,
  "approvalPolicy": { "backendApprovalRequired": ["fs.write", "shell.exec"] }
}
```

要求：越权调用返回 `403` 且不执行；token 可撤销；签发/撤销有审计（治愈 D1）。客户端侧契约：worker 只持有 scoped token，长期凭据不出 Main（与 §3 D1 补偿衔接）。

### 4.5 迁移策略

新旧接口并行至少一个 Phase；客户端以 capability 探测（`GET /v1/tools` 可达性）选择走结构化或 legacy 路径；选择结果写入 `AgentSession` 审计。回滚：探测失败自动回退 legacy 路径并记 `runtime.warning`（契约落地前的探测代码 Phase 3 才允许进主干）。
