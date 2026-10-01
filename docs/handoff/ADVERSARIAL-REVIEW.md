# VCPChat 相对上游的对抗式审查

> 历史报告：本文记录原实现的 F01–F14 发现及当时验证限制。缺陷已在新功能链修复，当前结果请看 `REPAIR-REPORT.md` 和 `VERIFICATION.json`，不要将本文的旧失败状态当作当前分支状态。

审查日期：2026-10-01。固定基线：`283255750376e645ec3e355dbfb84730371014cc`；被审查实现：`325ce1c9daede619fa48d07a9c741940e89ccab6`。审查对象包括两份未提交文档、R1–R10 的实现、测试、IPC、打包配置和提交边界。后续分支清单见 `PR-STACK.md`。

**结论：可以拆分并开草稿 PR，当前实现不应整体直接合并。** 发现 8 项 P1、6 项 P2，其中 widget 权限问题属于代码证据明确、实际 Electron 绕过仍待验证。原分支和原始两份未提交文档均保留；业务缺陷没有被这次拆分悄悄修掉。

P1 表示应在对应功能合并前解决；P2 表示具体缺陷或需要明确产品约定。以下行号对应被审查提交，后续拆分后的行号可能变化。

## 1. 合并前应处理的发现

| 编号 | 优先级 | 位置 | 结论与证据 |
|---|---|---|---|
| F01 | P1 | `modules/ipc/sideChatHandlers.js:106`、`:270`、`:319` | 7 个侧聊 IPC 没有 sender 校验。伪造 `senderFrame.url=https://untrusted.invalid` 后，`create-child` 仍返回成功。路径段过滤只能保护路径，不能授权调用者；读快照、写元数据、删除侧聊同样缺少调用来源边界。不要据此声称远程页面已能访问 preload；已证实的是主进程入口不校验来源。 |
| F02 | P1 | `modules/modelTrajectory.js:82` | `sanitizeParams()` 只过滤第一层键。`params.extra.apiKey='test-secret-only'` 会被完整落盘。这与“疑似密钥字段剔除”及“API Key 永不入记录”的承诺冲突，且不是文档已承认的 messages 正文敏感文本问题。 |
| F03 | P1 | `modules/modelTrajectory.js:153`、`:169`、`:172`、`:242`、`:256` | 文件超过字节上限后只按记录条数压缩；一条记录本身超限时无法满足上限。1 KB 配置产生 8,702 字节文件。流式 text/reasoning/tool arguments 累加也没有输入时上限；request 消息条数和参数对象总体无预算。读取和压缩使用全文件同步读与 JSON 解析，不能支持“不阻塞聊天链路”的绝对承诺。 |
| F04 | P1 | `modules/ui-system/conversation-status-panel.js:256`、`:291`、`:318` | seq 校验发生在异步 helper 已修改共享变量之后。先挂起 A 的计划读取，切到 B 并完成刷新，再放行 A；切换面板形态触发重绘后出现 B 的 Git 分支和 A 的计划。`workspace = await pickWorkspace()` 及 `scopedProjects` 有同类共享写入问题。 |
| F05 | P1 | `modules/ui-system/side-pane/notesSideProvider.js:155`、`:168`、`:193`、`:270` | 保存期间切到“新建”，`saveNote()` 因 `isSaving` 立即返回，切换流程继续清空编辑器。旧保存完成后把旧文件路径写回共享状态；新笔记随后保存到旧路径。隔离探针记录到第二次调用 `{title:'New', filePath:'old-note.md'}`，构成旧笔记被覆盖的风险。 |
| F06 | P1 | `modules/ui-system/side-pane/codeViewerSideProvider.js:93` | diff 用完整 LCS 矩阵，时间与内存均为 O(n×m)。两边各 3,000 行实测新增约 36 MB ArrayBuffer；各 20,000 行仅矩阵即需 1,600,160,004 字节。Git 后端允许的文件大小足以触发，行数或矩阵预算没有保护，普通文件查看也能冻结渲染进程。 |
| F07 | P1 | `modules/ipc/terminalHandlers.js:33`、`package.json` 的 `build.files` | 新终端直接 require 仓库内 PowerShellExecutor 插件，但打包白名单只列了其他指定插件，没有该插件。用当前 files glob 对所需入口匹配，结果为 false。`node-pty` 的 asarUnpack 已配置，却不能补齐缺失的 JS 插件入口。这里是静态打包闭包证据；没有声称执行了完整打包启动。 |
| F08 | P1，待真机验证 | `modules/renderer/widgetBridge.js:91` | “iframe 是 activeElement”不是用户同意发送消息的证明。预览脚本能调用 focus，并且用户一次聚焦后没有每次发送的授权或短期 activation 限制；当前判断可允许多次自动跟进。测试用 mock 直接设 activeElement，没有测试用户手势。真实 Electron 反例未完成，不能标为已实测利用。 |

