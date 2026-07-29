# VCPChat 新版 UI 原生设计系统

> 当前审计（2026-07-28）：Agent Workbench 的 scope、`!important` 与 inline-style 违规已修复，`npm run check:ui-system` 现已通过；高频流式消息已改为稳定节点原地更新，避免重建侧栏、标题与输入区。下文的迁移台账仍包含历史验证记录，不能替代 [GUI 当前开发状态](gui-current-development-status.md) 的发布判断。任何标为 `migrated` 的旧记录仍须完成真实 Electron 回归后重新确认。

这套设计系统只服务于 `data-ui-mode="next"`，不迁移或覆盖经典 UI。实现使用原生 DOM、CSS Layer 和 ES Module，不依赖 Vue、React、Web Components 或额外构建步骤。

## 目录

- `styles/ui-system/`：字体、Token、组件和组件库应用样式。
- `modules/ui-system/vcp-ui.js`：组件注册表、工厂和反馈系统。
- `modules/ui-system/component-manifest.js`：组件类别、成熟度、版本和别名清单。
- `modules/ui-system/next-ui-apps.js`：新版 UI 内部应用注册表。
- `modules/ui-system/component-showcase.js`：用户可见的“UI 组件库”应用。
- `scripts/check-ui-system.mjs`：作用域、色值、字号、内联样式和注册唯一性门禁。

## Token 分层

`tokens.css` 中的变量分为三层：

1. Palette：基础强调色和状态色。
2. Semantic：背景、文本、边框、表面、焦点和阴影。
3. Component：控件高度、输入背景、悬停和聚焦边框。

现有 VCPChat 主题变量优先作为颜色来源。主题可在未来覆盖 `--vcp-ui-*`，设计系统本身不修改主题 IPC 或 `styles/themes.css`。

间距以 4px 为基准；字号只能引用 `--vcp-ui-font-*`；组件和展示页不得声明 Hex、RGB 或 HSL 裸色值。所有动效必须在 `prefers-reduced-motion` 下静态降级。

设计系统支持 `comfortable` 和 `compact` 两种密度。密度通过作用域上的 `data-density` 控制，不允许业务页面单独压缩某个组件的高度和 padding：

```js
VCPUI.setDensity(container, 'compact');
```

语义颜色使用 `bg-0` 至 `bg-4`、`text-0` 至 `text-3` 和 `fill-0` 至 `fill-2` 表达层级。组件不得直接推导新的透明度色值。

## 组件接口

```js
const button = window.VCPUI.create('Button', {
    label: '保存',
    variant: 'primary',
    size: 'md'
});

container.append(button.element);
button.update({ loading: true });
button.focus();
button.destroy();
```

控制器统一暴露 `element`、`update(patch)`、`focus()` 和 `destroy()`。组件状态使用 `data-variant`、`data-size`、`data-state` 和标准 `aria-*` 表达。输入类组件触发原生 `input`、`change` 事件。

已有业务 DOM 不应为了使用组件而一次性重建。使用增强接口保留原节点、ID、事件和业务引用：

```js
const controller = VCPUI.enhance('Range', existingRangeInput, {
    label: '语速',
    size: 'md'
});

controller.destroy(); // 清理组件状态，但不删除原 input
```

`enhance` 只用于已登记的渐进增强器。新增增强器必须保证 `destroy()` 后恢复原节点的组件类、ARIA 和 `data-*` 状态，不能接管 IPC 或业务数据。

当前清单包含 20 个稳定组件家族，以及 Divider、Tooltip、Skeleton、SegmentedControl、Pagination、ScrollArea、Range、SettingsSection、SettingsActionBar 九个候选组件。候选组件完成至少一次真实业务迁移和 Electron 视觉验证后才能升级为 `stable`。

反馈接口：

```js
VCPUI.feedback.toast('保存成功', { variant: 'success' });
const accepted = await VCPUI.feedback.confirm({ message: '确定删除吗？', danger: true });
const name = await VCPUI.feedback.prompt({ title: '项目名称', required: true });
VCPUI.feedback.setLoading(true, '正在保存');
VCPUI.feedback.setLoading(false);
```

Confirm 和 Prompt 按 FIFO 执行；Loading 使用引用计数；切换 UI 模式或卸载内部应用时调用 `cancelAll()`。

## 内部应用

```js
window.nextUiApps.register({
    id: 'example-app',
    title: '示例应用',
    icon: 'widgets',
    kind: 'internal',
    mount(container, context) {
        return () => container.replaceChildren();
    }
});
```

同一应用 ID 只打开一个顶部标签。关闭活动标签时优先激活左侧相邻标签；没有左侧标签则返回首页。外部 Electron 应用仍通过原有托盘 IPC 打开。

## 迁移台账

下列状态以实际 Electron 检查为准，`partial` 不得视为完成：

| Surface | Status | Evidence required before stable |
| --- | --- | --- |
| 顶栏、标签、应用启动器 | migrated | 明暗主题、标签关闭、内部应用复用，以及切换经典 UI 后的 Host/标签/反馈容器清理 |
| 全局 Toast 与反馈 Host | migrated | 新旧模式隔离、并发清理 |
| 聊天输入、附件与发送/中断 | migrated | 禁用、焦点、附件、发送与中断状态 |
| 侧栏、话题列表与通知抽屉 | migrated | 选中、滚动、通知打开与窄窗口 |
| 全局设置弹窗 | partial | 双栏导航、内容滚动、保存栏以及浅色默认/深色 700×500 真实审查已通过；每个分区的保存、错误与键盘关闭仍待完成 |
| Agent/Group 编辑表单 | partial | Agent/Group 已统一为扁平纯色设置模式；Input、Textarea、Select、Switch、Field、Range、SettingsSection 和 SettingsActionBar 已通过设置桥自动增强，并接收真实保存、删除、取消和失败状态。完整键盘焦点及 Electron 视觉矩阵仍待完成 |
| 其他业务弹窗 | partial | 通用外壳、输入和操作区已进入新版 Token 作用域；头像裁剪、全局搜索和筛选规则外壳已通过 Electron 首开、焦点和窄窗口检查，筛选规则编辑器及实际操作仍待逐项验证 |
| 聊天消息、工具调用和富文本内容 | partial | 基础消息、代码、附件、工具结果、摘要、思考链、桌面推送、日记与 Markdown 表格已 Token 化；消息表面、窄表格已验证壁纸透出与无横向溢出，长内容、错误、加载与最小窗口的完整矩阵仍待完成 |

迁移时应复用现有组件或补充通用能力，不在业务模块复制组件 CSS。经典 UI 不进入迁移范围。任何 `partial` 或 `pending` 表面都不能用于宣称新版重构已完成。

提交前运行：

```bash
npm run check:ui-system
```

该命令依次执行语法检查、Stylelint、静态门禁和 JSDOM 组件契约测试。

真实 Electron 验证记录与剩余矩阵见 [新版 UI Electron QA 矩阵](./ui-system-qa-matrix.md)。
