# VCPChat GUI 当前开发状态

最后审计：2026-07-29。适用分支：`codex/vcpchat-rust-agent`。

这是 GUI 的**真实现状记录**，不是目标设计，也不是发布说明。当前工作树包含尚未提交的 UI、Rust Agent、打包和文档改动，`dist/` 也是本地生成物；因此不能把它当作可复现的发布基线。

> **2026-07-29 GUI/Runtime 收敛决定**：`rust/` 是本仓库唯一正式 Agent Runtime 源码。Agent Workbench 必须把 `vcp-agentd` 当作黑盒 Runtime（类似宿主接入 SDK），而非在 Main、renderer store 或 localStorage 中复制 Session、Topic、Turn 和 transcript 业务状态。完整边界见 [Rust daemon 与 Agent GUI 收敛决策](agent-runtime/gui-daemon-integration.md)。此前的返工主要发生在这些重复投影层；Rust Core、ToolBox bridge、Topic、取消、压缩和审批 binding 均为有效成果。

> 2026-07-29 集成锚点更新：Rust Core 源码于 2026-07-29 以 `rust/` 直接目录并入本 repo，`vendor/vcp-agent` submodule 已删除；使用 `npm run build:daemon` 从 `rust/Cargo.toml` 编译，`ready.buildRevision` 锚定最后一个触碰 `rust/` 的 git commit。

## 当前验收矩阵

| 层面 | 当前状态 | 唯一有效门槛 |
| --- | --- | --- |
| Rust Core / daemon / Topic / GUI adapter | 已 hermetic 验证 | `npm run test:e2e`（hermetic，需先 `build:daemon`）；live 验收使用 `npm run test:e2e:live`（需 `VCP_AGENT_LIVE=1` + ToolBox 可达）。 |
| 手动压缩 | 已接真事件，不再返回假摘要 | 只在 `context.compaction.completed` 后刷新 Rust Topic；失败、超时或 crash 必须失败。 |
| 真实模型、工具与本地节点 | 需要受控 live 验收 | PowerShell 中先运行 `$env:VCP_AGENT_LIVE='1'`，再运行 `npm run test:e2e:live`；要求可达 ToolBox 和已连接 capability node。 |
| 工具/审批/WS 卡视觉 | 尚未产品验收 | live Electron 的卡片可见性、滚动和 680/960/1440 宽度证据仍需逐项保存。 |
| Pi/mock sidecar | 仅历史兼容 | 必须显式指定 `AGENT_RUNTIME_DRIVER=pi|mock`，不属于 Rust 产品链路。 |

## 结论先行

GUI 目前能运行主聊天，也已经能在新版 UI 中打开 Rust Agent Workbench；但整个产品仍是明显的过渡态，不能称为“新版 GUI 已完成”或“可发布”。

最重要的三件事是：

1. 新版 UI 并非独立重写，而是与经典聊天 DOM、旧事件监听和新内部应用运行时同时存在。视觉层、生命周期和保存行为因此有多套状态机。
2. Agent Workbench 的静态质量门禁已于 2026-07-28 恢复通过：样式现在限定在 `.vcp-ui-scope`，移除了 `!important` 与内联 style mutation。这个结果只说明页面重新满足设计系统的基础约束，不能代替真实 Electron 视觉、焦点和长流回归。
3. Rust Agent 的最小可用闭环已修复并实机验证：新建会话、输入解锁、Topic 恢复和历史显示都能工作；但 Topic 管理、队列控制、后端审批展示、完整 GUI 流式联调与发布包验收仍未完成。

## 真实架构

```text
main.html + renderer.js + modules/event-listeners.js
  ├─ 经典主聊天：Agent/群组、话题、消息、附件、设置
  ├─ Next UI 外壳：styles/ui-next.css + styles/ui-system/*
  │   └─ topTabManager：顶栏、启动器、内部应用标签、内嵌应用
  └─ 内部应用：VCPUI/nextUiApps
      └─ Agent Workbench
          └─ preload 窄接口 → Electron Main supervisor
              └─ vcp-agentd.exe → VCPToolBox
```

