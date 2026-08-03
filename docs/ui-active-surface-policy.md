# 新版 UI 业务页面启用策略

> 状态：active allowlist
> 生效日期：2026-08-03

新版主界面不再自动要求所有子应用使用新版 presentation。业务页面必须逐页达到可用门槛后才能进入启用清单。

## 当前启用

- 主界面新版 Shell、侧栏、顶部标签与 Agent 页面。
- 主 Renderer 中的全局设置增强。
- `Notemodules/notes.html`（笔记）。
- `Translatormodules/translator.html`（翻译）。

## 暂时归档

便签、日志、插件、任务、记忆、论坛、RAG 观察器、Human ToolBox 和 VchatManager 的新版重建代码保留在原业务文件中，但运行时强制使用经典 presentation。

归档不是删除：数据库、IPC、业务协议和经典页面均不改变，也不复制第二份业务状态。统一策略由 `modules/ui-system/ui-surface-policy.js` 管理；`vcp-ui-runtime-bootstrap.js` 在加载 Web Awesome 前应用策略，因此归档页面不会挂载 `AppPageShell` 或注册 WA 控件。

协同 Canvas 不属于“归档重建”：其 next-UI 重建已撤销，`Canvasmodules/` 三个业务文件恢复为 `origin/main` 的上游经典实现，因此不加载新版 runtime。

## 重新启用门槛

每个页面必须单独满足：

1. 核心业务流程、错误恢复、重开和独立/内嵌模式通过。
2. 不依赖旧 DOM 的偶然加载顺序，不产生重复监听器或双状态。
3. Electron 功能 smoke、窄窗口和视觉截图在当前 commit 通过。
4. teardown 后经典页面仍可操作。
5. 将页面加入中央 allowlist，并同步结构门禁和 Electron 测试。

旧的 2026-08-02 截图仅是历史结构证据，不能作为当前产品启用依据。

## 验证收据

2026-08-03，在 `codex/vcpchat-codex-app-server` 工作树执行：

```powershell
npm run check:ui-system
npm run test:electron-ui-apps
```

- UI 门禁通过：`2 active rebuilt, 9 archived rebuilt, 1 upstream classic`。
- Electron UI apps：25/25 通过。
- 笔记、翻译和全局设置使用新版 presentation。
- 便签、日志、插件、任务、记忆、论坛、RAG 观察器、VchatManager 和 Human ToolBox 在 next 请求下均验证为经典 presentation；Canvas 直接使用上游经典实现。以上页面均无 `AppPageShell` 和 Web Awesome 注册。
- 原 Human ToolBox 新版深度 smoke 保留为 `npm run test:electron-human-toolbox-next-experimental`，不再属于默认产品门槛。