建议修复与回归标准：

- F01：对所有入口统一验证可信主窗口、主 frame 和确切应用页面；测试远程 URL、其他工具页、subframe 均拒绝。对 child 写入/删除同时校验侧聊 marker 和归属。
- F02：递归净化参数、限制深度和总体大小，保护循环对象；测试嵌套对象/数组中的密钥字段。正文敏感文本的保存策略另外明确，不能承诺全文本永不含密钥。
- F03：在 chunk 输入、单条记录和文件层分别施加字节预算；按字节保留尾部记录或裁剪超大记录；读取尾部也应异步且有界。新测试应断言实际文件 `size <= maxFileBytes`，不能只断言“少于几条记录”。
- F04：异步函数返回局部结果，统一在仍属当前 generation 时一次提交；关闭时递增 generation。增加 A 慢/B 快、A 拒绝/B 成功、切换过程中销毁的测试。
- F05：保存捕获文件身份，切换等待当前保存的真实 promise；新建采用新编辑 generation。旧回调不能改写新编辑器的路径、正文和保存基线。
- F06：采用有界 diff 算法/worker，预设行数、总字符和矩阵预算；超限展示“内容过大，无法生成 diff”。不要靠渲染最多 600 行掩盖计算阶段的矩阵成本。
- F07：补齐 PowerShellExecutor 所需入口和 GUI/运行依赖，纳入打包闭包清单；随后在实际安装产物里测试 terminalCreate、输入、退出和重启。
- F08：建议宿主以明确可见的用户操作确认每次发送，或先填入草稿；如果使用 activation，必须从可信宿主校验，不能信任 iframe 自报值。补充无点击自动 focus/连续 postMessage 的实际浏览器测试。

## 2. 其余具体缺陷

| 编号 | 优先级 | 位置 | 复现与建议 |
|---|---|---|---|
| F09 | P2 | `modules/ui-system/send-queue.js:23`、`:110`、`:317` | 入队没有 50 条限制，保存却静默截成前 50 条。入队 51 条得到内存 51、持久化 50，第 51 条重启丢失。另有出队先持久化删除、发送确认前崩溃丢草稿的窗口。入队明确拒绝超限/说明容量；持久化 pending 状态并由发送确认推进，避免用超时猜测持久化成功。 |
| F10 | P2 | `modules/ui-system/side-pane/notesSideProvider.js:326` | 抓取按钮搜索 `.message.assistant`，真实 domBuilder 生成 `.message-item.assistant` 和 `.md-content`。真实形状的 JSDOM 探针得到空内容和“暂无助手回复”；现有测试造了错误 DOM，因而通过。使用真实结构，排除思考中/流式消息，并保留正确正文选择器。 |
| F11 | P2 | `modules/ui-system/message-file-changes.js:239` | 请求/结果数不等时，“全部计入”的分支把明确失败的调用也算作改动。两次写请求、第一条 ERROR、第二条结果尚未到达，摘要同时列出 failed.txt 与 pending.txt。现有测试甚至把“全计入”写成验收。改为成功、失败、待确认分别建模，未知不能写成已改动。 |
| F12 | P2，产品约定 | `modules/ui-system/side-pane/side-pane-state.js:139` | 存在全局 Git 标签时，切到没有侧聊的新话题仍会折叠整个侧栏并激活通知。探针从已打开 Git 切话题后得到 visible=false。通用标签框架仍使用“该话题是否有侧聊”决定可见性，需明确全局工具标签在切话题时是否应保留，并增加对应验收。 |
| F13 | P2 | `modules/chatManager.js:1923` 附近 | 创建新话题成功会更新 currentTopicId/history，但没有调用新引入的 `notifySelectionCommitted()`。renderer 的 syncSidePaneParent、队列刷新与导出取消依赖此订阅，会滞留上一话题状态。还应审查创建分支话题等所有更换当前会话的路径。增加创建后订阅回调和侧栏 parent 的集成断言。 |

