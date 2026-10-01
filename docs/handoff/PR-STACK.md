# 可审核的堆叠 PR 分支

日期：2026-10-01。22 个功能层 + 1 个文档层，从固定上游基线重建。原审查 F01–F14 已修复，修复分配回对应功能层。各层完整 UI 门禁、对应回归及相对模块引用通过；最终证据见 `VERIFICATION.json`，处理说明见 `REPAIR-REPORT.md`。全部是本地分支，没有推送或远程 PR。

固定基线：`283255750376e645ec3e355dbfb84730371014cc`；保留原实现：`325ce1c9daede619fa48d07a9c741940e89ccab6`。新链不以原功能分支为祖先；无关素材未进入新链，原历史与未提交文档保留。

## 分支顺序

第一层 base 为固定基线；以后每层 base 为前一分支。每个 PR 审核一个功能增量，依次合并。第一层包含共用 shell/输入/通知，第二层包含框架与首个侧聊 provider，其他功能分开。

|序号|分支|本层范围|
|---|---|---|
|1|`pr/zcode-01-shell-composer-notifications`|主界面、语音输入、模型选择与通知卡片|
|2|`pr/zcode-02-sidepane-sidechat`|通用侧栏框架与独立侧聊生命周期|
|3|`pr/zcode-03-git-backend`|Git 分支、提交图与变更统计接口|
|4|`pr/zcode-04-notes-code-viewer`|笔记、代码查看与共享笔记窗口样式|
|5|`pr/zcode-05-browser`|隔离的内置浏览器|
|6|`pr/zcode-06-terminal-command-runs`|终端镜像、链接与命令运行记录|
|7|`pr/zcode-07-plan-detail`|V工程计划详情|
|8|`pr/zcode-08-git-pane`|Git 变更、AI 批次与 diff 标签|
|9|`pr/zcode-09-file-summary`|消息内文件摘要与 Git 行数|
|10|`pr/zcode-10-conversation-status`|跟随会话的状态面板|
|11|`pr/zcode-11-model-trajectory`|模型调用轨迹记录、IPC 与查看器|
|12|`pr/zcode-12-turn-navigation`|轮次导航与滚动跟随释放|
|13|`pr/zcode-13-message-metadata`|消息时间与回复耗时|
|14|`pr/zcode-14-conversation-find`|对话内查找|
|15|`pr/zcode-15-selection-quote`|划词引用|
|16|`pr/zcode-16-suggested-prompts`|新话题空状态与建议提示词|
|17|`pr/zcode-17-send-queue`|按话题持久化的发送队列|
|18|`pr/zcode-18-message-export`|选中消息 Markdown 导出|
|19|`pr/zcode-19-slash-commands`|输入框斜杠命令|
|20|`pr/zcode-20-command-center`|命令、会话与文件快速跳转|
|21|`pr/zcode-21-widget-bridge`|HTML 组件宿主桥|
|22|`pr/zcode-22-history-performance`|长话题高度批量读写|
|23|`pr/zcode-23-review-docs`|需求、交接、审查、修复与来源材料|

## 使用与维护

分支存在于原仓库的公共 Git 存储；原工作树保留原分支。集成工作树在当前任务 `work/split-checkout`，最终停在文档分支。此目录 node_modules 是本机 junction，接手机器必须自行 bootstrap/doctor 安装，不能作为便携依赖交付。

```powershell
git diff pr/zcode-09-file-summary...pr/zcode-10-conversation-status
git log --oneline pr/zcode-09-file-summary..pr/zcode-10-conversation-status
git worktree add 'C:\absolute\path\to\review-git-pane' pr/zcode-08-git-pane
```

后续修复应先落对应层，再 rebase 后继链。使用 squash/rebase 合并时，把下一层重放到新 main 并复核 delta；仅改 PR base 可能重复前面的提交。远程第一层 base main，后续 base 前一个远程分支。只推这条 pr/zcode-* 链，不 merge 原功能分支。

## 检查及边界

22 层逐层通过 renderer/main 语法、next-delta、chat-contracts、Classic retirement、stylelint、事件图与 consumer 生成，以及该层变更测试；此外每层完整 `npm run check:ui-system` 通过。静态相对引用闭包通过。最终功能集合 358/358、聊天内核 189/189；集合重叠，不相加为唯一用例数。

真实 Widget 与 Windows unpacked/原生 PTY/终端 IPC 证据在 evidence/quality。签名 NSIS、其他平台、真实 VCP 服务器群聊模型、语音、全面视觉与长期 soak 未验收；Windows node-pty 辅助清理进程仍偶尔有 AttachConsole 日志。命令文本关联与未知退出码是明确的产品边界。

