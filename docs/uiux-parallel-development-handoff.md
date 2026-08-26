# VCPChat UI/UX 并行开发交接指南

> 交接对象：并行 UI/UX 开发进程
>
> 适用范围：设置页、应用壳层、主题、外围布局和 UI Runtime
>
> 交接日期：2026-08-25
>
> 上位规范：[`vcpchat-harness-uiux-architecture.md`](./vcpchat-harness-uiux-architecture.md)
>
> 执行路线：[`ui-runtime-2-roadmap.md`](./ui-runtime-2-roadmap.md)

## 1. 先读什么

开始任何代码工作前，依次阅读：

1. 本文件；
2. `docs/vcpchat-harness-uiux-architecture.md`；
3. `docs/ui-runtime-2-roadmap.md` 的当前状态和“当前下一步”；
4. `docs/next-ui-current-state.md`；
5. `docs/next-ui-lifecycle-architecture.md`；
6. DeepSeek Harness 的 `/Users/asahi/Documents/Codex/deepseek-harness/AGENTS.md` 和 `docs/architecture.md`。

如果本文件与旧路线、历史审计或截图说明冲突，以本文件和上位规范为准。历史文档不能重新打开已经冻结的 Classic/Next 双布局决策。

## 2. 当前产品和架构事实

### 2.1 主窗口

- 主窗口只有一套正式布局；不区分 Classic/Next。
- `main.html` 仍是迁移期兼容壳，但新 UI Surface 应逐步拥有自己的 mount root。
- `renderer.js` 仍是 composition/lifecycle adapter，不能继续增加新的业务总装配逻辑。
- UI Runtime 只处理 UI/UX；不成为新的业务框架。

### 2.2 当前 UI Runtime

`modules/uiux/` 已有以下迁移期能力：

```text
contracts.ts
runtime/scope.ts
runtime/service-registry.ts
providers/theme.ts
adapters/settings.ts
adapters/rust-assistant.ts
adapters/forum-config.ts
adapters/assistant-runtime.ts
generated/*
```

当前真实状态：

- TypeScript strict 检查已接入；
- generated artifact 有一致性检查和 smoke；
- `UiServiceRegistry` 是 Surface-local registry，不是全局插件容器；
- `UiScope` 目前委托现有 `LifecycleScope`，不要再创建第二套生命周期实现；
- Settings 已有真实 typed consumer，但 legacy bridge 仍承担部分 presentation/autosave；
- Theme 已有 semantic token projection，但仍存在旧的 `body.classList` 读取路径；
- Plugin Loader、chat plugin manifest、聊天协议和流式核心不属于 UI Runtime。

### 2.3 当前已验证的证据

最近已通过：

- `npm run check:uiux`；
- `npm run test:uiux`：17/17；
- `npm run check:uiux:artifacts`；
- `npm run test:uiux:artifacts`；
- `npm run test:electron-uiux:artifacts`；
- `node scripts/test-settings-wa-electron.mjs`，包含失败重试、reload、重复 reopen 和 teardown；
- Chat Surface/Slot focused tests。

仍未闭合：

- 混合全局 lifecycle stress 曾观察到 listener 增长，需要归因；
- UI Apps smoke 受用户禁用的 dynamic-wallpaper manifest 阻断；
- Theme 仍有 legacy `body.classList` 读取；
- Settings legacy bridge 尚未完全退役。

不要把以上未闭合项写成“已完成”。

## 3. 本轮唯一业务目标

本轮目标是：

> 完整重构用户可见的 Settings Surface 和应用外围 UI/UX，同时冻结聊天内容呈现和聊天核心能力。

优先级：

```text
Settings schema / SettingsRoot
  → Theme + semantic tokens
  → Shell / workspace layout
  → Overlay / focus / account / notification
  → Creation Surface
```

不要在 Settings 和外围壳层尚未收口前扩展 Chat Slots、Apps/Embedded Surface 或业务子页面迁移。

## 4. 明确冻结边界

### 4.1 绝对不能修改

以下内容本轮视为业务冻结区：

- `StreamCoordinator` 的业务语义；
- `StreamSession`、`StreamProjection` 的 terminal/cancel/retry 规则；
- `MessageRenderer`、`ChatDomRenderer` 的消息内容投影语义；
- 聊天协议、IPC 消息格式和历史持久化；
- 聊天气泡样式和消息排版；
- 消息密度、消息字体、消息行高；
- 思维链显示；
- 代码块和工具结果显示；
- 输入框内部布局和 Composer 工具排列；
- 流式动画和流式显示策略；
- 插件 Loader、插件协议和动态壁纸运行时；
- Notes、Translator、Memo、Forum 等嵌入页面的业务逻辑；
- 用户数据格式和 persisted key。

