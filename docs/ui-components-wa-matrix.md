# VCPUI 组件 × Web Awesome 支撑矩阵

> P2 更新：子页面预载 runtime 已因零生产消费者删除。下列组件矩阵仍描述 VCPUI 的 WA/native 内核能力；子页面预载时序属于历史方案，不是当前产品拓扑。

本表描述 **VCPUI 每个组件**在主窗口按需加载和原生回落时的实际行为内核：

- **next（WA 已加载）**：`html[data-ui-mode="next"]` 且主窗口 runtime 已按需定义对应 `wa-*` —— 组件由 Web Awesome 提供行为/无障碍内核。
- **next（WA 预载失败）**：`loadComponents` 拒绝（`vcp-webawesome-failed` 已派发），全部 `wa-*` 保持未注册 —— 与经典模式相同的原生 DOM 回落。
- **classic / 无预载上下文**：主渲染器或经典模式，从不获取 WA bundle —— 原生 DOM 回落。

判定开关只有一处：`vcp-ui.js` 的 `waControl(tag)` —— 每次调用时检查 `VCPWebAwesome.isDefined(tag)`，**不存在“随机回落”**。

## 组件矩阵

| 组件 | next + WA 预载 | WA 内核元素 | classic / 预载失败回落 | 兼容桥（旧调用方路径） |
| --- | --- | --- | --- | --- |
| Button | ✅ | `wa-button`（variant/appearance/size/loading/disabled） | 原生 `<button>`（data-variant/aria-busy） | — |
| IconButton | ✅ | `wa-button`（appearance=plain/outlined/filled，aria-label/aria-pressed/title） | 原生 `<button>` | — |
| Input | ✅ | `wa-input`（value/disabled/readonly/required/placeholder/type/size/selection/validity/leading+trailing slot） | `<span.vcp-ui-input-wrap>` + 原生 `<input>` | 只通过 controller 的 `control/getValue/setValue/focus/select/setSelectionRange/setRangeText/validity`；不伪造 native DOM |
| Textarea | ✅ | `wa-textarea`（value/rows/resize/placeholder/selection/validity/…） | `<span.vcp-ui-textarea-wrap>` + 原生 `<textarea>` | 与 Input 相同的 provider-neutral controller；无 detached shim 或 Shadow DOM 查询桥 |
| Select | ✅ | `wa-select` + `wa-option`（value/placeholder/disabled/required）；`enhance()` 使用可见 Proxy | 原生 `<select>` | 原生节点继续作为表单真源，双向同步 `.value`、`.options`、`.selectedIndex`、`add/remove` 与 `input/change`；动态节点由 `observeControls()` 接入 |
| Card | ✅ | `wa-card`（appearance=filled/outlined，交互态 aria-pressed） | 原生 `<section|button>` | — |
| Tabs | ✅ | `wa-tab-group` + `wa-tab` + `wa-tab-panel`（`active` 属性、`wa-tab-show` → `change`） | `<div role="tablist">` + 按钮（方向键/Home/End 轮转） | — |
| Dialog / Modal | ✅ | `wa-dialog`（label/open/light-dismiss、`wa-after-hide` → destroy + 焦点恢复） | `<div.vcp-ui-modal-overlay>` + `<section role="dialog">`（Escape/Tab 环回/背板关闭） | — |
| Tooltip | ✅ | `wa-tooltip`（`for`/placement/content） | `<span.vcp-ui-tooltip>` + 气泡（aria-describedby） | — |
| Checkbox | ✅ | `wa-checkbox`（checked/indeterminate/disabled/required/value、`change` 事件） | `<label.vcp-ui-checkbox>` + 原生 `<input type="checkbox">` | `element.checked`、`querySelector('input')`（`bridgeCheckedControl`） |
| Switch | ✅ | `wa-switch`（checked/disabled/required/value、`change` 事件、role=switch） | `<button role="switch">`（aria-checked、click 切换） | `element.checked`、`querySelector('input')` |