机器可读 SHA/父级/本层文件/退出码见 `PR-STACK.json`。门禁和生成摘要不能替代语义审核。

### 01 主界面、语音输入、模型选择与通知卡片

提交：`ad24c9b35668c25aa6e1229e0c9c1eeaebcd3766`；父提交：`283255750376e645ec3e355dbfb84730371014cc`。

- `node --test tests/chat-kernel-scratch-isolation.test.mjs`
- `node --test tests/content-pipeline.test.mjs`
- `node --test tests/dsh-voice-interaction.test.js`
- `node --test tests/notification-center.test.js`
- `node --test tests/notification-change-audit.test.js`

### 02 通用侧栏框架与独立侧聊生命周期

提交：`a80f12559288c593ed87eee5a9b9274cc4c0ddff`；父提交：`ad24c9b35668c25aa6e1229e0c9c1eeaebcd3766`。

- `node --test tests/chat-history-persistence.test.mjs`
- `node --test tests/chat-manager-selection-race.test.js`
- `node --test tests/main-chat-dom-bindings.test.mjs`
- `node --test tests/selection-reference.test.mjs`
- `node --test tests/side-chat-audit-probes.test.mjs`
- `node --test tests/side-chat-authorization.test.mjs`
- `node --test tests/side-chat-entry-points.test.mjs`
- `node --test tests/side-chat-ephemeral-zcode-parity.test.mjs`
- `node --test tests/side-chat-integration.test.mjs`
- `node --test tests/side-chat-ipc-metadata.test.mjs`
- `node --test tests/side-chat-model-and-context.test.mjs`
- `node --test tests/side-chat-session-service.test.mjs`
- `node --test tests/side-chat-surface-owner.test.mjs`
- `node --test tests/side-chat-topic-binding-parity.test.mjs`
- `node --test tests/side-pane-advanced-parity.test.mjs`
- `node --test tests/side-pane-controller.test.mjs`
- `node --test tests/side-pane-resizer-owner.test.mjs`
- `node --test tests/side-pane-state.test.mjs`
- `node --test tests/side-pane-tab-strip.test.mjs`

### 03 Git 分支、提交图与变更统计接口

提交：`efb3db3ce3172dd2cdc663c56972204eff8e1ead`；父提交：`a80f12559288c593ed87eee5a9b9274cc4c0ddff`。

- `node --test tests/git-service.test.js`

### 04 笔记、代码查看与共享笔记窗口样式

提交：`efe20c4a0fa284f8c0f751a4ca6e805304410ed3`；父提交：`efb3db3ce3172dd2cdc663c56972204eff8e1ead`。

- `node --test tests/line-diff-budget.test.mjs`
- `node --test tests/notes-side-provider-races.test.mjs`

### 05 隔离的内置浏览器

提交：`b645544f5012ba28dcd90743970b66d7e0e42fd2`；父提交：`efe20c4a0fa284f8c0f751a4ca6e805304410ed3`。

- `node --test tests/browser-handlers.test.js`

### 06 终端镜像、链接与命令运行记录

提交：`02ae8840c5708ac2b7880fefd4c29043a54fcf40`；父提交：`b645544f5012ba28dcd90743970b66d7e0e42fd2`。

- `node --test tests/side-pane-terminal-links.test.mjs`
- `node --test tests/side-pane-terminal-theme.test.mjs`
- `node --test tests/side-pane-tool-output.test.mjs`
- `node --test tests/terminal-handlers.test.js`
- `node --test tests/terminal-native-helper.test.js`
- `node --test tests/terminal-package-closure.test.js`

### 07 V工程计划详情

提交：`6647fc85792003d533aecac6215c3b035ad60e43`；父提交：`02ae8840c5708ac2b7880fefd4c29043a54fcf40`。

- `node --test tests/side-pane-plan-detail.test.mjs`

### 08 Git 变更、AI 批次与 diff 标签

提交：`c43760ea815157ce3af592d6319ad39bfb6cfb2d`；父提交：`6647fc85792003d533aecac6215c3b035ad60e43`。

- `node --test tests/side-pane-git-ai-scope.test.mjs`
- `node --test tests/side-pane-git-real-backend.test.mjs`
- `node --test tests/side-pane-universal-provider.test.mjs`

### 09 消息内文件摘要与 Git 行数

提交：`2571aaf68d36ff8815bcc15b7b6d547dd5707572`；父提交：`c43760ea815157ce3af592d6319ad39bfb6cfb2d`。