主聊天、全局设置和多数业务弹窗仍由旧 DOM 与 `event-listeners.js` 驱动。Next UI 主要提供主题化外壳、组件系统、顶栏/标签页和少量渐进增强；它没有替代旧聊天领域逻辑。

## 表面状态

| 表面 | 当前判断 | 已有证据 | 关键缺口 |
| --- | --- | --- | --- |
| 启动、NativeSplash、主窗口 | marker 链路已代码/二进制验证，端到端仍未验收 | 启动脚本固定 Splash 工作目录；主窗口 `show()` 后才由首实例释放 marker；渲染失败也释放 Splash；`test:startup-contract` 覆盖所有权，`test:native-splash-smoke` 已真实启动 NativeSplash 并确认 marker 使其退出 | `createWindow({deferLoad:true})` 到 `loadMainWindow()` 之间仍执行大量初始化；尚缺“启动器 → Splash → Electron 主窗口”的单一端到端冷启动、已有实例再次启动和超时自动化验证。 |
| 主聊天、助手/群组、话题侧栏 | 可用但未完成 | 隔离 Electron smoke 现预置普通 Nova Agent，已验证 Agent 列表出现、选择、创建话题与 composer 解锁/草稿输入；Next UI 做外壳和局部增强 | 没有端到端自动化覆盖删除、排序、真实消息发送、流式取消、群组与主题切换的组合。 |
| Next UI shell/顶部标签/启动器 | 部分完成，Agent 内部应用生命周期已 Electron 验证 | `topTabManager` 有内部应用 mount/unmount、标签关闭和内嵌窗口控制；VCPUI JSDOM component contract 与 UI 静态门禁通过。隔离 Electron smoke 已覆盖启动台 → Rust Agent Workbench 挂载 → 标签关闭 → 根节点移除 | 无最小窗口、内存/重复打开关闭、其他内部/嵌入式应用和 renderer reload 后内部应用恢复验证。 |
| 全局设置 | 风险较高，核心入口已 Electron 验证 | 模板 modal 重复绑定已修；新版账户区 `nextUiAccountSettingsBtn` 已接入同一设置打开流程；保存操作向 `SettingsActionBar` 发出成功/失败结果。隔离 Electron smoke 已验证：账户齿轮 → 弹窗 → 分区 → 保存 → Next UI → renderer reload | 保存流程仍跨头像、论坛配置、主 settings、Rust assistant 配置和 VCPLog 重连多个副作用；没有事务/回滚。尚未覆盖头像、论坛、Rust assistant、VCPLog 失败和键盘关闭。 |
| 主题/模式切换 | 部分完成，真源已收敛 | `uiModeManager`、Next CSS、主题入口均存在；`settings.json` 读写成功后才同步 localStorage，后者仅是首屏缓存 | 仍可能在 IPC 返回前短暂使用缓存；内部应用关闭、modal、焦点和 observer 的完整清理未验证。需要 Electron 级模式切换与外部修改配置回归。 |
| 内部应用与内嵌桌面 App | 部分完成 | `topTabManager` 管理 internal/embedded view 和 disposer | 异步打开、关闭、拖出、Renderer reload、主窗口关闭时的竞态只有代码级处理，没有 Electron 自动化或压力验证。 |
| Rust Agent Workbench | 功能核心可用，产品控制面不完整 | JSDOM Workbench/Controller、Rust adapter、daemon smoke 通过；隔离 Electron smoke 已验证从启动台挂载、共享设置的非敏感预算投影、创建会话、强杀该实例唯一的 daemon、显式重连、Topic checkpoint 恢复和标签关闭；680/960/1440px 基础骨架无文档横向溢出，侧栏、header、composer 与输入框均可见；真实 Nova + `gpt-5.6-terra` 的 FileOperator 与 PowerShellExecutor 链路已由 Rust direct live 回归验证，且 PowerShell 本地允许已完成 ToolBox→VCPChat distributed node 的 `tool.completed` 闭环。2026-07-29 重建 release daemon 后，live 回归额外断言 ToolBox 生命周期事件带非空 native `toolCallId`，防止 Workbench 不能关联工具卡。 | 本阶段明确保留现有 `start.bat` / VBS 打开方式，不把 NSIS 安装器或安装/升级迁移作为阻塞项；真实完成态工具卡、审批卡与 WS 卡在 680/960/1440px 的可见滚动和截图验收仍在收敛，不能以基础骨架布局或底层工具成功替代。ToolBox 后端审批也不公开与本地 toolCallId 的关联或最终结果。 |
| Rust Agent Topic 持久化 | 最小闭环可用 | Topic 是 Rust Store 真源；renderer 仅存 last-topic pointer；实机恢复“介绍一下自己”的 user/assistant 历史成功。catalog-only control daemon 创建的空 `topic_*` 不再列出或参与 `latest`，释放后自动清理；双 daemon 测试已验证协作接管期间保持单写者，旧 owner checkpoint/release 后新 owner 才能获取 Topic。Workbench 现会在用户发起接管后轮询 lease 状态，并自动附着到已安全释放的 Topic；JSDOM 覆盖此流程。 | 仍缺标题规范、去重、分页/搜索、清理策略和 Topic CRUD 的完整多窗口 Electron 验收。 |
| Rust daemon 随附 | 可验证 | `extraResources` 从 `rust/target/release/vcp-agentd.exe`（repo 内 `build:daemon` 产物）携带到打包资源；开发时按优先级解析：`VCP_AGENT_RUST_DAEMON_PATH` 环境变量 → 打包资源 → `rust/target/release/`，绝不回退 sibling workspace | 当前产品入口保持 `start.bat` / VBS，未把 NSIS 安装或升级迁移列为本阶段任务。`npm run build:daemon` 负责编译并输出 revision；`npm run test:e2e` 会核对 buildRevision 与 `git log -1 -- rust/` 一致。 |
| IPC/安全边界 | Agent 路径较窄，整体仍需审计 | Agent IPC 校验 Main window sender；主窗口启用 `contextIsolation:true`、`nodeIntegration:false` | 主聊天 preload 暴露大量能力；多数历史 IPC handler 未统一验证来源/参数。应单列安全收敛，不把 Agent 的窄边界误认为全 GUI 已收敛。 |

