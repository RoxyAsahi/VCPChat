# VCPChat ZCode UI 接手与审查说明

日期：2026-10-01。源实现 `325ce1c9daede619fa48d07a9c741940e89ccab6`，基线 `283255750376e645ec3e355dbfb84730371014cc`。这是固定快照；运行前用 `git rev-parse HEAD` 确认当前分支。

本次按依赖拆为 22 个功能 PR 和 1 个文档 PR。分支、base、提交和对应检查见 `PR-STACK.md`；原缺陷和反例见 `ADVERSARIAL-REVIEW.md`；修复结果见 `REPAIR-REPORT.md`，当前验证矩阵见 `VERIFICATION.json`。这些分支可以独立审核各自 delta，但要按依赖顺序合并。它们不是 23 个互相无依赖的补丁。

## 环境和数据边界

Windows、Node.js 22、Electron 44、原生 JavaScript 渲染进程；不是 React 应用。依赖和原生模块按仓库 bootstrap/doctor 流程准备，不能假定作者机器上的 node_modules 可移植。终端、语音、webview 的其他平台实测仍待补充。

真实历史测试必须使用用户提供的**副本**。不要读取配置后把默认数据目录当作测试目录；不要修改原件。绝对路径和服务器地址属于本地环境配置，不提交到通用文档。运行真实模型请求另需实际服务正常、正确模型与凭据，并承担真实请求成本；本次审查没有发起真实模型请求。

PowerShell 启动示例（在仓库根目录执行，把示例路径换成已准备好的测试副本）：

```powershell
$env:VCPCHAT_APP_DATA_DIR = 'C:\absolute\path\to\history-test-copy'
if (-not [IO.Path]::IsPathRooted($env:VCPCHAT_APP_DATA_DIR)) { throw 'Use an absolute test-copy path' }
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$launchArgs = @('.', '--remote-debugging-port=9444')
$probeApp = Start-Process -FilePath '.\node_modules\electron\dist\electron.exe' -ArgumentList $launchArgs -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -PassThru
# 测试结束后只关闭这次启动的进程；不要按 node.exe/electron.exe 镜像名全局结束进程。
Stop-Process -Id $probeApp.Id
```

如果需要看应用窗口，手动运行 `npm start` 并手动关闭本次窗口。不要复用运行中的用户应用来做破坏性测试。调试端口只用于本地验证，关闭应用后应停止监听。

## 每个 PR 的检查

在独立的测试 PowerShell 终端中先设置隔离状态目录，测试后退出该终端：

```powershell
$env:LOCALAPPDATA = [IO.Path]::GetFullPath((Join-Path (Get-Location).Path 'work/handoff-test-state/local'))
$env:APPDATA = [IO.Path]::GetFullPath((Join-Path (Get-Location).Path 'work/handoff-test-state/roaming'))
New-Item -ItemType Directory -Force -Path $env:LOCALAPPDATA, $env:APPDATA | Out-Null
```

```powershell
node --check renderer.js
node --check main.js
node scripts/check-next-delta-contract.mjs
npm run build:chat-event-graph
npm run check:chat-contracts
node scripts/check-chat-kernel-consumers.mjs --write
npm run lint:ui-system
# 用 PR-STACK.md 中列出的具体测试文件执行 node --test。
```

生成物改变时与该功能一起审核并提交。next-delta hash 只记录受保护文件的已审查内容，不能把更新摘要等同于功能正确。改完实现后，先检查真实差异，再更新基线；不要用基线更新掩盖未知行为变化。

集成检查：

```powershell
npm run test:ui-system
npm run test:chat-kernel
npm run check:ui-system
```

完整 UI 门禁与功能/聊天内核回归已经通过；逐层结果、最终集成结果和日志索引见 `VERIFICATION.json`。仅对测试进程设置 LOCALAPPDATA、APPDATA 到绝对隔离目录，bootstrap 测试不写真实用户状态。

## 关键设计与限制

