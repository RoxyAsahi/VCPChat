# 交接：Live2D 功能缺口补齐（2026-10-09 03:35Z）

线程「Live2D 功能缺口补齐」。仓库 RoxyAsahi/VCPChat，整合分支 `claude/project-thread-njw5ge`（#34），当前 head 418fc36b。
新工作一律从 418fc36b（或更新的 #34 head）开分支，每项一个 draft PR，base = claude/project-thread-njw5ge，交给整合线程「Electron Live2D 窗口原型」合并。
仓库 Actions 已停用：合并依据是本地检查 + 真实 Electron 验证。

## 待合并的 PR
无。

已合并：#55 #57 #58 #59 #60 #62 #65 #66 #67（第一轮 8 项全部完成，见 deskpet/gaps-round3.md）。

## 下一步（第二轮缺口扫描，未完成）
- 要做：在 418fc36b 上对照 TsukuMate、MiniCPM-Desk-Pet、DSH 插件市场里的 Live2D 桌宠，找日常用户能感知的新缺口，按影响排序写进 deskpet/gaps-round3.md 新一节，再逐项开 PR。
- 现状：第二轮清单已写好（gaps-round3.md「第二轮缺口」一节，9 项带代码位置和做法），按「第二轮执行顺序」从第 1 项工具审批开始做。
- 已在真机看过：长回复气泡（只留最后 600 字，点气泡回主窗口）表现正常。
- 不要碰：设置页 dock/交互、默认大小（petPrefs）、标题栏开关（线程「桌宠设置页」）；Nova 模型素材（线程「Nova 图片转 Live2D」）。

## 每个 PR 的固定步骤
1. `npm run test:deskpet`（新测试文件记得加进 package.json 的 test:deskpet）和 `npm run check:chat-contracts`。
2. 改了 IPC 或 deskPetHandlers.js 的行号 → `node scripts/build-chat-event-graph.mjs`，把生成的 docs/contracts/generated/chat-event-graph.json 一起提交。
3. 生命周期测试里只要开了宠物，结尾必须 `handlers.closeAll()`（loadHandlers 按 win32 加载，命中轮询会让进程挂住）。
4. 合基线只用 merge，不 rebase、不 force push。
5. 真机截图放 /mnt/project-files/deskpet/<功能名>/。

## 规矩
- 代码注释、测试名、提交信息里不写 ZCode / DSH（PR 描述和项目文件可以写）。
- 不提交 Cubism Core、第三方模型和美术素材。
- 永远不推 pr/side-pane-workbench。
- PR 指派 RoxyAsahi。

## 坑
- 菜单分隔项没有 label：用 `i.label?.startsWith`。
- Linux 下穿透走 setShape，Windows 走 setIgnoreMouseEvents(forward)；两条路径都要想到。
- 容器验证脚手架（scratchpad h/）不在 Roxy 电脑上；本地用 VCPCHAT_APP_DATA_DIR 指向测试数据目录跑 Electron 验证即可。
