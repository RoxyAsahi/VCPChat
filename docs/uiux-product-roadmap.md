# VCPChat Harness 风格 UI 产品路线

> 本文是后续施工的短执行路线；历史迁移细节保留在 `ui-runtime-2-roadmap.md`，不再作为日常决策清单。

## 目标

让 VCPChat 的高频非聊天 UI 使用统一、成熟、视觉接近 DeepSeek Harness 的组件系统，同时减少旧 CSS、重复 listener 和双 presentation owner。

不追求每个控件的源码级或像素级 Harness 复刻；视觉一致性以真实 VCPChat 页面可用、稳定、协调为准。

## 范围

优先处理：

1. Sidebar / Shell / Account / Notification / App Tray；
2. Agent Settings 与 Global Settings 的常用表单和 action；
3. Menu、Modal、Tooltip、Toast、Field、Button、Input、Select、Toggle、Range。

暂缓处理：

- 聊天气泡、消息、思维链、代码块、工具结果、composer/input 内部布局及流式；
- StreamCoordinator、StreamProjection、MessageRenderer、ChatDomRenderer、协议、IPC、持久化、Plugin Loader、chat manifest、动态壁纸；
- ModelPicker legacy modal 的全量 retirement、复杂编辑器、低频 DiffBlock、特殊 picker 与窗口级 icon 控件。

## 施工单元

每个切片只做一个真实 Surface 或一组同类型高频控件：

```text
既有 generated primitive
→ 保留 native/canonical business node
→ 指定单一 presentation owner
→ 接入真实页面
→ 删除直接竞争的旧 CSS/listener/projection
→ focused test + Electron open/reopen/Escape/teardown
→ 独立提交
```

组件展示页仅用于试用和回归；旧组件明确标注 `legacy-showcase`，新页面不得继续引用它们。

## 完成标准

一个组件进入高频生产使用，不要求全局 parity ledger 为绿；需要：

- 真实生产 consumer；
- canonical state、业务命令与 persisted key 不变；
- owner/dispose 无重复注册或遗留副作用；
- light/dark 与常见窗口尺寸下无明显 geometry/cascade 问题；
- 对应旧 presentation 路径减少，而非新增 wrapper。

`pixel-equivalence`、Windows、packaged artifact-only smoke 和 Harness production capture 保持为高价值增强证据：可做则做，但不阻塞高频页面的合理迁移。

## 当前两批

1. **Settings 收口**：继续将 Agent/Global Settings 的常用控件替换为现有 Button/Input/Select/Toggle/Range/Field，并在每个字段组删除直接竞争的旧样式和双 owner。
2. **Shell 收口**：统一 Sidebar、Account、Notification、App Tray 的普通 action/menu/tooltip；保留 destructive、筛选和窗口控件的 bespoke 合同。

## 进度记录规则

只更新本文件的批次结果与 `docs/uiux-progress-2026-08-28-high-frequency.md` 的生产接入表。reference pack、fixture matrix 与源码审计只在影响真实 consumer 时更新。
