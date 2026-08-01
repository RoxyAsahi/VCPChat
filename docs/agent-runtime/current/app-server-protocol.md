# Codex App Server 协议适配

## 传输

当前使用 `codex app-server --listen stdio://` 的 JSONL 协议，不使用 ACP，不使用 `codex exec --experimental-json`，不读取 Codex 内部 rollout 文件。

启动解析顺序：

1. `VCP_CODEX_APP_SERVER`；
2. `CODEX_APP_SERVER_EXECUTABLE`；
3. VChat 设置中的 `agentRuntime.codex.executable` / `codexAppServerPath`；
4. Windows `where codex-app-server`；
5. Windows `where codex` / PATH。

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

必须保存但不得记录敏感信息：executable source、PID、CLI version、initialize result/capabilities。当前最低兼容版本为 Codex `0.124.0`；无法从 `userAgent` 识别版本或版本过低时立即停止进程。初始化超时、非法 JSON、未知 envelope、进程退出或版本不兼容均拒绝启动，不回退旧 Rust daemon。

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

用于后台对账，不是 Session 切换前置条件。`includeTurns: true` 返回的 Turn/Item 是重建 SQLite projection 的权威输入。

### `thread/fork`

编辑、从旧消息重试、分支均创建新的 Codex Thread 和新的 VChat Session。可用 `lastTurnId` 限定 fork 截点。不得直接修改 SQLite 历史并继续原 Thread。

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
- `turn/steer`：必须携带 `expectedTurnId`，防止插入错误 Turn。
- `turn/interrupt`：只取消指定 `threadId + turnId`。

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
| `thread/tokenUsage/updated` | 待接入 usage Block/状态，不得伪造 ToolBox usage。 |

SQLite 更新成功后，Main 发送包含单个 `projectionMessage` 的 keyed patch。Renderer 不在每个 token 调用 `thread/read`。

## Server Request 路由

| Method | 所有者 | 当前状态 |
|---|---|---|
| `item/tool/call` | ToolBox bridge | 已接基础路由；必须返回 `contentItems + success`。 |
| `item/commandExecution/requestApproval` | Codex native approval UI | fake 测试通过，真实验收待做。 |
| `item/fileChange/requestApproval` | Codex native approval UI | fake 测试通过，真实验收待做。 |
| `item/permissions/requestApproval` | Codex native approval UI | 未实现，当前应 fail-closed。 |
| `item/tool/requestUserInput` | Workbench interaction UI | 未实现，当前应 fail-closed。 |
| `mcpServer/elicitation/request` | Codex native/MCP UI | 未实现，当前应 fail-closed。 |
| auth/attestation requests | Codex host integration | 未实现，不得返回伪成功。 |

所有 request 按 JSON-RPC `id` 精确响应，不按“最近事件”或选中 Session 匹配。

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

- `developerInstructions` 只是**追加**一条 developer 消息，不覆盖模板，所以它无法压制
  “我是 Codex”自述。
- `personality` 只替换模板里的占位符，同样不改变身份宣告。
- 要替换身份，必须传 `baseInstructions`（VChat 的人设全文）；传了它之后
  `personality`/`developerInstructions` 都不再需要。
- Agent catalog 的 `systemPrompt`（例如 `{{Nova}}`）就是 VChat 身份，且 `{{Nova}}`
  这类占位符由 VCPToolBox 端展开。因此 `_configSnapshot` 把 `systemPrompt` 映射到
  `baseInstructions`，而不是 `developerInstructions`——否则它只会被追加、压在内置模板之下，
  仍回 Codex 自述。显式 `baseInstructions` 优先于 `systemPrompt`；显式
  `developerInstructions` 保留为独立的追加提示。
- workbench `createSession`/`createTopic` 必须透传选中 Agent 的 `systemPrompt`；否则
  `{{Nova}}` 根本不进入任何 `thread/start` 参数，Codex 仍用内置 “You are Codex”。
- `thread/start` 与 `thread/resume` 都透传 `baseInstructions`，`thread/fork` 继承源
  Thread，无需重传。
- VChat 的 Nova/ToolBox Session 使用 `executionProfile=toolbox-only`。新 Thread 固定请求
  experimental `environments: []`，并通过 Thread `config` 请求禁用 update_plan、
  request_user_input、web search、MCP、collaboration/multi-agent、apps/plugins、memory 和其他
  非 VCP utility surface；`dynamicTools` 固定只注册 `vcp_invoke`。这些 App Server 参数是
  defense-in-depth，不能单独作为工具面收据，因为当前 Codex CLI `0.124.0` 的真实 provider
  request 仍可能包含部分原生/MCP/utility definitions。
- 真正的模型可见工具边界位于 VChat-owned loopback Responses adapter：在转发到 ToolBox
  `/v1/chat/completions` 前，它只保留名字精确为 `vcp_invoke` 的 function definition，丢弃
  shell、view_image、update_plan、MCP、multi-agent 等所有其他 definitions。真实 App Server
  adapter 测试必须断言上游请求的 tool name 集合**恰好**为 `[vcp_invoke]`。这不是提示词约束，
  也不需要 fork Codex 或修改 ToolBox。
- `thread/resume` 不能重新选择 execution environment。旧 Thread 若创建时曾带 Codex 原生
  environment，只能标记为 `codex-native-legacy`，不能伪装成 App Server 内部环境已收缩；
  adapter 仍会限制其后续 Nova 请求只看见 `vcp_invoke`。要同时获得 App Server 侧的
  defense-in-depth，必须新建 Session/Thread。
- 历史快照若错误地保存为 `developerInstructions={{AgentName}}`，Main 会在 identity 精确匹配时
  一次性迁移到 `baseInstructions`。任意 developer instruction 不会被自动提升为系统身份。

## 动态工具

VChat 注册一个 flat function tool：`vcp_invoke`。输入至少包含目标 `tool` 和 `arguments`。App Server 发出 `item/tool/call {threadId, turnId, callId, namespace, tool, arguments}` 后，Main 生成稳定 bridge request identity 并转发。使用 flat function 是为了兼容当前 Codex CLI 0.124 的动态工具 schema；不引入第二套 catalog。

动态工具不是审批请求。它不能出现在原生 Codex approval 列表中。bridge 返回后必须使用原始 JSON-RPC request id 响应一次。

## 当前协议缺口

- 版本低于 `0.124.0` 或无法识别 Codex `userAgent` 时 fail-closed；`thread/start` 拒绝 `dynamicTools` 时原样失败，不降级为没有 `vcp_invoke` 的隐藏兼容模式。
- 未覆盖真实双 Thread streaming/crash/restart。
- 未完整处理 permissions、user input、MCP elicitation。
- token usage、raw resource、warning 的规范 Block 映射未完成。
- VChat loopback Responses adapter 已有 hermetic fixture；真实 Nova/ToolBox live 必须额外断言
  “你是谁”返回 Nova 且不含 Codex，不能再以随机 sentinel 或非空回复代替身份验收。