## 未进入 WA 内核的组件（始终原生 DOM）

`Range`、`Field`、`SettingsSection`、`SettingsActionBar`、`Badge`、`Alert`、`Toolbar`、`List`、`TableFrame`、`EmptyState`、`Divider`、`Skeleton`、`SegmentedControl`、`Pagination`、`ScrollArea`、`Toast`、`ConfirmDialog`、`InputDialog`、`AppPageShell`、`WindowControls`、`AsyncBoundary`。其中 `ConfirmDialog` / `InputDialog` 内部由 `Modal` + `Button` 组合，因此 **在 next+WA 下其弹层与按钮内核真实来自 Web Awesome**。

## 加载时序与降级路径

1. 主 Renderer 保持启动零注册，只在主聊天设置表面实际打开时由 `vcp-main-ui-runtime.js` 懒加载；当前没有业务子页面加载 VCPUI/WA runtime。
2. 成功：`vcp-webawesome-loaded`（tags）→ `waKernel: 'web-awesome'`。
3. 失败：`vcp-webawesome-failed`（tags + error）→ 所有 tag 保持未定义 → 每个 `VCPUI.create` 走原生回落 → `waKernel: 'native'`。
4. 业务 Surface 通过 VCPUI adapter 创建控件，并以 adapter runtime 状态验证 WA 或 native fallback；不依赖子页面 ready 事件。

## 验证证据

- Select 迁移契约：`npm run test:ui-system` 与 `npm run check:ui-applications` 通过；覆盖双向值同步、动态 options、单次事件、动态 observer、重复 enhance、销毁恢复和原生 controller 的延迟升级。
- `test-ui-system.mjs`：
  - 原生回落行为套件：Button loading/disabled 吞点击、IconButton aria-label、Input disabled/readonly/required/invalid/focus、Textarea rows/resize、Select value/disabled、Checkbox change、Switch role/aria-checked、Tabs 方向键轮转（roving tabindex）、Card aria-pressed、Tooltip aria-describedby 销毁清理、Modal Escape 关闭。
  - WA stub 内核套件：13 个 `wa-*` stub 注册后逐组件验证 tag、属性映射、loading/disabled/checked 切换、`wa-tab-group.active`、`wa-tab-show → change`、`wa-dialog` 打开、Tooltip `for` 关联；Input/Textarea 明确断言不存在 native shim，Field 直接关联 WA host，Select proxy 继续以原生业务节点为真源。
  - lucide 别名表 760 条全部命中 vendored UMD；VCPUI 使用图标名全部可解析。
- `test-webawesome-adapter.mjs`：`isLoaded`/`isDefined`、`translateEvent`、`mountScope`（token+主题联合释放）、`awaitUpdate`（updateComplete）、`loadComponents` 失败确定性（恰好一个结果事件、tag 保持未定义）、`create` 属性翻译。
- `test-vcp-ui-text-controls.mjs`：真实 Electron/WA Shadow DOM 验证 Input/Textarea 无 shim、属性映射、composition 顺序、selection、password、Field label/description、FormData/reset、validity、change-only autofill、focus 与 destroy；当前证据平台为 macOS arm64。
- 真实 Electron 运行时可进一步人工复核：`node scripts/test-electron-ui-apps-smoke.mjs`（E 组只读冒烟）。

## 遗留风险

- `wa-input`/`wa-textarea` 的 invalid 视觉态通过 `aria-invalid` + `setCustomValidity` 传递；深色/紧凑主题下 WA 控件细粒度间距需真实 Electron 截图复核。
- Input/Textarea 的真实 macOS Electron/WA Shadow DOM、composition、selection、autofill/change、password、form reset 与 validity 已有专门证据；Windows 中文输入、DPI/缩放与人工输入法确认仍待完成。stub 套件只证明 facade 合同，不代表跨平台行为。
- Checkbox/Switch 仍有 Shadow DOM 查询兼容桥，将在 Stage 5 单独收敛；它不再作为 Input/Textarea 的实现先例。
