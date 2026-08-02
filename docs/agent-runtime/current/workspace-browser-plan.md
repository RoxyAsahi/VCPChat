# Agent Workspace 浏览与统一路径动作计划

状态：**implemented / working-tree hermetic pass；人工视觉与大工作区性能收据 pending**。本文定义两个 P0 能力：Session 工作区的只读文件树与预览，以及工具卡、Diff、附件和文件树共用的路径动作。

2026-08-02 已完成 Main-only `AgentWorkspaceService`、`agent-workspace:*` 窄 IPC/preload、Renderer tree model、Workspace Tab、文本/图片/二进制预览、搜索、临时/固定预览、统一路径动作以及 tree/tool/diff/attachment 的保守路径入口。`npm run test:codex-stack`、`npm run test:electron-codex-smoke`、`npm run check:agent-runtime` 与 `npm run check:ui-system` 已通过；这些是未提交工作树收据，不等于版本级或产品级完成。

## 架构结论

Codex App Server `0.146.0` 提供 Thread/Turn/Item、执行事件和 `fileChange` 路径，但不提供通用目录树或文件预览 GUI API。正确边界是：

```text
Codex App Server
  -> 执行事件、fileChange 路径、命令输出

Electron Main AgentWorkspaceService
  -> Session workspace 解析、只读目录/文件访问、搜索、路径动作

Renderer Workspace Browser
  -> 临时树状态、搜索、预览 Tab、选择与滚动位置
```

Workspace Browser 是 VChat Host 能力，不是 Codex 工具。它不得开启 Codex 原生 Shell/文件工具，不得注册为模型可调用工具，也不得成为 VCPToolBox 之外的第二条工具执行通道。

## 复用结论

优先 clean-room 端口 OpenCode 的纯模型与测试：lazy load、inflight 去重、workspace generation guard、路径归一化、目录优先稳定排序、迭代 flatten、键盘导航、临时/固定预览和长列表虚拟化。不得导入 SolidJS、OpenCode SDK、Session store 或 UI 组件。

CodexGui 只借鉴“Codex 提供 changed path，Host 对这些路径执行受限 Git diff，GUI 单独展示”的机制；不移植 Avalonia/.NET。Agmente 只借鉴 file change 稳定 ID、去重和增量 reconciliation；不移植 SwiftUI。精确文件、revision 和许可证见 [reuse-register.md](reuse-register.md)。

VChat 已有 [workspacePolicy.js](../../../modules/agent-runtime/workspacePolicy.js) 负责 canonical root、realpath、相对 containment、symlink/ancestor 和 traversal 校验。新服务必须复用它，不得创建第二套路径安全实现。

## WB-R0：合同与安全边界

- `WorkspaceRef` 必须绑定持久 Agent Session 的 `workspaceRoot` 和 workspace revision。Renderer 只提交 `sessionId` 与相对路径，不能提交或替换任意 root。
- Main 从 Projection Session 重新解析 workspace，并校验 IPC sender、Session 所属窗口与 workspace generation。异步响应若对应旧 Session/root，必须丢弃。
- 所有 DTO 使用规范化相对路径；拒绝 `..`、绝对路径、Windows device path、盘符/UNC 根不匹配、symlink/junction escape 和 root replacement。
- 对目录条目、深度、预览字节、搜索结果、并发请求、超时和 abort 设置硬上限。隐藏文件、`.gitignore` 与产品排除策略必须显式记录，不能由 Renderer 猜测。
- 文件内容不写入 Projection SQLite、localStorage、Codex transcript 或 ToolBox 日志。日志只允许记录耗时、数量和截断后的相对路径。
- 保留 `scripts/check-agent-runtime.mjs` 对 `agentRuntimeReadFile` 等高权限入口的禁令。新 IPC 使用独立 `agent-workspace:*` namespace，不扩张 Agent Runtime allowlist。

退出门槛：安全合同和 DTO fixture 先落地；路径策略测试覆盖 Windows 特有路径与 symlink/junction 逃逸后，才能接 UI。

## WB-R1：Main 只读 Workspace Service

新增 Main-only `AgentWorkspaceService`，最小 API 为：

```text
listDirectory(sessionId, relativePath, cursor?)
readPreview(sessionId, relativePath)
searchFiles(sessionId, query, limit)
statPath(sessionId, relativePath)
performPathAction(sessionId, relativePath, action)
```

允许的路径动作：

```text
preview
open-in-vchat
reveal-in-explorer
copy-relative-path
copy-absolute-path
open-with-system
```

`copy-absolute-path` 必须是显式动作；可执行文件、脚本和高风险类型的 `open-with-system` 必须二次确认。P0 不提供写入、删除、重命名、移动、apply patch、revert 或任意 shell command。