- 侧栏管理 tab/provider 生命周期；全局工具状态跨话题保留。侧聊是磁盘子会话，marker 与父话题绑定，关闭清理需要严格 sender、归属和无 junction 验证；冻结上下文保存在 snapshot。
- selection 统一通过 chatManager，创建空话题、删除后空选择和分支都提交通知；迟到的异步结果不能改选其他会话。
- Git/计划共享 ProjectForge 纯投影，Git 与状态面板通过 vcp:git-changed 刷新。异步操作捕获 workspace，切换关闭旧浮层，使用参数数组执行 Git。
- diff 使用唯一行锚点/LIS 与有界 LCS，极端输入明确近似并分页，不能静默冒充精确统计。
- 终端是 PowerShellExecutor 共享 PTY 镜像；重启前说明对 AI/其他视图的影响并确认。记录最多 30 条、raw 512 Ki 字符/条，输出有截断提示；没有 topicId。实际 Windows 产物与 PTY/IPC 已验证，node-pty 清理辅助进程仍偶尔打印 AttachConsole failed。
- 状态面板按话题 ProjectForge 记录选择工作区；命令按保留内部空白的文本关联，界面明确标注。completed 只表示结束，未知退出码显示中性状态。
- 轨迹实际应用默认关闭，确认后启用；递归净化、有界累加与异步串行原子存储、7 天/64 MiB 总量保留。正文可能包含用户输入的秘密，开关与确认不能省略。
- 队列先持久化 pending，durable admission 后才出队；50 条满后拒绝且保留输入，超时暂停，稳定消息 ID 避免恢复重放重复发送。单聊和群聊分别有接收去重。
- 笔记的保存 Promise 队列捕获编辑文件与 generation；切换/关闭等待真实保存，失败保留编辑器。抓取回复使用真实 assistant/md-content DOM，跳过流式与思考中消息。
- 文件摘要只统计确认成功的调用；失败、pending、无法配对分别建模，歧义不算实际文件改动。
- Widget 运行在 opaque sandbox iframe；每条消息必须宿主可见确认且可信点击，确认前后校验会话绑定，销毁取消 pending；焦点不能授权。
- CSS 匹配对象在自有 scope 内；颜色 token、响应字号、动态样式逐属性 owner 和 DOM binding 契约受完整门禁检查。
- 真实 Chromium Widget、Windows unpacked/原生绑定/终端 IPC 的证据已保存。尚未验收签名 NSIS 安装升级、其他平台、真实服务群聊模型、语音、全面视觉与长期 soak；历史“7s→4s”也未重测。

## Git 与文档交付

原分支 `feat/zcode-sidebar-and-upstream-sync` 保留；另有 `audit/zcode-original-20261001` 固定原始 HEAD。原工作树内两份未提交文档保持原状。修订文档提交在 `pr/zcode-23-review-docs`，没有推送或创建远程 PR。

干净 PR 链直接从固定上游基线重建，排除 scratch/outputs/work/artifacts 中的无关素材与 uv.lock 的无关变化。这些素材仍保留在原分支的本地历史中；不要把原分支合并到新链。使用新分支引用推送，不会把原分支的那些提交变成新 PR 的祖先。

修改的既有文本文件保持上游行尾，避免 main.js/main.html 的整文件噪声。新增文件使用 LF。原有用户签名记录保留在原历史；新提交不伪造其他模型或人的 Co-Authored-By。

ZCode 参考提交 `662c30bea4e833acaacbfb745a65eb09c23d55f8`；许可证及出处材料放在 `vendor/zcode/`。新增适配的来源路径和修改说明已补充，原样保留 Apache 许可证与上游 NOTICE/THIRD-PARTY-NOTICES；本次不是完整第三方依赖法律审计。当前项目根 LICENSE 不因引入参考实现而被整体替换。



### 最终恢复与打包边界补充

- 终端的 `AdminConfirm.py` 放在 `app.asar.unpacked`，确认路径解析为真实磁盘文件；缺失时失败并清理临时文件。管理员确认仍依赖本机 Pythonw/Tk，本轮未触发 UAC 或实际 Tk 窗口。
- 模型轨迹启动/保留清理会回收严格命名的孤儿临时文件，跳过正在写入的文件。空的哈希 JSONL 是持久清空标记，不随 7 天内容保留期限删除，防止旧格式日志重新出现；文件内容占用为零，元数据仍占磁盘空间。
- 文件摘要仅把一问一答区间内的明确成功算作改动；同一工具并发且无关联 ID 的结果归属标为未知，即使请求与结果条数相等。
