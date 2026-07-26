# AgentRuntimeDriver 接口

`AgentRuntimeDriver` 是 Main 进程对一切 agent loop 实现（Pi、Grok Build、Claude Agent SDK）的唯一抽象。决策依据：[adr/0003-runtime-driver-interface.md](adr/0003-runtime-driver-interface.md)。关联需求 AR-FR-009/010、AR-COMPAT-004。

## 1. 接口定义（stable 方法 / provisional 可选方法）

```ts
// modules/agent-runtime/drivers/types.d.ts（概念签名，以代码为准）

interface AgentRuntimeDriver {
  readonly id: "pi" | "grok-build" | "claude-sdk";

  /** 探测可用性与版本；不启动长驻进程时可返回缓存结果 */
  probe(): Promise<DriverProbeResult>;

  /** 创建 session；返回 driver 会话句柄与能力 */
  startSession(req: StartSessionRequest): Promise<StartSessionResult>;

  /** 用 RuntimeOpaqueState 恢复 session（Phase 3；不支持时抛 UNSUPPORTED） */
  resumeSession(req: ResumeSessionRequest): Promise<StartSessionResult>;

  /** 发送一个 turn；事件经构造时注入的 sink 回调流出；resolve 于 turn 终态 */
  sendTurn(sessionId: string, req: SendTurnRequest): Promise<TurnTerminal>;

  /** 取消在途 turn；幂等；无在途 turn 时不报错 */
  cancelTurn(sessionId: string, turnId: string): Promise<void>;

  /** 把审批决议转达 driver（driver 原生审批场景；VCP 桥审批由 Manager 直接处理时 driver 返回 UNSUPPORTED） */
  respondToApproval(sessionId: string, approvalId: string, decision: ApprovalDecision): Promise<void>;

  /** 关闭 session，释放其资源；幂等 */
  closeSession(sessionId: string): Promise<void>;

  /** 释放 driver 全部资源（含 worker 进程）；此后 driver 不可用 */
  dispose(): Promise<void>;

  // ---- 可选能力（provisional）----
  fork?(sessionId: string, atTurnId: string): Promise<StartSessionResult>;   // 分叉
  compact?(sessionId: string): Promise<CompactResult>;                        // 手动压缩
  rewind?(sessionId: string, toTurnId: string): Promise<void>;                // 回滚到指定 turn
}

interface DriverProbeResult {
  available: boolean;
  version?: string;                 // 例如 "pi-agent-core/0.82.0"
  capabilities: DriverCapabilities;
  reason?: string;                  // 不可用原因（可读文案）
}

interface DriverCapabilities {
  streaming: boolean;
  toolCalls: boolean;
  nativeApprovals: boolean;   // driver 自带审批概念（Phase 2 全部为 false）
  resume: boolean;
  compaction: boolean;
  fork: boolean;
  rewind: boolean;
  plan: boolean;
  reasoning: boolean;
}
```

