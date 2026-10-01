# VCPChat（zcode-ui 分支）相对上游的改动需求文档

> 用途：交给另一位 AI / 评审者做独立审核。本文只描述「做了什么、为什么、怎么验收」，
> 不替实现辩护；每一节末尾有「审核者请重点检查」，请优先按那里的问题挑错。
> 配套交接文档：`HANDOFF.md`（环境、命令、已知问题、未完成事项）。

> 2026-10-01 修复修订：原审查 F01–F14 的实现缺陷已处理，完整 UI 门禁与回归验证通过。逐项处理见 `REPAIR-REPORT.md`，原审查证据保留在 `ADVERSARIAL-REVIEW.md`；当前结果与明确的未验证范围见 `VERIFICATION.json`。

## 0. 基本信息

| 项 | 值 |
|---|---|
| 仓库 | VCPChat（Electron 44，原生 JS 渲染进程，无前端框架） |
| 当前分支链 | `pr/zcode-01-*` 至 `pr/zcode-23-review-docs`，SHA/base 见 `PR-STACK.json` |
| 上游基线 | `lioensky/VCPChat` 的固定提交 `283255750376e645ec3e355dbfb84730371014cc` |
| 被审查实现 | `325ce1c9daede619fa48d07a9c741940e89ccab6`；拆分清单见 `PR-STACK.md` |
| 原分支差异 | 130 个提交、287 个文件；含无关素材，不能作为新 PR 的提交范围 |
| 原快照新增 / 修改文件 | 231 新增、56 修改；当前修复链文件范围见 PR-STACK.json |
| 参考实现 | [zai-org/ZCode](https://github.com/zai-org/ZCode)，固定提交 `662c30bea4e833acaacbfb745a65eb09c23d55f8`；出处与许可证见 `vendor/zcode/` |
| 约束 | 保持聊天内核契约；观察式读取和必要的选中会话/IPC 挂接均要审核；真实数据只用测试副本 |

### 0.1 总目标

把 VCPChat 的主聊天界面和右侧栏，按 ZCode 桌面端的交互与视觉逻辑做一次对齐，并补齐 VCPChat 缺少的、
ZCode 里验证过的能力（侧栏标签框架、内置终端、Git 工具、调用轨迹、会话级状态面板、聊天内的快捷功能等）。
所有新能力必须接在 VCPChat 现有后端（git:* / project-forge:* / terminal / 聊天 IPC）上，用真实聊天记录验证，
而不是造一套只在演示里能跑的假数据。

### 0.2 非目标

- 不重写聊天内核（流式管线、历史持久化、话题管理）；对它们的改动只限于挂接点和 bug 修复。
- 不改 VCP 服务端协议（`<<<[TOOL_REQUEST]>>>` / `[[VCP调用结果信息汇总…]]`），只解析它。
- 不引入前端框架；ZCode 的 React + Tailwind 全部改写为原生 DOM + `styles/ui-system/*.css`。

## 1. 架构约定（审核时先看这一节）

1. **自有模块放在 `modules/ui-system/`，样式放 `styles/ui-system/`**，由 `renderer.js` 里统一 `create…()` + `mount()` + `ownedRendererSubscriptions.add({dispose})` 挂载和卸载。
2. **观察式为主**：新增 selection 订阅、发送队列、桥接和轨迹记录会接入真实执行路径，需要审核行为契约。需要读聊天内容时用 `getHistory: () => mainHistoryRef.get()` 或 MutationObserver 观察 `#chatMessages`；需要知道切换会话用 `chatManager.onSelectionChange(cb)`。
3. **门禁**（每次改动后必须通过）：
   - `node scripts/check-next-delta-contract.mjs`（相对上游的受控偏离基线；改了受保护文件要更新 `scripts/next-delta-shared-baseline.json`）
   - `npm run build:chat-event-graph` 重新生成 `docs/contracts/generated/chat-event-graph.json`，随后 `npm run check:chat-contracts`
   - `npm run lint:ui-system`（stylelint，范围 `styles/ui-system/**`）
4. **测试规则**：只写真测试——用真实聊天记录里的请求 / 结果格式、真实 IPC 形状；改动必须能让旧代码的对应用例失败。不写永远为真的断言。
5. **数据**：真实测试使用用户明确提供的历史副本；`VCPCHAT_APP_DATA_DIR` 必须为该副本的绝对路径。启动方式见 `HANDOFF.md`。

## 2. 需求清单与验收标准

### R1 右侧栏通用标签框架（side pane）

**修复状态**：F12 已修复：全局工具跨话题保留可见、折叠与活动标签状态；完整整应用多窗口/窄屏视觉复验仍未覆盖。

- 来源：`modules/ui-system/side-pane/*`、`styles/ui-system/side-pane*.css`、`preloads`、`main.html`。
- 需求：右侧栏是一个多标签容器，标签可拖拽排序、中键关闭、溢出折叠、有「最近关闭」、搜索式打开菜单（launcher）、
  标签右键菜单、键盘导航（方向键 / Enter / Esc）；宽度可拖拽调整并记忆；布局为扁平分栏（单分隔线）。
- 验收：`tests/side-pane-controller|state|resizer-owner|tab-strip|universal-provider|advanced-parity.test.mjs`；真机能打开 / 关闭 / 重排 / 恢复。
- 审核者请重点检查：状态持久化键冲突；多窗口 / 多话题下的标签归属（`syncSidePaneParent`）；窄屏下标签栏溢出。

### R2 侧栏各标签提供者

**修复状态**：F01/F05/F06/F07/F10 已修复；授权、保存竞态、diff 预算、真实消息 DOM 有回归证据，终端有实际 Windows unpacked/原生 PTY/IPC 验证。

| 标签 | 文件 | 要点 |
|---|---|---|
| 终端 | `terminalSideProvider.js`、`modules/ipc/terminalHandlers.js`、`vendor/xterm/*` | node-pty + xterm；ZCode 明 / 暗 ANSI 色板；http(s) 链接在内置浏览器标签打开；与 PowerShellExecutor 的 AI 命令运行记录互通（`terminal:command-runs`、`terminal:watch-command-runs`） |
| 浏览器 | `browserSideProvider.js`、`modules/ipc/browserHandlers.js` | 隔离的 webview；`will-attach-webview` 等做了限制（见 `tests/browser-handlers.test.js`） |
| Git | `gitSideProvider.js`、`git-graph-layout.js`、`gitHandlers.js`、`gitService.js` | 对照 ZCode GitPane：变更列表、AI 上一轮改动（来源 V工程批次）、分支切换 / 创建、提交图谱、提交 / 推送 |
| 命令输出 | `toolOutputSideProvider.js` | ZCode 风格上滚暂停 + 冻结输出 + 恢复箭头；错误可重试 |
| 计划详情 | `planDetailSideProvider.js` | V工程 todo / 文件 / 时间线 / 贡献者，实时刷新；刷新失败保留上一份并给重试条 |
| 笔记 / 代码查看器 | `notesSideProvider.js`、`codeViewerSideProvider.js` | 对接真实 notes IPC；代码块可在侧栏打开，可浏览工作区文件 |
| 调用轨迹 | `modelTrajectory*.js`、`modules/modelTrajectory.js`、`modules/ipc/modelTrajectoryHandlers.js` | 见 R6 |
| 侧聊 | `modules/chat/sideChatSessionService.js`、`modules/renderer/sideChatSurfaceOwner.js`、`modules/ipc/sideChatHandlers.js` | 临时会话（不创建 agent 话题）、冻结父上下文继承、选区引用、真实模型列表、与主聊天未读隔离 |

- 验收：对应 `tests/side-pane-*.test.mjs`、`side-chat-*.test.mjs`、`terminal-handlers.test.js`、`browser-handlers.test.js`、`side-pane-git-real-backend.test.mjs`。
- 审核者请重点检查：IPC 输入与 sender 授权分别复核，侧聊 marker/归属及 junction 校验不能省略；node-pty 已列入 `asarUnpack`，PowerShellExecutor/GUI/AdminConfirm 运行闭包已纳入打包并经实际产物验证；webview 的 `will-navigate` / 下载策略。

### R3 会话状态面板（右上角浮层）

**修复状态**：F04 已修复：最新 generation 才能提交结果，操作捕获 workspace；命令作用域明确为文本关联。

- 文件：`modules/ui-system/conversation-status-panel.js`、`conversation-scope.js`、`styles/ui-system/status-panel.css`。
- 需求：对照 ZCode `ConversationStatusPanel`：Git 工具（更改 +N −N / 分支切换 / 提交或推送）、进程（V工程 todo，超 6 项折叠为三条窗口）、命令（最近 30 分钟、最多 4 条）；可收起为胶囊；
  **面板跟随当前会话**：只显示当前话题聊天记录里用到的 V工程（及其所在工作区的 Git）和与该话题命令文本关联的 PowerShellExecutor 记录；没有则整块隐藏；切换话题 / 助手立即清空并重取；聊天区变化后（历史加载、新工具调用）重新判断。
- 验收：`tests/conversation-status-panel.test.mjs`（含 4 个跟随会话用例）、`tests/conversation-scope.test.mjs`；真机验收应使用一个包含 ProjectForge 的测试话题，切换到无工程话题及其他助手，加入 A 慢/B 快的并发场景（F04）。
- 已知取舍（需要审核者给意见）：
  1. 没碰过 V工程的话题没有 Git 入口（只能从侧栏 Git 标签进）。ZCode 每个 session 有 cwd，VCPChat 话题没有工作目录概念。
  2. 命令仅去首尾空白后按文本匹配话题，保留内部空白、引号和换行。终端记录没有 topicId；相同文本可能来自其他话题，界面标为“命令（文本关联）”。
  3. `getHistory` 不传时回退到旧的全局行为（给旧测试和潜在其他挂载点留的兼容路径）。

### R4 主聊天内的功能（均来自 ZCode，原生 DOM 改写）

**修复状态**：F08/F09/F11/F13 已修复：逐条可信宿主确认、持久化接收确认与去重、保守文件结果配对、统一 selection 通知。

| 功能 | 文件 | 说明 |
|---|---|---|
| 问题定位条 | `conversation-turn-navigator.js` | 左缘「山形」悬停条 + 预览卡 + 点击跳转；长话题跳转后不回弹到底部（`chat-scroll-release.js`） |
| 回复耗时 / 短时间标签 | `message-meta-enhancer.js` | 今天 / 昨天 / 今年 / 更早；完整时间在 tooltip |
| 对话内查找 | `conversation-find.js` | Ctrl+F，匹配高亮，Enter / 方向键导航 |
| 划词引用 | `selection-quote-action.js` | 引用选区到输入框；发送后渲染为 blockquote（含引号 / 行内代码 / 粗体） |
| 建议提示词 | `draft-suggested-prompts.js` | 新建话题的空状态里的建议 chip |
| 斜杠命令 | `slash-commands.js` | `/new /side /find /search /trace /export /settings /theme`；命令输出/计划详情入口在命令中心，斜杠表未提供 |
| 发送队列 | `send-queue.js` | 流式回复期间排队、重排、编辑、立即发送、暂停 / 恢复；localStorage 持久化，恢复后为暂停态 |
| 命令中心 | `command-center.js` | Ctrl+K：命令 / 会话 / 工作区文件 |
| 消息导出 | `message-export.js` | 选择消息导出 Markdown（复制或保存） |
| 本轮变更文件摘要 | `message-file-changes.js`、`git-file-diff.js` | 解析 FileOperator **与 ProjectForge** 调用（真实状态是 `✅ SUCCESS` / `❌ ERROR`）；+N −N 取自工作区 Git，点击在 Git 标签看 diff；PowerShell 写入的文件刻意不解析 |
| HTML 预览宿主桥 | `modules/renderer/widgetBridge.js` | 给 HTML 预览一个 `window.vcp` 小桥 |

- 验收：同名 `tests/*.test.mjs`，其中 `message-file-changes-projectforge.test.mjs` 的样例取自真实 ProjectForge 输出。
- 审核者请重点检查：`message-file-changes.js` 的解析在 `ROLE_DIVIDE` 嵌套 / 多工具并发 / 失败重试下的误报；`send-queue` 持久化与话题切换的竞态；`selection-quote-action` 对流式中消息的重渲染。

### R5 主聊天外围 UI 对齐

**修复状态**：F14 已修复，完整 check:ui-system 通过。CSS/token/字号、动态样式 owner 与外观契约已经校正；真实语音和跨平台视觉仍未复验。

- 顶栏 / 头部按钮规格、侧栏密度、dock 菜单、令牌（`styles/ui-system/tokens.css`）、通知面板重建为分组可滚动卡片（`modules/notificationCenter.js`、`notification-center.css`）、笔记窗口迁移到 `styles/app-surfaces/*`。
- 输入区：语音输入重构（活动条、本地 SenseVoice 模式、麦克风设备选择，`tests/dsh-voice-interaction.test.js`）、左侧 AI 模型选择器、Tavern「高级回复」入口移到加号菜单。
- 审核者请重点检查：`main.html` 的结构改动，主题（亮 / 暗）下的对比度；语音在非 Windows 平台的降级（提交信息写明有跨平台保护，但未在非 Windows 实测）。

### R6 模型调用轨迹

**修复状态**：F02/F03 已修复：递归净化、有界输入与异步存储、默认关闭、显式启用确认、自动保留策略；正文仍可能包含用户主动输入的敏感文本。

- 文件：`modules/modelTrajectory.js`（记录器）、`modules/ipc/modelTrajectoryHandlers.js`、`preloads/api/modelTrajectory.js`、`side-pane/modelTrajectoryModel.js|SideProvider.js`。
- 需求：主聊天、群聊成员和标题生成模型调用形成轨迹；真实应用默认停止记录，用户在查看器确认后启用。请求与响应按预算裁剪（不是无限保存全文），元数据递归净化，正文可能含用户输入的敏感信息。会话文件使用 hash 名称避免 item/topic 名称碰撞；单字段最多 20 万字符、单条最多 1 MiB、单文件最多 16 MiB、写入队列最多 16 MiB；异步尾读、串行原子写、清空/禁用 generation 隔离。默认 7 天、64 MiB 总量保留策略；列表最近 200 条并说明截断。token 缺失时粗估并标 estimated。
- 最近修复：服务端把错误当作普通流返回（文本以 `[ERROR]` 开头且 finishReason 为空 / stop）时，标签显示「服务端报错」而不是「正常结束」。
- 验收：`tests/model-trajectory-recorder|model|handlers.test.*`、`side-pane-model-trajectory.test.mjs`。
- 审核者请重点检查：秘密键递归过滤、getter/原型排除与请求聚合预算；检查启用确认、清空/禁用竞态、容量和自动过期。messages 正文并未保证秘密检测，不能宣称全文永不含密钥。

### R7 Git 后端扩展

**修复状态**：真实临时 Git 仓库回归通过，主窗口/确切应用页/主 frame 身份校验已收紧。

- `modules/services/gitService.js` + `modules/ipc/gitHandlers.js` 新增：`git:list-branches`、`git:switch-branch`、`git:create-branch`、`git:commit-graph`、`git:change-summary`、`git:reveal-path`；主聊天页可调用 git IPC；`tests/git-service.test.js` 扩充。
- 审核者请重点检查：分支名 / 路径的参数注入（是否一律走 `execFile` 数组参数）；切换分支被本地改动阻挡时的错误解析。

### R8 PowerShellExecutor 命令运行记录

**修复状态**：raw 输出限额与截断提示已实现；记录没有 topicId，completed 表示结束，未知退出码显示中性状态。

- `VCPDistributedServer/Plugin/PowerShellExecutor/PowerShellExecutor.js`（+ `gui/PowerShellViewer.js`）：对每条执行的命令记 `{id, command, status, startedAt, endedAt}`，供终端标签 / 状态面板 / 命令输出标签使用。
- 审核者请重点检查：运行记录无会话标记（见 R3 取舍 2）；长输出的内存上限。

### R9 长话题性能

**修复状态**：批量读写顺序测试通过；历史性能数字没有复测，不作为当前通用性能保证。

- `modules/renderer/visibilityOptimizer.js`：消息高度记忆改为「先批量读、再批量写」，消除每条消息一次强制重排。交接者此前一个 94 条话题样例为 7.0s → 约 4s；本次没有重测，不作通用性能保证。`tests/visibility-optimizer-height-batch.test.mjs`（读写顺序断言，已确认旧代码下失败）。

### R10 其他

**修复状态**：生成图与 consumer 清单按层重建，F13 selection 通知与 F14 综合门禁修复已完成。

- 新话题创建后显示空状态（让建议提示词恰好在有用时出现）。
- `scripts/*`：门禁脚本与基线更新；`docs/contracts/generated/chat-event-graph.json` 重新生成。

## 3. 测试与门禁现状

完整 `npm run check:ui-system` 通过。功能集合与聊天内核结果、每层语法/契约/样式/新测试、相对模块引用及真实运行证据见 `VERIFICATION.json`。数字代表具体命令范围，各集合存在重叠，不能相加当作唯一用例数。

真实 Chromium 已验收 Widget 的焦点、合成点击、可信点击和切话题边界；实际 Windows unpacked 产物及其模块已验收 node-pty 与终端 IPC。未验证签名 NSIS 安装/升级、macOS/Linux、实际 VCP 服务器群聊模型请求、真实语音、整应用全面视觉或长期 soak。原件的历史真机和性能结果不改写为本次结论。

## 4. PR 边界与审核方法

22 个功能层和 1 个文档层从固定基线重建；无关 scratch/outputs/work/artifacts 素材及 uv.lock 变化排除。每个后续 PR 的 base 是前一分支，仅审核本层 delta，依次合并。修复分配回引入功能的层，逐层证据与最新 SHA 见 `PR-STACK.json`。

先读 `PR-STACK.md` 的本层范围和测试，再按本文件的重点独立审查实现，使用 `REPAIR-REPORT.md` 的边界回归核验修复。固定审查基线、精确源码范围和逐属性动态样式 owner 不替代语义审核；不得扩大白名单来隐藏未知偏离。真实历史只用测试副本，准备命令见 `HANDOFF.md`。



### 最终恢复与打包边界补充

- 终端的 `AdminConfirm.py` 放在 `app.asar.unpacked`，确认路径解析为真实磁盘文件；缺失时失败并清理临时文件。管理员确认仍依赖本机 Pythonw/Tk，本轮未触发 UAC 或实际 Tk 窗口。
- 模型轨迹启动/保留清理会回收严格命名的孤儿临时文件，跳过正在写入的文件。空的哈希 JSONL 是持久清空标记，不随 7 天内容保留期限删除，防止旧格式日志重新出现；文件内容占用为零，元数据仍占磁盘空间。
- 文件摘要仅把一问一答区间内的明确成功算作改动；同一工具并发且无关联 ID 的结果归属标为未知，即使请求与结果条数相等。