设置页可以重新命名、分类和描述上述聊天相关字段，但不得改变这些字段的实际渲染行为。

### 4.2 可以重构

- SettingsRoot 的 DOM、导航、字段顺序和描述；
- Settings schema 与 presentation control；
- 自动保存、失败、重试和状态反馈；
- 主题、页面材质和 semantic token；
- 顶栏、左侧导航、工作区、右侧面板；
- Settings、Account、Notification、Launchpad、Modal、Overlay；
- 页面级圆角、边框、间距、字号、UI 字体和壳层密度；
- focus、Escape、keyboard、ARIA；
- UI-only typed adapters 和 Surface-local services；
- 已完成迁移字段对应的旧 presentation 删除。

## 5. 设置项重构规则

所有设置项必须从业务存储中分离出用户可见 schema：

```text
persisted key
  → canonical Settings definition
  → user-facing title / short description
  → control definition
  → typed snapshot / command adapter
```

每个字段必须记录：

```text
key
legacy DOM id/name
category
title
description
control type
read source
write command
dirty behavior
error/retry behavior
legacy owner
target owner
delete condition
```

表达规则：

- 标题短、具体、面向用户；
- 描述最多解释“它改变什么”；
- 不重复字段名、placeholder 和 helper text；
- 不暴露内部模块名、IPC 名称或实现术语；
- 一个字段只能有一个权威可见控件；
- 低频或开发者字段折叠到 Advanced，不删除业务能力；
- 聊天内容字段可以重新分类，但不改消息渲染。

推荐分类：

1. 常规；
2. 外观；
3. 工作区；
4. 聊天内容；
5. 连接；
6. 语音与助手；
7. 高级；
8. 关于与诊断。

优先迁移“外观”和“工作区”。连接、语音、Rust、Forum、运行时字段可以暂时通过 compatibility adapter 工作，但必须嵌入统一 SettingsRoot。

## 6. 当前推荐的下一切片

### R2-02C：Settings single-owner migration

不要新增更多零散 adapter，也不要继续批量迁移字段。当前唯一阻断切片是 Harness↔VCP 双页面 fixture 对照流水线；在该切片闭合前暂停字段迁移与 renderer 扩展。必须完成以下工作：

1. 保持并维护完整字段 ownership report；
2. 从真实 Harness 生产组件生成 fixture，和 VCP generated fixture 使用同一 viewport/DPR/font/theme；自动产出 DOM/computed-style/geometry/pixel 四层 diff；
3. 只做一个真实 `Field + Select` Light-DOM primitive vertical slice，并接入最小 renderer kernel；
4. 让该 slice 的真实控件从 `SettingsUiService.state` 读取、保存从 `save.execute` 发出；
5. 将 draft、dirty、autosave、retry、timeout、close flush 归入一个明确 owner；
6. 删除这些字段在 `settings-bridge.js` 中对应的 legacy projection；
7. 保留业务 DOM id/name 和 IPC capability；
8. 为字段迁移补齐 Electron failure/retry/reload/teardown evidence；
9. 归因混合 lifecycle stress 的 listener 增长；
10. 在对应 primitive 的 DOM/geometry/interaction/screenshot 证据闭合前，不扩展新的 Settings 字段；
11. 更新本文件和 `ui-runtime-2-roadmap.md` 的迁移账本。

### 完成条件

这一切片只有在以下条件全部满足后才能标记完成：

- 已迁移字段只有一个 projection owner；
- 已迁移字段只有一个 save command owner；
- dirty draft 不被外部 snapshot 覆盖；
- 保存失败保留输入并可重试；
- timeout 后迟到结果不能复活 UI；
- 关闭时 pending save 能 flush 或明确失败；
- reload 后读取 durable 值；
- teardown 后没有 listener、timer、subscriber、portal 或 stale marker；
- 对应 legacy projection 已删除，而不是继续 if/else 双轨；
- 聊天消息和流式回归证据保持通过。

## 7. Theme 迁移要求

Theme 下一步不是增加更多颜色变量，而是收口 ownership：

```text
ThemeService
  → ThemeSnapshot
  → one ThemeTokenPresenter owner
  → Shell / Settings / Overlay consumers
```

要求：

- 只有一个 owner 写 `document.documentElement.style` 的全局 token；
- 多个 Surface 只能消费 snapshot 或读取 CSS token；
- 一个 Surface dispose 不得恢复另一个 Surface 正在使用的 token；
- 逐步删除高频路径中的 `body.classList.contains('dark-theme/light-theme')`；
- 主题 token 只改变壳层和设置页，不重新定义聊天消息视觉；
- light/dark/system/reload/multi-consumer/dispose 都有测试。

## 8. UI Runtime 使用规则

可以使用：

- TypeScript；
- ESM；
- `UiServiceRegistry`；
- `UiScope`；
- `UiServiceDefinition`；
- typed adapter；
- Web Components 或显式 DOM renderer；
- native/Web Awesome fallback。