## Rust Agent GUI 的精确现状

### 已经成立

- Agent/模型选择复用主聊天的 `getAgents()` 与 `getCachedModels()`；Workbench 不直接请求 ToolBox `/v1/models`。
- Electron Main 只启动和监督 `vcp-agentd.exe --direct`；Rust Host/Core 承担模型流、`vcp_invoke`、Topic、审批等待、取消和 checkpoint。
- `sessionId` 是进程内 Session，`topicId` 是可恢复 Topic；Renderer localStorage 只记录最后一个 `topicId`。
- 2026-07-28 已修复 Rust adapter 裸数组与旧 JS `{ messages }` 包装不兼容的问题。此前 `history.json` 有内容但 GUI 显示为空；现在控制器兼容两种返回形状。

### 未成立或不能宣称完成

- Workbench 不是完整的 VCPChat Agent 产品页：活动 Turn 已支持 composer follow-up 与 `/steer`，Header 可查看、清空、编辑和移除 Rust queue 项，Core consumed 事件会刷新列表；用量面板已有真实 token 聚合但费用未知，并可通过 Rust Host 读取/保存每 Turn 请求数与 token 上限；预算仅从新建 Session 起生效；Header 可请求安全压缩；仍没有独立 consumed 历史。
- Topic 侧栏已支持空闲持久 Topic 的搜索、重命名、删除，以及占用时请求接管；重命名/删除通过 Rust daemon 的 Topic Store，而不是旧 in-memory Session API。Rust direct 双 daemon 已验证协作接管时的单写者 lease、旧 owner checkpoint/release 与新 owner 获取；GUI 会在用户明确请求后轮询并自动附着已释放 Topic，且有 JSDOM 回归。仍缺分页、批量操作、标题自动治理和真正的只读查看页。
- usage 已显示请求轮次、输入/输出/reasoning/cache/total token、上下文占比与费用未知状态；预算可配置每 Turn 请求数与 token 上限，超限确认/完整费用模型仍缺。
- 本地审批卡能允许/拒绝；`VCPlog`、`vcpinfo` 与 distributed-server 仅以只读状态卡投影。来自 `VCPlog` 的结构化 `tool_approval_request` 会显示为“后端审核请求（未关联）”，并带 ToolBox requestId、工具名与 TTL；此卡不能批准、拒绝或映射到本地 toolCallId。ToolBox 不广播最终审批结果，因此不能把任意 WS 通知解释为批准结果。
- 新页面通过 clone 主聊天按钮来复用主聊天的视觉层。流式 `assistant.delta`/`reasoning.delta` 现按稳定 message key 原地更新，并通过 animation-frame 合并控制面重绘；测试已覆盖连续 delta 下消息节点、composer、焦点和草稿不被替换。工具/审批卡的完整长流压力、真实滚动锚点和视觉矩阵仍需要 Electron 级验收。
- 2026-07-28 修复 daemon event envelope：Host 的 `sessionId`、`turnId`、`toolCallId` 原本仅在 framed 外层，而 Workbench/TUI 消费嵌套 `event`，导致真实工具事件没有稳定 `toolCallId`、工具卡不出现。daemon 现在只投影这些非敏感关联 ID 到嵌套事件，并有 Rust 回归测试；opt-in GUI `FileOperator` 回合已验证完成态卡可见。Core 也会在 snapshot ACK 前明确发布 `turn.completed`，故真实工具回合结束后 composer 回到新 Turn 语义，而不会错误改作 follow-up。

