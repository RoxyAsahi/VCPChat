# Agent 身份与模型工具面

状态：实现已进入 VChat checkpoint `29c2068a`。2026-07-31 的 Nova live 测试运行于此前 working tree，
Codex CLI `0.124.0` / source `f0c30e528a`，ToolBox `324a659f`；checkpoint 后尚未重跑，因此本页仍不是
`live verified` 收据。

## 问题与根因

旧实现把 Agent catalog 的 `systemPrompt`（Nova 为 `{{Nova}}`）写进
`developerInstructions`。Codex 的 developer instructions 只会追加到内置提示词之后，不能替换
“You are Codex”，因此真实回复仍可能是“我是 Codex”。

同时，`thread/start.dynamicTools=[vcp_invoke]` 只会增加 VCP dynamic tool，不会自动删除 Codex
原生 shell、view_image、update_plan、MCP 或 multi-agent definitions。仅靠提示词要求“不要使用这些
工具”不是安全边界。

## 最终双层做法

```text
Agent catalog systemPrompt
  -> Session configSnapshot.baseInstructions
  -> thread/start 或 thread/resume
  -> 替换 Codex 内置身份

Codex Responses request（可能仍含原生工具 definitions）
  -> VChat loopback Responses adapter
  -> 精确 allowlist：只保留 vcp_invoke
  -> ToolBox /v1/chat/completions
  -> Nova 实际看到的工具集合恰好为 [vcp_invoke]
```

第一层解决“你是谁”；第二层解决“模型实际知道并能选择哪些工具”。两层都位于 VChat 的 Codex
黑盒接入边界，不 fork Codex，也不修改 ToolBox。

## 身份写入规则

新 Session 的冻结快照规则：

1. 显式 `baseInstructions` 优先；
2. 否则使用 Renderer 传入的 Agent `systemPrompt`；
3. Main 再以 `agentsDir` 中的真实 Agent config 作为权威补全；
4. 非 `codex` Agent 最终仍没有 `baseInstructions` 时，返回 `AGENT_IDENTITY_MISSING`，禁止带着
   Codex 默认身份启动；
5. `developerInstructions` 仅保留为明确的附加指令，不再承担 Agent 身份。

Workbench 设置页同样优先展示 `configSnapshot.baseInstructions`，避免 UI 显示的提示词与实际
Thread 配置不一致。

## 旧 Session 安全迁移

Main 在读取或恢复 Session 时执行窄迁移：

| 旧快照 | 处理 |
|---|---|
| `baseInstructions` 为空，`developerInstructions={{Nova}}`，且 placeholder 与 Session Agent/目录名称精确匹配 | 移到 `baseInstructions`，清空 developer 字段，写入 `identityMigrationVersion=1`。 |
| base/developer 都为空，Agent 目录存在真实 `systemPrompt` | 从 Agent config 补入 `baseInstructions`。 |
| developer 是任意自然语言附加指令 | 不自动提升，不猜测其身份语义。 |
| 历史消息已经写入“我是 Codex” | 不删除、不改写历史；修复只影响后续 Turn。 |

迁移持久写回 Agent Projection SQLite。它不修改 Codex rollout，也不伪造新的 Thread。

## ToolBox-only 执行策略

新 ToolBox Session 的 `executionProfile` 固定为 `toolbox-only`：

- `thread/start.environments=[]`；
- `dynamicTools` 只注册 `vcp_invoke`；
- Thread config 请求禁用 update_plan、request_user_input、web/MCP、collaboration、apps/plugins、
  memory 等非 VCP surface；
- VChat loopback adapter 对最终发给 ToolBox 的 `tools` 再做精确 allowlist，只接受
  `name === "vcp_invoke"`。

真实 Codex CLI `0.124.0` 证明：即使 App Server 接受上述 Thread 参数，它生成的 provider request
仍可能包含原生/MCP/utility definitions。因此 App Server 参数只能算 defense-in-depth；adapter
allowlist 才是 Nova 模型可见工具面的权威门槛。

旧 Thread 无法通过 `thread/resume` 重新选择 execution environment，故标记为
`codex-native-legacy`，不能声称 App Server 内部环境已被移除。不过，只要它使用 ToolBox provider，
adapter 仍会确保后续模型请求只看见 `vcp_invoke`。需要完整双层边界时应新建 Session。

## 代码位置

- `modules/codex-runtime/runtimeManager.js`
  - Agent config 解析；
  - `systemPrompt -> baseInstructions`；
  - 旧 Session 迁移；
  - `executionProfile` 与 Thread defense-in-depth 参数。
- `modules/codex-runtime/toolboxResponsesAdapter.js`
  - Responses/Chat 转换；
  - 发往 ToolBox 前的 `vcp_invoke` 精确工具 allowlist。
- `modules/ui-system/agent-workbench.js`
  - 新 Session 传入选中 Agent `systemPrompt`；
  - 设置页显示实际 `baseInstructions`。

## 不可替代的测试

Hermetic/真实 App Server：

```powershell
npm run test:codex-runtime-manager
npm run test:codex-toolbox-responses-adapter
npm run test:codex-app-server-adapter-real
```

关键断言：placeholder 迁移、任意 developer 指令不误迁移、`environments=[]`、真实 Codex provider
request 经 adapter 后工具集合恰好为 `[vcp_invoke]`，并能完成 dynamic call continuation。

真实 Nova 身份：

```powershell
$env:VCP_CODEX_LIVE='1'
$env:VCP_TOOLBOX_URL='http://127.0.0.1:6005'
$env:VCP_TOOLBOX_API_KEY='123456'
$env:VCP_CODEX_LIVE_MODEL='gpt-5.6-luna'
$env:VCP_CODEX_LIVE_BASE_INSTRUCTIONS='{{Nova}}'
npm run test:codex-nova-live
```

该 gate 必须断言：身份回复包含 Nova、不含 Codex；随机 sentinel、restart/resume、fork 和 interrupt
全部完成。2026-07-31 已在上述 revisions 上通过。

## 运行注意事项

Electron Main 持有 Runtime Manager。修改本链路后必须从系统托盘彻底退出 VChat，再重新启动；只关
闭窗口不会加载新代码。新建 Session 直接使用新规则；打开旧 Session 时才会触发安全迁移。

本修复不代表整个 Agent 产品完成。真实 DistributedServer `FileOperator`、双 Thread 长任务、审批
恰好一次和断线恢复仍按 [test-matrix.md](test-matrix.md) 验收。
