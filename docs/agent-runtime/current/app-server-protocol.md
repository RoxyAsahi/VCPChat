# Codex App Server 协议适配

## 版本与能力合同

当前开发基线固定为 Codex CLI `0.146.0`、release tag `rust-v0.146.0`、Codex source
`e363b08c9175ac1cbe5893615dd2cb9ddf95043b`。npm package integrity 固定为
`sha512-yG3sPWNda/2YAIQIDq9MrrjoCTIQ7rxYM5IasrG3VBcuhCLTkgeg/JzqmJq1V98RE4MJ5jCxDXXQlOjrditFRw==`。
VChat 从这个精确包生成并提交 TypeScript/JSON schema fixture；本地 `codex` 仓库的 `main` 只用于审计，
不能替代 release schema。

生成与校验命令：

```powershell
npm run sync:codex-schema
npm run check:codex-schema
```

stable JSON tree：275 files，SHA-256 `6283c8d607b5153578b7e0d7708b3180321d84a37bdf5249a68a49bb13f8affa`；
experimental JSON tree：349 files，SHA-256 `c1492848a4728f0681bfc85d0f087f28bf2962b70abe8eb91c72cac1daa57392`。
协议字段或 Item 类型变化必须先更新 fixture、投影和测试，再允许 GUI 消费。

能力分三层：

| 层级 | 含义 | GUI 行为 |
|---|---|---|
| `stable` | 当前固定版本、Projection 和交互闭环均有 fixture | 可进入正式 UI。 |
| `experimental` | App Server 暴露但参数或行为可能变化 | 必须经 capability discovery，并显示实验状态。 |
| `unsupported` | VChat 没有可靠投影或响应通道 | 不显示控制项；收到请求时 fail-closed。 |

当前产品 profile 为 `toolbox-only`，模型可见工具只允许 `vcp_invoke`。App Server 的 command、file、MCP、collaboration、subagent 等能力不能因为 schema 中存在就自动启用。未来 `codex-native` profile 必须拥有独立能力矩阵和审批门槛。

初始化后同时校验 `userAgent` 版本与返回 capabilities。源码中出现而运行版本未声明的 Notification/Item 只能进入限长 Unknown fallback；未知 Server Request 不得返回伪成功。GUI-R0 的完整要求见 [gui-capability-roadmap.md](gui-capability-roadmap.md)。

## 传输

当前使用 `codex app-server --listen stdio://` 的 JSONL 协议，不使用 ACP，不使用 `codex exec --experimental-json`，不读取 Codex 内部 rollout 文件。

启动解析顺序：

1. `VCP_CODEX_APP_SERVER`；
2. `CODEX_APP_SERVER_EXECUTABLE`；
3. VChat 设置中的 `agentRuntime.codex.executable` / `codexAppServerPath`；
4. Windows `where codex-app-server`；
5. 开发工作树的 `node_modules/.bin/codex.cmd`；
6. Windows `where codex` / PATH。

`.cmd` 通过 Windows shell 启动；原生 `.exe` 直接 spawn。stdout 只允许协议 JSONL，stderr 只作为诊断流。单行上限当前为 4 MiB。

## 初始化

```text
client -> initialize {
  clientInfo: { name: "vcp_chat", title: "VCPChat", version: ... },
  capabilities: { experimentalApi: true }
}
server -> initialize result
client -> initialized {}
```

必须保存但不得记录敏感信息：executable source、PID、CLI version、initialize result/capabilities。当前最低兼容版本为 Codex `0.146.0`，支持版本线固定为 `0.146`；无法从 `userAgent` 识别版本、版本过低或版本线不匹配时立即停止进程。初始化超时、非法 JSON、未知 envelope、进程退出或版本不兼容均拒绝启动，不回退旧 Rust daemon。

### 0.146 provider wire 兼容

