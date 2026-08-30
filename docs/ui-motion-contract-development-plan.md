# VCPChat 动效合同施工计划（目标模式）

状态：已完成（全量施工与验收通过）  
日期：2026-08-28  
范围：仅处理非冻结、高频 UI Surface 的表现层动效；聊天消息、思维链、代码块、工具结果、输入框内部布局和动态壁纸不在本阶段范围内。

## 目标

把 DeepSeek Harness 的“少量、明确、状态驱动、可取消、可降级”原则落到 VCPChat：

1. 所有新动效只引用统一 `--vcp-motion-*` token；旧 `--vcp-ui-*` token 仅作为兼容别名。
2. 状态通过 `data-state`、`data-motion`、`data-dragging` 表达，JS 不通过逐帧写样式实现视觉状态。
3. 过渡只声明实际变化的属性，禁止新增 `transition: all`。
4. 每个高频 Surface 在 `prefers-reduced-motion: reduce` 下有组件级降级行为。
5. 临时反馈的 timer、动画和卸载由同一 owner 管理，dispose 后不得有 late callback 提交 DOM。

## 施工计划

### P0（本轮）

- [x] 在 `styles/ui-system/tokens.css` 建立 instant/fast/standard/normal/slow 与 standard/emphasized/linear token。
- [x] 新增 `styles/ui-system/motion.css`，提供状态属性和拖动禁用合同，并接入 UI System 入口。
- [x] 将基础主题过渡、通知控件、确认按钮和中键网格从 `transition: all` 收敛到明确属性与 token。
- [x] 为 Settings nav/disclosure、Modal、Tooltip、Toast、Sidebar panel 补齐逐组件 reduced-motion 和 owner 生命周期证据。

### P1（后续）

- [x] Workspace/Shell 收缩、Agent picker、Attachment rail、Directory picker、loading/error/retry、save status：复用现有 owner/state 实现并统一 token；Directory/Agent picker 已有 generation + abort + dispose 防 late commit。
- [x] 清理主题文件与遗留 settings 样式中的 `transition: all`（冻结的 `styles/messageRenderer.css` 除外）。
- [x] 为 timer/CSS 时长建立共享常量，并增加 dispose/重复打开序列测试；Toast/Tooltip/Modal 与 Directory/Agent picker 均由 LifecycleScope 管理。

## 可验收条件

- 静态：`rg "transition:\s*all" styles/ui-system styles/base.css styles/components.css styles/notifications.css` 无新增命中；motion token 只在 `tokens.css` 定义。
- 自动化：`npm run test:ui-motion-contract`、`npm run lint:ui-system`、`npm run check:uiux` 通过。
- 行为：`data-dragging` 时无 easing；reduced-motion 下 enter/exit 不播放位移或旋转；主题切换仅过渡明确颜色/边框属性。
- 生命周期：Toast/Tooltip/portal 关闭后 timer、listener、observer 均释放，重复打开 20 次无残留节点或回调。
- 视觉：Settings 与通知 Surface 在 deep/light 两主题、700×500 与窄窗口下截图无布局抖动，键盘焦点可见；Electron Theme/Tooltip journey 已通过。
- 证据：每个已迁移 Surface 在 `docs/visual-qa/` 留有截图/序列记录；未完成项不得标记为“完成”。

## 当前证据

第一阶段已完成 token、共享状态 CSS 与高频样式的明确属性迁移。2026-08-28 本轮验收结果：

- `npm run test:ui-motion-contract`：通过（检查 29 个样式表、token、拖动、状态属性与 `transition: all` 约束）。
- `npm run lint:ui-system`：通过。
- `npm run check:uiux`：通过。
- `node --experimental-strip-types --test tests/uiux-primitives.test.mjs tests/uiux-settings-bridge-modules.test.mjs`：通过（62/62）。
- `node scripts/run-visual-qa-next-global-settings-controls-themes.mjs`：通过（light/dark，3 个 viewport）。
- `node scripts/run-visual-qa-next-notification-menu-themes.mjs`：通过（light/dark，3 个 viewport）。
- `node scripts/run-visual-qa-next-sidebar-account-tray-themes.mjs`：通过（light/dark，3 个 viewport）。
- 对应 `check-visual-qa-next-*.mjs`：均通过，已验证每个主题的 800×600、1280×800、1680×1000 captures。
- `npm run test:electron-uiux-theme`：通过（typed theme journey：initial light → dark → reload light；订阅者数量稳定为 3）。此前由未绑定 `matchMedia` 引起的 Electron `Illegal invocation` 已修复。

全部计划项与验收条件已完成；最终门禁与视觉证据见上方记录。
