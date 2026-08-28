# Harness-style 主题系统迁移计划

> 范围：VCPChat 主窗口 UI/UX presentation；不改聊天协议、插件 Loader、业务设置格式或业务子页面。
> 状态：P0–P2 已实施；旧主题 class 已移除，后续仅保留业务子页面独立样式。

## 目标架构

```text
Settings / IPC / prefers-color-scheme
              ↓
ThemeRuntime snapshot (preference → effective)
              ↓
唯一 document ThemePresenter
              ├─ html color-scheme
              ├─ body[data-vcp-theme]
              ├─ theme-color meta
              └─ semantic token projection
              ↓
静态 scale + semantic alias CSS
```

## 分阶段执行

1. **P0 状态合同（本切片）**：主题 snapshot 同时表达 `preference`、`effective`、`revision`、`source`；`system` 只作为 preference，渲染使用解析后的 effective。
2. **P0 DOM contract**：Presenter 写入 `body[data-vcp-theme="light|dark"]` 与 `html.style.colorScheme`；主窗口 CSS/JS 不再依赖旧 theme class。
3. **P1 Presenter ownership（本切片）**：主题 DOM、token 与自有 `theme-color` meta 由 Presenter 负责，并通过 UiScope 释放；组件不从 DOM 反推主题。
4. **P1 token plane**：新增 Harness-compatible static scale / semantic alias CSS；Presenter 的动态投影作为启动和自定义主题的覆盖层。
5. **P1 runtime 拆分**：`ThemeRuntime`、`AppearanceProfileRuntime`、`MaterialRuntime` 已成为独立职责模块，并由主窗口入口加载；appearance-engine 保留兼容 orchestration。
6. **P2 全量迁移与验证**：主窗口 45 个 CSS/HTML/JS selector 已迁移至 `data-vcp-theme`，并补 Presenter、snapshot、runtime 与 provenance 回归；运行 `check:uiux`、主题测试与 UI System theme gate。

## 退出条件

- 首屏和运行时均有同一主题 DOM contract；
- `system` preference 与 effective 不再混淆；
- Presenter dispose 后不残留自身 token/meta/attribute；
- 主窗口旧业务 CSS 行为保持不变；
- 聚焦自动化通过；跨平台、打包和人工 soak 证据留到发布阶段，不在本切片虚报完成。

## 明确非目标

- 不迁移业务子窗口内部的独立高亮主题实现；
- `appearance-engine.js` 暂作为兼容 orchestration 保留，内部职责已委托给独立 runtime；
- 不引入 React/Vue/Cordis 或新的持久化格式；
- 不迁移 Notes、Translator、Memo、Forum 等业务子页面。