0.146 的 Responses Lite 请求将 base instructions 表达为 `input` 中的 developer message，并把 Codex
内建工具放入 `additional_tools` item。ToolBox-only adapter 不信任这两类文本/工具：它根据
`x-codex-turn-metadata` 的 Thread identity 回查 Projection SQLite，只把该 Session 冻结的
`baseInstructions` 映射为唯一 Chat `system` message；`additional_tools` 中的 exec/wait/native tools 全部丢弃。

0.146 的 `x-codex-turn-metadata.session_id` 是 Codex provider/App Server Session identity，当前等于公开
Codex Thread ID；它不是 VChat 的 `session_...` 主键。Adapter 必须先按 Codex Thread ID 回查 VChat
Session，再要求 provider `session_id` 与该 Codex Thread ID 一致。拿它和 VChat Session 主键比较会拒绝
每一条真实 provider 请求；跨 Thread 的 provider identity 仍必须 fail-closed。

0.146 的自定义 provider 请求可能不在顶层 `tools` 重复携带已注册 dynamic tool。VChat 因此在最终
ToolBox allowlist 边界补出唯一 `vcp_invoke` Chat definition。真实 App Server 已验证模型返回该 function
call 后，Codex 仍会发出原生 `item/tool/call`，Main 解包、bridge 返回、continuation 和 SQLite projection
均正常。该兼容层不执行工具，也不修改 Codex 或 ToolBox。

## Thread 操作

### `thread/start`

VChat Session 首次发送前创建 Codex Thread。参数来自 Session 冻结快照：

- `model`、`modelProvider`；
- `cwd`；
- `approvalPolicy`、`sandbox`；
- `personality`；
- `baseInstructions`（可选，见“系统提示词/人设覆盖”）、`developerInstructions`；
- ToolBox provider config；
- experimental `dynamicTools: [vcp_invoke]`。

返回的 `thread.id` 写入 `agent_sessions.codex_thread_id`。重复 `createSession/resume` 必须复用原 Session/Thread，不得创建第二个 Thread。

### `thread/read`

用于后台对账，不是 Session 切换前置条件。`includeTurns: true` 只有在返回 Thread ID 与本地
`session.threadId` 完全一致，且所有 Turn 的 `itemsView=full` 时，才对 Codex-owned Item 的存在性具有删除权威。
`summary` / `notLoaded` 只能 upsert 已返回内容，不能删除 SQLite Item 或 ToolBox/VChat authority Block。

### `thread/fork`

编辑、从旧消息重试、分支均创建新的 Codex Thread 和新的 VChat Session。`lastTurnId` 是**包含**该 Turn 的截点，适合“保留到此处”的普通分支；编辑或重试某条消息必须使用 `beforeTurnId`，排除该 Turn 和其后的历史，再以新 `turn/start` 发送替换文本。不得直接修改 SQLite 历史并继续原 Thread。

`thread/fork` 返回的新 Thread 已有独立历史，但不能假设它会复制 VChat 的运行时 provider 绑定。fork 请求必须显式携带同一 Session 的 `modelProvider`、`config`、`cwd`、审批和可信指令；fork schema 不接受 `dynamicTools`。持久化新 Session 后，`toolbox-only` Profile 还要执行一次 `thread/resume` 建立当前连接的 live subscription 并重新应用 resume-safe policy，再开始第一个 `turn/start`。这不是重启恢复，而是本 Profile 的运行时绑定步骤；不得跳过。

### resume/restart

进程重启后，VChat 在下一次写入前使用已保存 `threadId` 调用
`thread/resume { threadId, excludeTurns: true }`，以重新建立该 App Server 连接的 live 订阅；
SQLite 仍由后台 `thread/read` 对账，不能用 resume 返回的 turns 覆盖它。

Codex 在首个 Turn 前会创建尚未 materialize 到 rollout 的空 Thread。若 `thread/resume` 明确返回
`no rollout found` 且 SQLite 没有任何 Message/Block，VChat 可用同一冻结配置新建并重新绑定 Thread；
这不代表恢复上下文，因为没有任何持久上下文存在。只要 SQLite 有持久内容，Thread missing 必须标为
orphaned、只读保留历史，绝不静默 `thread/start` 替代。超时、进程退出、网络/配置错误只记录 sync
error，绝不标 orphaned。