| F14 | P2，集成阻断 | `scripts/check-ui-system.mjs`、`check-classic-parity.mjs`、`check-classic-retirement-boundary.mjs`、`test-appearance-engine.mjs` | 完整 `check:ui-system` 不通过。新样式有未限定作用域、固定字号、未注册颜色，renderer 仍依赖 Next 表现 ID，外观测试的 composer radius 契约失败。源实现也复现这些失败；stylelint 修复并不满足这些架构门禁。设计减法还有旧 origin 快照及允许范围问题。需逐项统一 CSS 作用域/token 与明确接受的产品差异，更新对应契约；不能 blanket 放行新目录。 |

其他已经明确的取舍：命令按折叠空白后的文本匹配会话，两个话题可能共享同一记录；引号内空白本来可以有语义差别。应将其标为启发式关联，而不能说它准确证明“该话题发起”。终端所有视图共享同一 PTY，restart 会影响 AI 和其他视图；此设计应写在用户交互说明里。

## 3. R1–R10 验收审查

| 需求 | 本次证据 | 判断 |
|---|---|---|
| R1 通用侧栏 | 状态、拖拽、最近关闭、键盘、控制器测试通过；审查父会话与 provider 生命周期 | F12/F13 未解决；多窗口持久化和窄屏真机仍待验证 |
| R2 各 provider/侧聊 | provider、真实 Git 临时仓库、浏览器围栏、终端假 executor 测试通过；笔记竞态/真实 DOM 反例 | F01/F05/F06/F07/F10；IPC 和安装产物不能视为验收完成 |
| R3 状态面板 | 会话作用域、todo、Git 和弹层测试通过；延迟请求反例 | F04；命令文本关联的限制保留 |
| R4 聊天快捷能力 | 导航、查找、引用、建议、队列、导出、文件摘要和桥接测试通过 | F08/F09/F11；斜杠仅有 trace/export 等，命令输出/计划详情只在命令中心提供，原文混淆两者 |
| R5 外围 UI | 语音交互、通知、test:ui-system 通过 | 原始 stylelint 3 项失败；拆分中修正重复选择器和导航 margin，hidden 规则保留明确的单行 lint 例外；完整 UI 架构门禁仍失败（F14）；亮暗视觉、真实麦克风和其他平台未独立复验 |
| R6 调用轨迹 | 主/群/标题接线静态审查，记录器/模型/IPC/视图测试通过 | F02/F03；完整对话默认落盘、无自动过期和用户总开关的问题仍存在；list 返回最近 200 条，但实际读入整个文件 |
| R7 Git 扩展 | gitService 测试使用真实临时仓库；操作采用 execFile 参数数组、路径限定、仓库锁 | 未发现新的已复现命令注入；switch 本地改动拒绝有覆盖；主页面授权只按 file URL 后缀，还应改为确切应用身份 |
| R8 命令运行记录 | 30 条记录、每条 raw 512 Ki 字符/read 64 Ki 字符限制及事件合并静态核对；终端 IPC 测试 | 记录自身有边界；旧 executeSingleCommand 的 rawOutput 仍整段积累；completed 是执行结束，不能证明命令 exit code 成功；没有 topicId |
| R9 长话题 | 高度批量读写顺序测试通过，代码保留 rAF 回退和 disconnected 过滤 | 批处理成立；7 秒到 4 秒是交接者此前数据，本次没有重测，不能作为普遍性能保证 |
| R10 空状态/生成物 | 创建空话题代码核对，各拆分层重新生成 event graph 与 consumer report | 空状态改动成立；会话订阅遗漏见 F13；生成物的 hash 更新只是漂移门禁，不能替代语义验收 |

## 4. 测试记录与范围