## 文档与代码不一致

`docs/agent-runtime/architecture.md` 与 `roadmap.md` 主要记录的是 Pi Worker 阶段的设计，不是当前 GUI 执行链路。当前 GUI 以 Rust daemon 为正式路径；旧 Pi/JS 路径只可作为历史回退参考。两个文档顶部已加入历史标记，GUI 状态以本文和 `agent-runtime/current-development-status.md` 为准。

## 已运行的检查

| 命令 | 结果 | 含义 |
| --- | --- | --- |
| `node scripts/test-ui-system.mjs` | 通过 | 30 个 VCPUI public component 的 JSDOM 契约通过。 |
| `node scripts/test-agent-workbench*.mjs` | 通过 | Workbench store/controller、Topic 恢复投影、新建会话 Mock 流程，以及连续流式 delta 不替换消息节点、composer、焦点或草稿均通过。 |
| `node scripts/test-rust-agent-runtime.mjs` | 通过 | GUI Rust adapter、裸数组历史、审批 binding 和单飞 transport 覆盖通过。 |
| `node scripts/test-rust-daemon-smoke.mjs` | 通过 | direct daemon 的 framed-stdio 和 `topicId` ACK 通过。 |
| `npm run test:startup-contract` | 通过 | 启动器工作目录、首实例 marker 所有权、可见后释放与失败释放的静态契约通过。 |
| `npm run test:native-splash-smoke` | 通过 | 真实 NativeSplash.exe 在独立工作目录中启动，并在 `.vcp_ready` 出现后干净退出。 |
| `npm run check:agent-runtime` | 通过 | Agent Runtime 的现有静态和 Node/JSDOM 回归通过。 |
| `npm run check:ui-system` | 通过 | Workbench 已满足 scope、无 `!important`、无业务内联 style 与组件契约门禁；尚不替代 Electron E2E。 |
| `npm run test:electron-gui-smoke` | 通过（debug daemon） | 隔离 AppData 的真实 Electron：普通 Nova Agent 的列表/选择/新话题/composer 草稿，renderer ready、Next UI 账户齿轮、全局设置导航与提交、设置持久化后的 renderer reload、启动台打开 Rust Agent Workbench、680/960/1440px 基础布局无横向文档溢出、非敏感预算投影、精确杀死本实例 daemon 后的显式重连与 Topic 恢复，以及标签关闭卸载。正式 release daemon 尚待在不被占用时重建并复验。 |
| `VCPCHAT_E2E_LIVE_TOOLBOX=1` + `VCP_AGENT_TEST_TOOL_CHOICE=required` + `npm run test:electron-gui-smoke` | 通过（debug daemon，显式 opt-in） | 从隔离 Electron Workbench 创建 Session，使用共享配置但不输出凭据，以 Nova + `gpt-5.6-terra` 完成 `FileOperator(ReadFile package.json)`；断言真实完成态工具卡、assistant 输出和终态 `turn.completed` 后 composer 回到空闲，再继续原有 crash/reconnect/Topic 恢复流程。`required` 仅作用于每 Turn 第一轮模型请求，且只允许测试环境变量启用。默认 smoke 不调用模型或 ToolBox。 |
| 上述环境变量 + `VCPCHAT_E2E_LIVE_TOOLBOX_RELOAD=1` | 通过（debug daemon，显式 opt-in） | 在真实 `FileOperator` 回合结束后重载 renderer；不使用 localStorage transcript，改由 Workbench 重新附着 Rust Topic checkpoint，断言 user/assistant 历史、runtime ready 与可用 composer 均恢复，再继续 crash/reconnect 验收。 |
| 上述环境变量 + `VCPCHAT_E2E_LIVE_TOOLBOX_HIGH_RISK=1` | 通过（debug daemon，显式 opt-in） | 在同一 Electron Workbench 请求 `PowerShellExecutor(Get-Location)`，等待本地审批卡并点击拒绝；断言该回合没有 `tool.started`，故本地拒绝不会进入 ToolBox marker 执行。它不等同于 ToolBox 后端审批通过/拒绝验收。 |
| 上述环境变量 + `VCPCHAT_E2E_LIVE_TOOLBOX_CANCEL=1` | 通过（debug daemon，显式 opt-in） | 在真实 Workbench 中提交一个 Turn 后使用空输入的发送按钮取消；断言 `turn.cancelled` 出现，runtime 与 composer 都恢复空闲。默认 smoke 不调用模型。 |
| `npm run test:rust-agent-live` | 通过（debug daemon） | 真实 ToolBox 的 Nova + `gpt-5.6-terra` 流式普通对话通过；响应中出现的 ToolBox 临时图像 key 仍保持脱敏。它验证 Host/Core 链路，不是 GUI 回合验收。 |
| `npm run test:rust-agent-tools-live` | 通过（debug daemon） | 真实低风险 `FileOperator(ReadFile package.json)` 完成；高风险 `PowerShellExecutor(Get-Location)` 到达本地审批后被拒绝，未进入 `tool.running`。ToolBox 后端最终审批仍未测试。 |
| `npm run test:rust-agent-lifecycle-live` | 通过（debug daemon） | 隔离临时 Topic 的真实模型生命周期：长任务取消、interrupted checkpoint、`latest` 恢复不自动重放，以及 seeded 长中文上下文的安全压缩通过；不调用 ToolBox 工具。 |

