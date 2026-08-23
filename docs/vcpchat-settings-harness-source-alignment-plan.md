# VCPChat 全局设置：DeepSeek Harness 源码级对齐与旧实现清理

## 目标

全局设置只有一个 Settings Surface。它采用 Harness 的 SettingsRoot、导航、Section、Row、Select/Menu 与自动保存契约；业务节点（`id`、`name`、IPC、监听器）继续由现有表单拥有。Notes、翻译、日志等嵌入页面不在本项目范围内，也不建立 Classic/Next 两套全局设置布局。

## 对抗式基线（2026-08-23）

当前树仍有以下风险，不能以“加一层 CSS”视为完成：

- `settings-bridge.js` 仍保留历史的 `isNextUi` 命名和兼容注释，容易重新引入分支；全局 Surface 必须无 presentation branch。
- `.settings-form-group`、`.form-group`、`.form-group-inline` 原节点曾直接拥有 padding、gap、border、background；现已由 `vcp-harness-general-item` 包住，旧节点降为业务锚点。
- `.settings-subsection` 仍存在于业务 DOM；其卡片视觉已被统一 Surface 清零，`.settings-subsection-heading` 在有 canonical section heading 时运行时移除，防止重复标题/说明。
- Select 使用 native select 作为唯一业务节点、Harness trigger/menu 作为投影；文档/测试必须验证“恰好一个可见投影”。所有 document/window 事件由一个 Select owner 注册，避免每个 Select 重复监听。
- 动态 option 注入由表单 MutationObserver 触发重建，必须覆盖异步模型列表 hydrate、disabled、关闭、重开、reload。

## 施工顺序

1. **Canonical DOM**：为每个含业务控件的设置行建立 `vcp-harness-general-item`，写入 `data-setting-key` 与 `data-setting-primitive`；保留原节点语义和监听器。
2. **Surface ownership**：Root/Nav/Content/Section/Row/Control 各只有一个布局 owner。旧 wrapper 仅作兼容锚点，不得再提供间距、背景、边框或阴影。
3. **Primitive parity**：按 Harness 源码复用 16/24、14/22、12/18 typography；Select trigger/menu、Choice、Disclosure 的 hover/focus/selected/disabled 状态逐项对应。
4. **Lifecycle**：Select 的 outside/Escape/scroll/resize 由单一 owner 管理；动态 options 触发幂等重建并释放旧 projection。
5. **Field language**：设置项标题短句化，说明只保留一行有用的后果或范围；删除重复 helper、placeholder 与 tooltip。
6. **Evidence**：源码契约、CSS ownership、动态 DOM、Electron 真实鼠标/键盘序列、light/dark 与窄视口截图全部通过后才可宣称完成。

## 验收标准

- 全局设置不存在按 `classic`/`next` 分叉的 presentation 行为。
- 每个业务字段恰有一个 canonical row 和一个 authoritative control；legacy wrapper 不拥有布局属性。
- 普通 GeneralRow 无贯穿分割线；仅 Harness 规定的 AppearanceRow 保留 1px hairline，最后一行无线。
- Select 常态为静默灰色 trigger，menu 为独立 surface；Choice 不与 Select 重叠；native source 不可见但仍可序列化。
- Select 打开、选择、Escape、外部点击、滚动/resize 定位、动态 option hydrate、disabled 均可恢复且无 detached projection。
- 自动保存状态为 dirty/saving/saved/error，关闭时 flush，失败保留 draft。
- `git diff --check`、静态契约脚本、设置 UI/Electron gate 通过；缺失的 OS resize 能力必须在报告中明确标注，不能伪称已验证。

## 当前施工记录

- 已新增 canonical row wrapper 与 subsection heading 收口。
- 已将 subsection 卡片背景/内边距/阴影清零。
- 已将 Select 的 pointerdown、Escape、scroll、resize 监听收敛到单一 owner，并保留动态 MutationObserver 重建路径。
- MutationObserver 现在只对 select/option/disabled/selected 相关变更重建，避免 wrapper 自身变更造成重建循环，并覆盖异步 option hydrate。
- `node scripts/test-ui-system.mjs`、`node scripts/check-settings-unified-surface.mjs` 与 `git diff --check` 已通过。
- 已通过 `node scripts/test-settings-wa-electron.mjs`：真实 Electron 完成 Shell、Select/Choice、动态 assistant options、分类切换、搜索、深浅主题截图、IPC 保存、关闭与 reload restore。当前 Electron CDP 不支持 `Browser.getWindowForTarget`，所以日志明确标记 OS window resize skipped；700×500 renderer viewport 证据仍已生成。

## 严格同构施工增量（本轮）

- live modal 已改为直接组装 `panel > nav + content > header + options`，导航由原生 Harness-style button cell 持有，不再创建 VCPUI List 或搜索投影。
- close icon、header actions、options scroll owner、tab semantics 已迁移到 canonical tree；旧 layout 仅作为 teardown snapshot，不参与 live layout。
- legacy panel/nav/content/title class 在 mount 后从 live tree 移除，teardown 时按快照恢复，避免旧 CSS 级联继续拥有几何。
- 真实 Electron gate 已迁移到 canonical markers，并通过 Root/nav/header/options、动态 Select、保存/reload 和截图检查。

## 未完成的严格门槛（必须继续施工）

以下仍需继续推进，所以目标保持 active：

- `main.html` 模板中的 legacy row/subsection 与 inline style 已迁移为 canonical row/control-row 和受控 `data-vcp-style` 规则；source-equivalence 已清零。
- `styles/ui-system/settings.css` 的 legacy settings selector 已移除；剩余历史样式不参与统一 Surface ownership。
- Select 保留 native source，但 projection 已补齐 Harness Menu 的 list/viewport/itemWrap/itemLabel/check 层级；仍需继续扩展源码快照比对。
- Select projection 现已改为 body-level portal：打开时进入固定定位的 menu surface，关闭/teardown 时归还 wrapper，outside/Escape/resize owner 与 portal identity 一致。
- 尚未建立逐属性 computed geometry 与 Harness source snapshot 的自动等价 gate。
