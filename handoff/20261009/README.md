# 交接总览 2026-10-09 03:35Z

本文件交接给 Roxy 本机的 Codex，在云端代理额度用完期间继续推进 VCPChat Live2D 桌宠工作。


## 更新（以此为准）

- #34 head 现在是 `4f6e5bd8`（03:35Z）：#63 Q 版 Nova v2（截图验收通过）、#66、#67 都已合入，没有待合的 PR。
- 科技服/女仆的修复还没开始做，起点是 WIP 分支 `claude/nova-tech-maid-wip`（c09e10e9，科技服高清重建）。

## 规则

- 仓库是 fork RoxyAsahi/VCPChat（Codex 那边 remote 叫 `fork`）。
- 绝不推 `pr/side-pane-workbench`，也不 force push 别人的分支。
- 每项改动开新分支，draft PR 进 #34 的分支 `claude/project-thread-njw5ge`；推完要 pull。
- 代码注释、测试名、commit message 里不能出现 "ZCode"/"DSH"。
- 不提交 Cubism Core、Mao/Kurisu/Frieren/Fern 模型和美术。
- 改 appdata-real 前先备份。
- GitHub Actions 在 fork 上被禁用了（02:18Z 之后没跑过 CI）。
  - Roxy 需要去 https://github.com/RoxyAsahi/VCPChat/settings/actions 重新打开。
  - 打开之前，合并的依据是本地检查：
    - `npm run test:deskpet`
    - `test:side-pane`
    - settings 测试
    - `check:chat-contracts`
    - `check:chat-evidence`
    - `check:ui-system`
- 改了 `deskPetHandlers.js` 或 IPC 之后，要跑 `node scripts/build-chat-event-graph.mjs` 并提交结果。
- 按 win32 加载 handlers 的测试，结束时必须关掉 pet（`closeAll`），否则测试进程不会退出。

## PR 线

### #31 立绘线

- 分支 `claude/project-thread-jgqxch`。
- 上游 draft PR：lioensky/VCPChat#238（分支 `claude/portrait-upstream-h3m82g`）。
- 云端对上游是 403，要用 Roxy 本机的 `gh` 操作。

### #34 桌宠线

- head `4f6e5bd8`（03:35Z）。
- 已合入 #54-#62、#63（Q 版 Nova v2）、#64（标题栏开关移进全局设置）、#65（贴边停靠）、#66（按模型 HitArea 判断摸头）、#67（带翅膀模型头部区域修正）。
- 没有待合的 PR。

## 未完成（各自的详细交接文件在同目录）

- `settings-page.md`：
  - 桌宠默认尺寸缩到约 60%（只改没手动调过大小的用户）。
  - 照 ChatGPT 宠物补齐 悬停胶囊 → 输入展开 → 发送 → 回复气泡 → 语音 的交互和过渡动效。
  - 参考图在该线程原始 brief。
- `nova.md`：
  - Q 版 N1（嘴）、N2（眨眼）、N3（灰带）已修好并合入（#63）。
    - 剩余小瑕疵：说话/眨眼时新旧嘴或眼白短暂半透明重叠；大幅歪头时内层头发有一条淡线。
  - N4：手势切换生硬（加 0.15-0.2s 交叉淡入淡出）。
  - 之后修科技装/女仆装：闭眼露虹膜、歪头时后发整片转、虹膜越界、表情区分度、补笑眼/脸红/皱眉、女仆下巴阴影。
- `nova-qa.md`：截图验收的 harness 和未关闭的缺陷。
- `features.md`：新一轮功能缺口清单（`/mnt/project-files/deskpet/gaps-round3.md`）。
- `review.md`：对抗审查剩余项。
- `integration.md`：合并流程。
- 泄漏：线程正在 `9aadeceb` 上重跑，报告在 `/mnt/project-files/leaks-20261008/`。

## Roxy 本机

- 日常 VCPChat：`C:\Users\CHENXI\Documents\Codex\daily-deskpet`
  - 本地分支 `daily/deskpet`，用 appdata-real 运行。
  - 还在较老的 #34 版本上，更新目标是 `4f6e5bd8`。
  - 重启前先问 Roxy，并先备份 appdata-real。
- 上一份交接模板：`/mnt/project-files/handoff/codex-handoff-20261008.md`。
