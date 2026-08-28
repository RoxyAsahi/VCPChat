# Sidebar / Account / App Tray 验收记录（2026-08-28）

## 结果

- `node scripts/test-electron-uiux-app-tray.mjs`：通过，覆盖打开、重开、Escape、焦点恢复和 teardown。
- `node scripts/visual-qa-next-sidebar-account-tray.mjs`：light 主题真实 Electron capture 通过，固定 viewport 几何与层级门禁通过。
- 最新并行修复 `75370082`、`8c3a3097` 已在当前 HEAD，分别覆盖 App Tray tooltip scope teardown 和通知菜单 resize restoration。

## 边界

本轮只验证 Shell/Tray/Account 的 presentation 行为，不改变聊天内核、通知业务命令、IPC、持久化或冻结的聊天内容区域。普通 action Button/Tooltip 可继续作为高频生产 consumer；窗口控制、特殊筛选和 destructive action 仍保持 bespoke，整体 Harness parity 仍未完成。