预览返回受限类型：文本返回编码、截断标记和行数；图片返回安全 descriptor/受控 URL；音视频返回 metadata；二进制或不支持类型只返回 metadata。不得通过 IPC 返回无上限 Base64。

退出门槛：Main 单测使用真实临时 workspace 覆盖分页、权限失败、取消、超限、二进制和大文件；Renderer 无法绕过 Session workspace。

## WB-R2：文件树与预览 UI

- 目录按需加载，同一路径 inflight 请求去重；workspace generation 改变时旧响应不得写入新树。
- 路径使用 slash-independent normalization，目录优先稳定排序；flatten 使用迭代算法，深目录不得递归溢出。
- row 以 `sessionId + workspaceRevision + relativePath` 为稳定 key 原地更新。展开、搜索、滚动和预览 Tab 仅保存在 Renderer 页面生命周期内。
- 支持树/搜索模式、键盘上下移动/展开/收起/打开；单击使用临时 preview，双击或明确动作固定 Tab。
- 大目录、搜索结果和长 Diff 使用虚拟化；切换 Session 后恢复该页面生命周期内的 scroll/Tab 状态，但不写 localStorage。
- 使用 VChat 设计 token、图标与右侧 Inspector/Workspace 区域；不引入 OpenCode UI framework。

退出门槛：冷/热目录展开、搜索键盘、临时/固定预览、稳定 DOM identity 和滚动锚点均有 JSDOM/Electron gate。

## WB-R3：统一路径引用与动作

所有来源只产生同一种 Renderer presentation ref：

```text
WorkspacePathRef {
  sessionId
  workspaceRevision
  relativePath
  kind
  source: tree | tool | diff | attachment
}
```

- 文件树、Tool Card、Diff row 和 Attachment Card 使用同一菜单与 action adapter。
- Main 在动作发生时重新从 Session 解析并校验路径；不得信任 ToolBox 输出中的绝对路径或旧 workspace ref。
- FileOperator 结果 parser 只做保守的展示提取。只有结构化字段或可验证的 workspace-relative path 才产生 ref；没有可靠路径时显示文本结果，不伪造路径。
- `open-in-vchat` 复用现有 Canvas/文本预览能力的窄适配，不把 `shell.openPath`、任意 URL 或 broad desktop IPC 直接暴露给 Renderer。

退出门槛：四种来源对同一文件产生一致行为；Session A 的 ref 无法在 Session B 或 workspace revision 变化后打开文件。

## WB-R4：Diff 与文件变化

- Codex 原生 `fileChange` 的路径是 codex-native profile 的权威来源。仅对这些已校验路径执行有界、只读 Git diff，机制参考 CodexGui。
- file change 使用稳定 identity、完整路径优先和去重，增量更新机制参考 Agmente。
- `toolbox-only` 的 FileOperator 在 Bridge 提供可靠 mutation receipt 前继续隐藏 Changes；不得从 Markdown、工具输出文本或 basename 猜写入结果。
- P0 只做 review/navigation，不提供 apply、revert、undo 或 patch execution。

退出门槛：Diff 行点击与树/附件使用相同 `WorkspacePathRef`；重复、basename 冲突、文件删除和超大 Diff 均有 fixture。

## WB-R5：验收矩阵

安全与 Main：traversal 变体、盘符/UNC/device path、symlink/junction、TOCTOU/root replacement、权限失败、二进制/大文件、目录分页、timeout/abort、旧 Session 异步响应。

Renderer：lazy expansion、request dedupe、稳定 row identity、搜索键盘、临时/固定预览、滚动锚点、CJK/长文件名、深树无递归溢出、四类来源统一打开。

Electron：真实临时 workspace、10k 文件压力、Session/workspace 切换、reload/crash、reveal/open 的安全 mock 或可恢复动作，以及 SQLite/localStorage/transcript 无文件内容泄漏。

WB-R0–R4 已达到 committed hermetic pass。WB-R5 的真实 Electron IPC/preview smoke 与 10k 文件分页/搜索压力 fixture 已通过；深浅主题人工截图、真实交互性能录制和 ToolBox 结构化资源路径仍待，因此不得标记产品完成。

## 明确禁止

- 不修改或 fork Codex，不开启 Codex native Shell/file tools 来实现浏览器。
- 不修改 VCPToolBox，不复制 ToolBox catalog，不把浏览动作注册为 `vcp_invoke`。
- 不让 Renderer 读取任意绝对路径，不增加 `agentRuntimeReadFile/WriteFile/Exec`。
- 不把相邻参考仓库加入构建、打包或运行时解析路径。
- 不复制 Cherry Studio AGPL 代码，不整体导入 OpenCode/CodexGui/Agmente 的 UI 或状态管理。