必须遵守：

- 新 UI service 必须同时有 definition、provider/adapter 和真实 consumer；
- registry 只允许 Surface-local assembly，不接入全局 Plugin Loader；
- 注册必须返回 disposer；
- async dispose 必须等待 quiescence；
- 不复制 durable state；
- 不通过隐藏旧控件 `.click()` 作为命令总线；
- 不新增第二套生命周期系统；
- 不把 `VCPUIUX` 全局对象扩展成 Mega Runtime；
- 生成 JS/d.ts 必须通过 artifact consistency gate。

### 8.1 Harness-compatible renderer 约束

本轮不自行发明一套无 React 的组件视觉。新 primitive 必须镜像 DeepSeek Harness 的 DOM/CSS/interaction/lifecycle contract，只替换 renderer：

- 默认 Light DOM；Web Component 只能作为生命周期壳，不能默认引入 Shadow DOM；
- 每个 primitive 同时拥有 DOM structure、CSS contract、interaction state machine 和 owner/dispose；
- provider 只处理 native/Web Awesome/fallback 实现，不能改变 visual、keyboard、ARIA 或 teardown 合同；
- 不先实现通用 Virtual DOM；仅在真实 Surface 需要时增加 mount/update/keyed list/event/portal/focus 能力；
- 每个生产 primitive 必须有 Harness source mapping，并通过 DOM nesting、computed geometry、interaction sequence 和 Electron screenshot 四类证据；
- 首个 primitive 只能随 R2-02C 的真实 Settings 字段落地，并删除其 legacy projection；没有真实 consumer 的 primitive 保持 candidate，不建公共 API。

## 9. 证据命令

### 每个 UIUX 切片至少执行

```bash
npm run check:uiux
npm run test:uiux
npm run check:uiux:artifacts
npm run test:uiux:artifacts
git diff --check
```

### Settings 变更必须执行

```bash
node scripts/test-settings-wa-electron.mjs
node scripts/check-settings-source-equivalence.mjs
node scripts/check-settings-unified-surface.mjs
```

### Theme 变更必须执行

```bash
npm run test:electron-uiux:artifacts
node scripts/test-appearance-studio.mjs
```

### 触及 Chat Surface/Overlay 才执行

```bash
node --test tests/overlay-coordinator.test.js \
  tests/chat-surface.test.mjs \
  tests/chat-surface-slots.test.mjs
npm run test:electron-main-chat-sequences
```

不要因为 Settings 改动而重写或放宽聊天测试；不要因为某个外部插件禁用而擅自启用用户插件。

## 10. 提交和并行协作规则

- 一个切片一个主题提交；
- 文档、代码和 focused tests 同一提交；
- 不要混入无关格式化、CRLF 改写或插件 Loader 改动；
- 不要修改其他并行进程正在负责的文件，除非先发送协调消息；
- 提交前报告工作树、base commit、changed files 和测试命令；
- 发现业务边界冲突时暂停扩展，先更新路线和本文件；
- 失败证据必须保留，不得通过扩大 allowlist、提高阈值或禁用检查让门禁变绿；
- 生成 artifact 必须用 `npm run build:uiux` 后再检查，不直接手改 generated 文件。

## 11. 明确禁止的下一步

在 R2-02C、Theme token ownership 和 listener stress 尚未闭合前，不要：

- 扩展 R2-04 Chat Surface Slots；
- 开始 R2-05 Apps/Embedded Surface；
- 迁移 Notes/Translator/Memo/Forum 页面；
- 重写消息 renderer 或流式渲染；
- 引入 Cordis、React 或 Vue；
- 建立全局 UI plugin container；
- 一次性把所有 JavaScript 改成 TypeScript；
- 为没有真实 consumer 的 primitive/service 建公共 API。

## 12. 交接回报格式

每个并行批次结束时，必须回复：

```text
Batch:
Base commit:
Changed files:
Production consumer:
Owner / disposer:
Legacy path removed:
Persisted keys / IPC unchanged:
Focused tests:
Electron evidence:
Known failures:
Next slice:
```

如果 `Legacy path removed` 为空，必须说明为什么仍然保留、对应删除条件和预计切片；不能只写“兼容保留”。

## 13. 最终目标

本轮不是迁移所有业务，而是完成一个高质量、用户可见的 UI/UX 垂直切片：

```text
完整 Harness-style Settings
  + 统一 Theme / Shell / Workspace UI
  + 明确 owner / snapshot / command / dispose
  + 可验证的失败、重试、reload 和 teardown
  + 聊天内容和流式核心零行为变化
```

只有在这个垂直切片稳定后，才评估 Creation、Chat Surface 和 Apps 是否值得继续迁移。
