# Notification Menu Visual QA（2026-08-28）

## 范围

本轮检查 Next Shell 通知菜单，不触碰聊天消息、流式渲染、通知业务协议或持久化。验证只针对真实 Electron 页面中的 presentation owner、菜单层级和主题 token。

## 结果

运行：

```bash
node scripts/run-visual-qa-next-notification-menu-themes.mjs
```

结果：light/dark 两套主题均通过，800×600、1280×800、1680×1000 三个 viewport 各完成 3 个 capture，共 6 个 capture。菜单打开、动作项布局、portal 层级与主题切换均通过脚本门禁。

随后使用生成的 light/dark 输出运行：

```bash
node scripts/check-visual-qa-next-notification-menu.mjs <light-dir> <dark-dir>
```

结果：`verified: true`。

## 边界

这证明的是 Notification Menu 的真实渲染回归，不代表所有 Harness primitive 已达到像素等价，也不晋级组件库中的 source-only Candidate。通知筛选 checkbox 与 destructive clear 继续保持 bespoke，直到拥有独立的 DOM/CSS/interaction parity 证据。