## Turn 操作

- `turn/start`：必须携带 `threadId`、`clientUserMessageId` 和规范 `UserInput[]`。
- `turn/steer`：必须携带 `expectedTurnId`，防止插入错误 Turn；它修改当前 Turn，不创建新的 Turn。
- `turn/interrupt`：只取消指定 `threadId + turnId`。App Server、Responses 请求、动态 ToolBox call 和该 Turn 的审批/交互分别取消，最终只有匹配的 `turn/completed(status=interrupted)` 才能把 UI 标为已停止。

VChat 的 Turn 控制合同始终包含完整 Session/Turn identity：

```text
steer      { sessionId, turnId, prompt, submissionId }
follow-up  { sessionId, afterTurnId, prompt, submissionId }
cancel     { sessionId, turnId }
```

`submissionId` 只用于同一次 IPC/按钮重复提交的幂等保护；相同文本使用不同 submission 可以被用户明确排队多次。follow-up 先进入 VChat 持久队列，只有收到匹配 `afterTurnId` 的 `turn/completed` 且 Thread 已确认 idle 后才调用下一次 `turn/start`。未知、重连中或仍 active 的 Thread 不得 drain。ACK 后崩溃的 `dispatching` 输入必须以 `clientUserMessageId` 经 `thread/read` 对账，不能自动重放。

`turn/completed` 只有在其 Turn ID 等于当前 active Turn 时才能结束运行态、应用 pending config 和 drain follow-up；旧 Turn 的迟到事件只能更新旧投影。

Codex 0.146 可能先发送 `thread/status/changed(idle)`，后发送 `turn/completed`。因此 Thread status
只更新 `observedThreadStatus`；它不能清除 `activeTurnId`、确认停止、应用配置或 drain follow-up。

文本输入包含 `text_elements: []`。图片使用 `image/localImage`，音频使用 `audio/localAudio`，普通文件使用受控 mention/descriptor；文件 path/Base64 不写入 transcript localStorage。

## Notification 投影

| Notification | Projection 行为 |
|---|---|
| `turn/started` | Session runtime 标记 running，记录 active turn。 |
| `item/started` | 以 `item.id` 创建 Message + Block。 |
| `item/agentMessage/delta` | 原地追加 text Block。 |
| `item/reasoning/summaryTextDelta` | 原地追加 reasoning summary Block。 |
| `item/reasoning/textDelta` | 原地追加 reasoning detail Block。 |
| `item/plan/delta` | 更新 observation/plan Block。 |
| `item/commandExecution/outputDelta` | 更新 tool Block 输出。 |
| `item/completed` | 以最终 Item 覆盖/封口状态。 |
| `turn/completed` | runtime 标记 idle，记录 reconcile waterline。 |
| `thread/status/changed` | 更新后台 Session 状态，不切换当前视图。 |
| `thread/tokenUsage/updated` | 已接入 Session usage：`last` 作为最近一轮/当前上下文锚点，`total` 作为会话累计，`modelContextWindow` 作为水位上限。 |

SQLite 更新成功后，Main 只发送 revision-based `AgentProjectionPatch`。Patch 携带 Session/Thread identity、
`baseProjectionRevision`、`projectionRevision` 和 V2 Block upsert/delete；Renderer 不消费旧
`projectionMessage`，也不在每个 token 调用 `thread/read`。revision 跳号或 identity 不匹配时丢弃增量并
重新读取该 Session 的完整 SQLite Projection。

0.146 reasoning 的 `summaryIndex` 与 `contentIndex` 属于同一个 reasoning Item 的两个独立数组，不能共用
Block ordinal。`dynamicToolCall.itemId === callId` 只适用于 Codex Item/call identity；JSON-RPC request ID、
Bridge request ID 和 Responses request ID 始终独立。

## Server Request 路由