- 原实现新增/修改的 52 个测试文件：逐文件、每文件 60 秒上限，共 352 个用例通过。
- 原实现 `test:ui-system`：120/120 通过，脚本内静态检查亦通过。
- 原实现 `test:chat-kernel`：186/187 通过；失败为 `tests/content-pipeline.test.mjs:20` 读取 null 的 `.size`。纯上游同一用例也失败，因此不是本分支新回归，仍应修复上游测试契约。
- 原实现 next-delta、chat-contracts 通过。原 stylelint 失败：side-chat duplicate selector、status-panel 的 important、turn-navigator 的 important，共 3 项。
- 新拆分链各层语法、next-delta、chat-contracts、stylelint、事件图和本层新增测试通过；22 层相对模块依赖检查通过（node_modules 从已安装依赖解析）。这不意味着全部集成门禁通过。
- 补跑综合门禁：design-subtraction 在原/新实现均失败；classic-parity、classic-retirement、ui-system guard、appearance-engine 在原/新实现也失败（F14）。新工作树的 theme provenance 初次因 active 文件与源主题行尾不同失败，统一工作树副本后通过；两个文件的 Git blob 一致，未引入产品差异。
- ui-interaction、ui-async-state、ui-task-journeys、motion、vcpui-consumers、ui-applications、page-runtime、appearance-studio、tab-lifecycle、webawesome-adapter 通过。bootstrap/lifecycle 初次 61/63 因 AppData 写入 EPERM，配置隔离 LOCALAPPDATA 后 63/63 通过。
- 隔离反例覆盖：嵌套秘密、文件字节上限、key 碰撞、文件摘要失败结果、全局标签切换、IPC sender、状态计划竞态、队列容量、笔记抓取、笔记保存竞态、diff 内存、打包入口 glob。
- key 净化存在 `a/b` 与 `a?b` 同路径的碰撞。正常内部生成的 ID 不含这些字符，故这里记录为边界风险，没有夸大为已证实的跨正常话题泄漏。
- 本次没有访问真实聊天原件、发送真实模型请求、完整打包、其他平台或群聊真机验证。Electron 隔离探针在沙箱内遇到子进程 DLL/加载失败；沙箱外重试被自动审批拒绝（脚本未验证、文件和网络访问范围较广）。F08 保留为待实际运行验证。

## 5. 文档审查与入库决定

**两份文档值得入库，但采用可移植的修订版本，放在文档 PR。** 原件继续留在原工作树，不覆盖不提交。

修订应做到：固定两个 SHA，不用会移动的 upstream/main 作为证据时间点；区分目标/实现/验收；纠正 97/98 ahead、头提交及样式门禁遗漏；将“永不阻塞/永不含密钥”等未兑现断言标为待验收；补充真实 DOM 与异步反例；提供 PowerShell 启动命令，使用用户指定的绝对测试副本路径。

从通用交接文档移除个人绝对路径、助手/话题 ID、私有模型端点及固定模型配置。保留为本地原件可以，但不应让上游审核依赖作者电脑。原文要求一律伪造 `Co-Authored-By: Claude Sonnet 5.5` 也应删除；提交署名只记录实际作者。结束测试应按本次 PID 关闭，不能按 electron.exe 镜像名杀掉用户所有窗口。

ZCode 本地参考提交为 `662c30bea4e833acaacbfb745a65eb09c23d55f8`。文件头写 Apache-2.0 引用不是完整的分发材料。需随改写代码提供许可证副本、改写声明和出处清单，逐文件核对原始版权/NOTICE。此次文档交付补充 Apache 许可证副本和出处说明，不能将其解释为每行代码版权审计已完成。[Apache 2.0 §4](https://www.apache.org/licenses/LICENSE-2.0) 明确规定分发时的许可证及声明保留要求。

## 6. 审查依据

主要结论来自固定提交源码与本地隔离实验。安全边界对照 [Electron 官方安全指南](https://www.electronjs.org/docs/latest/tutorial/security#17-validate-the-sender-of-all-ipc-messages)，它要求校验 IPC sender；焦点不等于用户激活的判断同时参考 [MDN focus 方法](https://developer.mozilla.org/en-US/docs/Web/API/Window/focus)。这些链接支持设计判断，不能替代本应用的真机证据。

审批结论：对应功能处理 P1 并补上能在旧代码失败的回归后再合并；PR 的后续 base 应是前一个分支，具体命令、依赖和检查状态见 `PR-STACK.md`。