事件出口：driver 构造时接收 `sink: (raw: RawDriverEvent) => void`，driver 只产出**无信封**原始事件；信封包装（sequence/时间戳/脱敏）由 Main 的 EventNormalizer 完成（见 [event-protocol.md](event-protocol.md#8-传输映射)）。

## 2. 能力协商（stable，AR-FR-010）

- Manager 在 `session:create` 前先 `probe()`；`available=false` 时创建失败，错误码 `UNAVAILABLE`。
- `startSession` 返回的 capabilities 为**该 session 实际生效**能力（probe 的子集），存入 `AgentSession.capabilities` 并随 `session.created` 事件下发。
- Manager/Workbench 必须按能力位裁剪行为：例如 `reasoning=false` 时不渲染思考链占位；`resume=false` 时 Phase 3 前 resume 入口隐藏。
- 能力位不允许在 session 存活期间变更；driver 升级导致能力变化必须新建 session。

## 3. 错误分类（stable）

driver 抛出的错误统一为 `DriverError`：

| code | 含义 | UI 语义 |
| --- | --- | --- |
| `UNAVAILABLE` | runtime 缺失/版本不符/启动失败 | 提示安装或环境检查 |
| `VERSION_MISMATCH` | 锁定版本不符（如 Pi ≠ 0.82.0） | 阻断并提示精确版本 |
| `SESSION_NOT_FOUND` | session 不存在或已关闭 | 刷新 session 列表 |
| `TURN_CONFLICT` | 同 session 已有 running turn | 排队或稍候 |
| `CANCELLED` | 已被取消（终态，非错误展示） | 标记已中断 |
| `TIMEOUT` | turn/tool/spawn 超时 | 可重试提示 |
| `TOOL_ERROR` | 工具执行失败（含 `backend-denied` 子类 reason） | 工具卡片展示失败 |
| `APPROVAL_REQUIRED` | driver 侧等待审批（Phase 4+ 原生审批用） | 打开审批 UI |
| `PROTOCOL` | worker 消息反序列化/协议错误 | 记日志并提示重开 session |
| `CRASHED` | worker 进程退出/心跳丢失 | session 终止广播 |
| `QUOTA` | 资源上限触发（内存/事件率） | 提示节流 |
| `UNSUPPORTED` | 调用了未实现的可选方法 | 调用方按能力位预先避免 |
| `INTERNAL` | 未分类 | 兜底，必须带 `cause` |

映射规则：`turn.failed` / `session.error` / `tool.failed` 事件的 `code` 一律取上表；禁止把原始异常 message 直接展示（可能含路径与凭据，先脱敏，AR-SEC-005）。

## 4. Driver 合规测试清单（Contract 级，ART-022）

每个 driver 实现必须通过以下用例（共享测试套件，参数化 driver 实例）：

1. `probe` 在 runtime 缺失时返回 `available:false` 且不抛异常。
2. `startSession` 返回非空 sessionId 与 probe 能力子集；重复 `closeSession` 幂等。
3. `sendTurn` 在 running 期间再次调用同 session 抛 `TURN_CONFLICT`。
4. `cancelTurn` 幂等：运行中调一次、终态后再调一次，均不抛、事件不重复终态。
5. 事件流终止性：每个 turn 必然产生且仅产生一个终态（completed/failed/cancelled）。
6. `sendTurn` 的 sink 事件不携带凭据原文（注入含 token 的输入断言输出脱敏）。
7. `dispose` 后所有方法抛 `UNAVAILABLE` 或 `SESSION_NOT_FOUND`，不得静默成功。
8. 可选方法未实现时保持 `undefined`（调用方以能力位判定），不得抛 `INTERNAL`。
9. 事件字段类型符合 [event-protocol.md](event-protocol.md) 对应 payload schema。
10. driver 不直接触达 Electron API（静态 lint：禁止 import `electron`）。

## 5. 三个 Driver 的映射草案（provisional）

### 5.1 Pi（Phase 1-2 首选基座）

| 接口 | 映射 |
| --- | --- |
| 运行形态 | fork `agent-runtime/worker-entry.js`，`ELECTRON_RUN_AS_NODE=1`，stdio JSON-lines |
| `probe` | spawn `worker-entry --probe`：校验 Node>=22.19、VCP Pi Core fork 可加载并报告来源版本 |
| `startSession` | worker 内 `AgentHarness` 初始化；**禁用全部内置工具（read/write/edit/bash）与 extension 自动加载**；仅注册 VCP 桥工具（AR-SEC-008） |
| `sendTurn` | 调 agent loop；流式 delta/tool call 经 sink 上报；turn 串行由 Manager 强制，worker 内不排队 |
| `cancelTurn` | worker 侧 abort controller；桥向 `/v1/interrupt`（见 [tool-bridge.md](tool-bridge.md#取消与超时映射)） |
| `respondToApproval` | `UNSUPPORTED`（审批在 Manager/桥层完成，Pi 无审批概念） |
| `resumeSession` | Phase 3：经 RuntimeOpaqueState 恢复 Pi 的 resume/compaction 状态（opaque，不解析） |
| 能力位 | streaming/toolCalls/plan/reasoning = true（以实测为准）；nativeApprovals/fork/rewind = false；resume/compaction = Phase 3 定 |

### 5.2 Grok Build（Phase 4，外部 Driver，ACP）

| 接口 | 映射 |
| --- | --- |
| 运行形态 | 外部进程（Apache-2.0，`xai-org/grok-build`），ACP over stdio（首选）或 WebSocket |
| `probe` | ACP handshake + 版本声明 |
| `sendTurn` | ACP session/turn 消息 → 归一化为统一事件 |
| `respondToApproval` | 若 ACP 提供 permission 原语则映射；否则 `UNSUPPORTED`，沿用 VCP 桥审批 |
| 风险 | ACP 语义与统一信封的 impedance mismatch（如原生 diff/终端事件）→ 超出信封的一律降级为 `runtime.warning` 附件，不扩展私有事件类型（扩展须 ADR） |

### 5.3 Claude Agent SDK（Phase 4，Claude 专属 Driver）

| 接口 | 映射 |
| --- | --- |
| 运行形态 | 独立 Node worker（同 Pi 进程模型），加载 Claude Agent SDK |
| 工具 | SDK 内置工具一律关闭或重定向到 VCP 桥；不接受 SDK 直执 bash/edit |
| `respondToApproval` | SDK 的 permission callback 可映射为向 Manager 反向请求（即仍走 ApprovalBroker），不允许 SDK 侧自动放行 |
| 风险 | SDK 版本策略与 Pi 不同；锁定版本与隔离方式按 [adr/0007-pi-version-and-worker-isolation.md](adr/0007-pi-version-and-worker-isolation.md) 同模式另立 ADR |

### 5.4 映射公共约束

- 三个 driver 对外**只允许**统一信封事件；任何 runtime 特有信息放入 payload 的可选扩展字段 `payload.vendor`（object，provisional，不进 schema 校验的稳定部分）。
- 任何 driver 不得绕过 VCP 桥直接执行本地能力（文件/shell/网络），发现即视为安全缺陷（AR-SEC-008/010）。