| Method | 所有者 | 当前状态 |
|---|---|---|
| `item/tool/call` | ToolBox bridge | 已接基础路由；必须返回 `contentItems + success`。 |
| `item/commandExecution/requestApproval` | Codex native approval UI | fake 测试通过，真实验收待做。 |
| `item/fileChange/requestApproval` | Codex native approval UI | fake 测试通过，真实验收待做。 |
| `item/permissions/requestApproval` | Codex native approval UI | hermetic 已接线；只允许原请求权限，scope 仅 turn/session，拒绝返回空 profile。真实触发待验收。 |
| `item/tool/requestUserInput` | Workbench interaction UI | hermetic 已接线；多问题、单选/其他、文本和 secret password，超时返回空答案。真实触发待验收。 |
| `mcpServer/elicitation/request` | Codex native/MCP UI | hermetic 已接线；typed/OpenAI form 与 URL 显式打开，accept 与打开链接分离。真实触发待验收。 |
| auth/attestation requests | Codex host integration | 未实现，不得返回伪成功。 |

所有 request 按 `source + JSON-RPC id` 精确响应，不按“最近事件”或选中 Session 匹配。Main
内存中的 Interaction Registry 负责 exactly-once、限长、脱敏、自动超时和 crash/close fail-closed；
密码、表单答案和授权内容不进入 Projection SQLite 或 localStorage。

## 系统提示词/人设覆盖

Codex 自带模型级 system prompt，例如 `core/gpt_5_codex_prompt.md` 以
“You are Codex, based on GPT-5...” 开头，`models-manager/prompt.md` 为默认回退
（“You are a coding agent running in the Codex CLI...”）。问“你是谁”时模型因此自称 Codex。

注入链（Codex source）：

1. `thread/start`/`thread/resume` 的 `baseInstructions` → app-server
   `build_thread_config_overrides` → core `config.base_instructions`；
2. `config.base_instructions` 一旦非空，`models-manager` 会用其**替换** model 的
   `base_instructions` 并清空 `model_messages.instructions_template`（即“You are Codex”
   模板）；否则用模型默认模板（`get_model_instructions` 再按 `personality` 填充占位符）；
3. 最终作为 system/developer message 进入模型请求。

要点：

- `vchat-identity` 模式用 `baseInstructions` 替换身份；不同时发送 personality/developerInstructions。
- `codex-managed` 模式不传 `baseInstructions`，允许 Codex 0.146 使用内置身份、personality 与附加 developerInstructions。
- Agent catalog 的 `systemPrompt`（例如 `{{Nova}}`）就是 VChat 身份，且 `{{Nova}}`
  这类占位符由 VCPToolBox 端展开。因此 `_configSnapshot` 把 `systemPrompt` 映射到
  `baseInstructions`，而不是 `developerInstructions`——否则它只会被追加、压在内置模板之下，
  仍回 Codex 自述。显式 `baseInstructions` 优先于 `systemPrompt`；显式
  `developerInstructions` 保留为独立的追加提示。
- Workbench `agentSessionCreate` 只传 Agent identity；Main 从 Profile 冻结完整配置。Profile 文件中的 `systemPrompt` 由配置 descriptor 规范化为 `baseInstructions`。
- `thread/start` 与 `thread/resume` 都透传 `baseInstructions`，`thread/fork` 继承源
  Thread，无需重传。
- VChat 的 Nova/ToolBox Session 使用 `executionProfile=toolbox-only`。新 Thread 固定请求
  experimental `environments: []`，并通过 Thread `config` 请求禁用 update_plan、
  request_user_input、web search、MCP、collaboration/multi-agent、apps/plugins、memory 和其他
  非 VCP utility surface；`dynamicTools` 固定只注册 `vcp_invoke`。这些 App Server 参数是
  defense-in-depth，不能单独作为工具面收据，因为当前 Codex CLI `0.146.0` 的真实 provider
  request 仍可能包含部分原生/MCP/utility definitions。
