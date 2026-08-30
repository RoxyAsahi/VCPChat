# 高频 Surface 回归证据（2026-08-28）

本轮复验已接入 generated Harness primitives 的三个真实入口，未修改业务命令、
canonical state 或聊天冻结区。

| Surface | 控件 | Electron journey | Visual QA |
| --- | --- | --- | --- |
| App Tray drawer | generated `Button` + `Tooltip` 普通 drawer rows | open → hover tooltip → Escape focus restore → reopen → owner teardown：pass | 已有三视口证据：pass |
| Sidebar Account tray | generated `Button` 普通菜单动作 | controller command/focus/teardown：pass | light，800×600/1280×800/1680×1000：pass |
| Notification menu | generated `Button` 五个中性动作 | keyboard/Escape/cleanup：pass | light，800×600/1280×800/1680×1000：pass |

验证命令：

```bash
node scripts/test-electron-uiux-app-tray.mjs
node scripts/visual-qa-next-sidebar-account-tray.mjs
node scripts/visual-qa-next-notification-menu.mjs
```

这些结果证明的是生产 consumer 的交互、生命周期和真实渲染稳定性，不代表
Harness DOM/CSS 像素等价或 Stable。32px Dock/icon、通知筛选 checkbox 与
destructive clear 等专属控件仍未迁移。