- `node --test tests/git-file-diff.test.mjs`
- `node --test tests/message-file-changes-projectforge.test.mjs`
- `node --test tests/message-file-changes.test.mjs`

### 10 跟随会话的状态面板

提交：`32340973c26784cd55f2e892b1f75a6daff8fac6`；父提交：`2571aaf68d36ff8815bcc15b7b6d547dd5707572`。

- `node --test tests/conversation-scope.test.mjs`
- `node --test tests/conversation-status-panel.test.mjs`
- `node --test tests/conversation-status-races.test.mjs`

### 11 模型调用轨迹记录、IPC 与查看器

提交：`49f33574eb44d9bb6b57274199bf664e22a6e2e0`；父提交：`32340973c26784cd55f2e892b1f75a6daff8fac6`。

- `node --test tests/model-trajectory-bounds.test.js`
- `node --test tests/model-trajectory-handlers.test.js`
- `node --test tests/model-trajectory-model.test.mjs`
- `node --test tests/model-trajectory-recorder.test.js`
- `node --test tests/model-trajectory-recovery.test.js`
- `node --test tests/preload-registry.test.js`
- `node --test tests/side-pane-model-trajectory.test.mjs`

### 12 轮次导航与滚动跟随释放

提交：`416759adf8d258fd526c888301b7d8006129809d`；父提交：`49f33574eb44d9bb6b57274199bf664e22a6e2e0`。

- `node --test tests/chat-scroll-release.test.mjs`
- `node --test tests/conversation-turn-navigator.test.mjs`

### 13 消息时间与回复耗时

提交：`b4658657310f3a07b4d0c596b603186b1661089c`；父提交：`416759adf8d258fd526c888301b7d8006129809d`。

- `node --test tests/message-meta-enhancer.test.mjs`

### 14 对话内查找

提交：`300fc735d6a7e4c8a3610c0b1ec3407f373a5d6b`；父提交：`b4658657310f3a07b4d0c596b603186b1661089c`。

- `node --test tests/conversation-find.test.mjs`

### 15 划词引用

提交：`12ca725ced81407ed3465e3798e912b275c3be0c`；父提交：`300fc735d6a7e4c8a3610c0b1ec3407f373a5d6b`。

- `node --test tests/selection-quote-action.test.mjs`

### 16 新话题空状态与建议提示词

提交：`504b3c6df040d100d438de9232d7bde0c2fd0e98`；父提交：`12ca725ced81407ed3465e3798e912b275c3be0c`。

- `node --test tests/draft-suggested-prompts.test.mjs`

### 17 按话题持久化的发送队列

提交：`83c40f5f44fcb740891a231afe426b1688ff9775`；父提交：`504b3c6df040d100d438de9232d7bde0c2fd0e98`。

- `node --test tests/group-queue-admission.test.js`
- `node --test tests/send-queue.test.mjs`

### 18 选中消息 Markdown 导出

提交：`5a3002b444515672425679b9348a101f3f8041d0`；父提交：`83c40f5f44fcb740891a231afe426b1688ff9775`。

- `node --test tests/message-export.test.mjs`

### 19 输入框斜杠命令

提交：`509e71d26a44bc17cead917077d483321f848682`；父提交：`5a3002b444515672425679b9348a101f3f8041d0`。

- `node --test tests/slash-commands.test.mjs`

### 20 命令、会话与文件快速跳转

提交：`635e306edf5abe2254aa9883d425d6b0c1066213`；父提交：`509e71d26a44bc17cead917077d483321f848682`。

- `node --test tests/command-center.test.mjs`

### 21 HTML 组件宿主桥

提交：`719bfdb83de447a132e749c05c8f947b6bfa5eb2`；父提交：`635e306edf5abe2254aa9883d425d6b0c1066213`。

- `node --test tests/widget-bridge.test.mjs`

### 22 长话题高度批量读写

提交：`46819283d397dab31cf6de182b2a90240dd5b80b`；父提交：`719bfdb83de447a132e749c05c8f947b6bfa5eb2`。

- `node --test tests/visibility-optimizer-height-batch.test.mjs`

### 23 文档与出处

原审查报告作为历史证据保留，需求/交接与修复报告明确当前行为和验收缺口。ZCode Apache 许可证、NOTICE、THIRD-PARTY-NOTICES 原文保留，新增 diff 适配和对照路径记录在 vendor/zcode/ATTRIBUTION.md。

## Git bundle 迁移

`zcode-pr-stack.bundle` 包含 23 个分支的新链，需要目标仓库已有固定基线。先执行 `git bundle verify <bundle绝对路径>`，再按清单 fetch 分支。bundle 不含 audit 备份引用或 node_modules。