- 真正的模型可见工具边界位于 VChat-owned loopback Responses adapter：在转发到 ToolBox
  `/v1/chat/completions` 前，它只保留名字精确为 `vcp_invoke` 的 function definition，丢弃
  shell、view_image、update_plan、MCP、multi-agent 等所有其他 definitions。真实 App Server
  adapter 测试必须断言上游请求的 tool name 集合**恰好**为 `[vcp_invoke]`。这不是提示词约束，
  也不需要 fork Codex 或修改 ToolBox。
- Adapter 按已知 Thread/Session 回查 `instructionMode`。VChat 模式只注入冻结的 `baseInstructions`；Codex 管理模式只接受持有进程内 loopback capability 的 App Server 指令并限制为 64 KiB。Renderer 或未知 Thread 不能提供指令。
- Session 保存的 `reasoningEffort` 只有在 `/v1/models` metadata 明确广告时才会进入下一次 `turn/start.effort`；Adapter 只映射实际收到的 Responses effort，不按模型名称猜测。
- `thread/resume` 不能重新选择 execution environment。旧 Thread 若创建时曾带 Codex 原生
  environment，只能标记为 `codex-native-legacy`，不能伪装成 App Server 内部环境已收缩；
  adapter 仍会限制其后续 Nova 请求只看见 `vcp_invoke`。要同时获得 App Server 侧的
  defense-in-depth，必须新建 Session/Thread。
- 历史快照若错误地保存为 `developerInstructions={{AgentName}}`，Main 会在 identity 精确匹配时
  一次性迁移到 `baseInstructions`。任意 developer instruction 不会被自动提升为系统身份。

## 动态工具

VChat 注册一个 flat function tool：`vcp_invoke`。输入至少包含目标 `tool` 和 `arguments`。App Server 发出 `item/tool/call {threadId, turnId, callId, namespace, tool, arguments}` 后，Main 生成稳定 bridge request identity 并转发。使用 flat function 是为了兼容 Codex CLI 0.146 的 `DynamicToolSpec::Function` 与 ToolBox 现有执行入口；不引入第二套 catalog。

动态工具不是审批请求。它不能出现在原生 Codex approval 列表中。bridge 返回后必须使用原始 JSON-RPC request id 响应一次。

Responses → Chat 历史转换必须保持一次 assistant 输出的原子性：相邻的并行
`function_call` 合并为同一条 assistant `tool_calls`，此前的公开 reasoning、可见正文和
工具调用也必须合并回同一条 assistant message。`deepseek-*` 经 Console Go 续写工具结果时
要求该消息保留 `reasoning_content`，缺失会返回 `invalid_request_error`。孤立、重复或无法
绑定的 `call_id` 在 VChat adapter 边界 fail-closed，不转发给 ToolBox；该兼容逻辑不需要修改
VCPToolBox。

## 当前协议缺口

- 版本低于 `0.146.0`、版本线不是 `0.146` 或无法识别 Codex `userAgent` 时 fail-closed；`thread/start` 拒绝 `dynamicTools` 时原样失败，不降级为没有 `vcp_invoke` 的隐藏兼容模式。
- 未覆盖真实双 Thread streaming/crash/restart。
- permissions、user input、MCP elicitation 已有 hermetic response/UI 闭环；真实 Codex/MCP 请求仍未验收。
- token usage、raw resource、warning 的规范 Block 映射未完成。
- VChat loopback Responses adapter 已有 hermetic fixture；真实 Nova/ToolBox live 必须额外断言
  “你是谁”返回 Nova 且不含 Codex，不能再以随机 sentinel 或非空回复代替身份验收。
## Skills

The pinned `0.146.0` experimental schema exposes `skills/list`, `skills/extraRoots/set`,
`skills/config/write`, `skills/changed`, and native `UserInput { type: "skill", name, path }`.
VChat uses `skills/list` for workspace-aware discovery and the native Skill input for explicit
`$skill-name` invocation. It does not use `skills/config/write` for Agent or Session policy because
that method is process/user configuration, not a Thread-isolated whitelist.