这些检查没有替代真实 Electron E2E：目前没有 Playwright/Electron 自动化用于启动、splash、全局设置保存、主题切换、主聊天、内部应用和 Agent 真实 ToolBox 回合。

## 推荐收敛顺序

### P0：先建立可回归的 GUI 基线

1. 保持 `npm run check:ui-system` 作为不可放宽的合入门槛；下一步为 Agent、主聊天和设置补真实 Electron 视觉/交互回归。
2. 启动流程的 marker 所有权和失败释放已经收敛；继续补 renderer health、冷启动/二次启动/超时的真实 Electron 自动化，避免把静态契约误作实机验收。
3. 全局设置的 Next UI 入口、非敏感保存和 renderer reload 已通过隔离 Electron smoke；继续补失败反馈、头像、论坛、Rust assistant、VCPLog、键盘关闭与多副作用的分阶段报告。
4. 已覆盖隔离 Electron 的主聊天 Nova 选择/新话题/composer、Next mode、打开/关闭内部应用与 renderer reload；继续补真实消息流、取消、群组、主题切换、启动器冷启动与退出清理。

### P1：把 Agent Workbench 收敛为真正产品页

1. Topic 列表已具备搜索、重命名和删除确认；Rust Store 已过滤并清理 control-plane 的空 `topic_*`，双 daemon 协作接管和 GUI 自动附着已回归。继续补多窗口 Electron 验收、标题生成、分页、同名迁移/隐藏规则与只读查看页。
2. composer 已支持 follow-up 与 `/steer`，队列可查看/清空/编辑/移除；继续决定是否需要独立的 consumed 历史与审计视图。
3. Rust usage、安全压缩、预算读取/设置和 ToolBox WS 的只读状态已投影到 GUI；结构化后端审核请求可见但故意不关联本地 toolCallId。预算 API 不返回地址或 API Key，且更新在新建 Session 后生效；仅在 ToolBox 提供关联/结果协议后才扩展后端审批状态。
4. 已完成第一阶段 keyed/incremental 流式渲染；非 delta 的完整 feed 重绘现在仅在读者原本位于底部时才跟随最新内容，上翻阅读工具结果时保留滚动锚点，已有 Workbench 回归。工具卡、ToolBox 观察卡和本地审批卡已增加窄宽度折叠、截断与有界参数滚动的基础 CSS，长参数 card 有 JSDOM 覆盖；真实 Electron 已覆盖 680/960/1440px 的基础骨架无横向溢出，下一步仍需长流工具/审批/WS 卡的压力视觉与性能证据。
5. GUI 真模型已完成低风险 `FileOperator` 回合、高风险 `PowerShellExecutor` 本地拒绝路径、用户取消、真实回合后的 renderer reload/Topic 恢复，以及真实长中文 Topic 的 GUI 压缩和 Rust checkpoint 落盘。双 Electron 实例已覆盖可见的协作 Topic 接管与自动附着。daemon crash 的隔离 Electron 端到端已用 debug daemon 覆盖；release daemon 与目录包也已 smoke。产品仍保持原 `start.bat` / VBS 打开方式。
6. Rust direct daemon 的真实多工具长任务已验证 `FileOperator(ListAllowedDirectories)` 后接 `SciCalculator(6*7)`，模型只在两个真实结果都返回后输出验收标记。该回归只响应客户端本地 preflight，绝不修改 ToolBox 后端审批文件。
7. 真实本地终端工具依赖 VCPChat 的分布式节点，而不是 Agent 自己重造 Shell：原 `start.bat` 启动 VCPChat 后，`enableDistributedServer=true` 使 Electron 主进程在 5974 启动 `VCPDistributedServer` 并向 ToolBox 注册 `PowerShellExecutor`。该节点存在时，Rust Agent 已通过“本地允许 → `PowerShellExecutor(Get-Location)` → 完成”回归；未启动 VCPChat 时 ToolBox 会明确返回 plugin-not-found，属于 capability 缺席诊断而非审批失败。
8. 隔离 Electron Workbench 的 opt-in 真链路已额外覆盖高风险“允许一次”按钮：测试实例不启动竞争的分布式监听器，而是使用原 `start.bat` 已注册的 VCPChat capability；可见本地审批卡确认后，事件依次出现 `approval.requested`、`tool.started`、`tool.completed`，composer 恢复可用。由此验证 GUI → Rust daemon → ToolBox → VCPChat distributed node 的完整执行路径。
9. 该真实完成态 `PowerShellExecutor` 工具卡已在 680、960、1440px 三种 Electron viewport 下检查：文档无横向溢出，工具卡、composer 与输入框均留在可视区域并保持正尺寸；这补上了此前只有空 Workbench 骨架的响应式证据。

### P2：消除双系统债务

1. 制定经典 UI 与 Next UI 的逐页迁移边界，不再让业务页面同时依赖两个视觉/状态系统。
2. 将 uiMode 的唯一持久来源统一为 settings.json；localStorage 只允许做无害启动缓存，且必须明确同步策略。
3. 收紧非 Agent preload/IPC：按窗口 role、sender、schema 和最小能力集治理。
4. 建立 release CI：Rust daemon release、electron-builder `extraResources` 与原 `start.bat` / VBS 启动契约验证；不将 NSIS 安装/升级迁移纳入当前阶段。

## 当前验收标准

在 P0 未完成前，禁止宣称”GUI 已重构完成”或把 Next UI 设为稳定默认。最低合入门槛应为：

```powershell
# 静态检查
npm run check:ui-system
npm run check:agent-runtime

# Hermetic E2E（需先编译 daemon）
npm run build:daemon
npm run test:e2e

# Live 验收（需 ToolBox 可达）
$env:VCP_AGENT_LIVE='1'; npm run test:e2e:live
```

再加至少一次真实 ToolBox 手工验收与工具/审批卡视觉截图。只有这些都通过，才讨论扩大 GUI 的默认启用范围。
