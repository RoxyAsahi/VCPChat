# 新版 UI Electron QA 矩阵

> 2026-08-03：业务子页面改为 allowlist。产品运行时仅笔记与翻译要求新版验收；归档页面必须验证在 `uiMode=next` 请求下安全回退经典 UI。Canvas 已恢复上游经典实现。参见 `docs/ui-active-surface-policy.md`。

本表只记录已经在真实 Electron 渲染器中执行过的检查。`partial` 不得作为发布完成的依据。逐页审计与截图见 `docs/ui-visual-audit-2026-08-02.md`。

| Surface | Verified | Remaining |
| --- | --- | --- |
| Shell、侧栏、输入区 | 新版字体、Material Symbols、焦点、无横向溢出；经典模式输入圆角回归 | 最小窗口人工截图复查 |
| 内部应用 | UI 组件库打开后切到经典 UI，会清理 Host、标签、展示页根节点和 Feedback Host | 组件库长时间打开的内存采样 |
| Web Awesome 运行时 | 3.11.0 已 vendor（`vendor/webawesome/dist-cdn`）；真实 Electron 验证：启动时零 WA 资源请求、`wa-*` 未注册；打开「UI 组件库」后按需注册并拉取 vendored 组件包；主题 CSS 引用计数加载/卸载 | 深色、compact、窄窗口完整截图；打包后资源解析 smoke 已新增脚本（`pack:check`）待打包产物驱动 |
| Web Awesome 适配器 | `WebAwesomeAdapter` 契约测试全过（属性/事件/`updateComplete`/refcount 主题/销毁/next 守卫）；业务目录门禁 `check:ui-applications` 生效（禁 `<wa-*>`、裸 `--wa-*`、CDN、未登记 `::part()`）；新增 Lucide 边界门禁（业务页禁直引 lucide 运行时，仅 main.html / ToolBox 许可） | — |
| UiModeController | 契约测试全过（幂等 mount、query/持久设置读取、订阅与销毁）；主进程向内嵌页下发 `?uiMode=` | 独立窗口动态 mode 订阅 |
| 应用页面组件 | `AppPageShell` / `WindowControls` / `AsyncBoundary` 已进清单（candidate）+ 组件库展示 | 业务页面全面接入验收 |
| 全局设置 | 真实 Electron 验证：next 模式下 `#globalSettingsForm` 控件增强、保存栏 SettingsActionBar 脏/保存态、搜索注入、焦点、切经典清理 | 7 个分区逐项真实保存/错误/键盘 Escape |
| 业务弹窗 | 头像裁剪、创建群组、模型、转发、正则、筛选规则与编辑器均可首开，均为 8px 作用域外壳 | 实际规则编辑与提交 |
| 全局搜索 | Ctrl+F 首开、输入聚焦、Escape、模式切换清理、空态 | 带真实结果的分页和跳转 |
| Agent/Group 设置 | 真实 Agent 选择、设置页、折叠区段；新旧模式样式隔离 | 保存、删除、校验、真实 Group 数据 |
| 消息与富内容 | 壁纸透出；消息、代码、工具摘要、思考链、桌面推送、日记、表格；700px 表格不溢出 | 真实长流、错误、工具调用、媒体和最小窗口 |
| 页面运行时 | 11 页保留 AppPageShell 重建（2 active、9 archived）；Canvas 恢复上游经典实现。真实 Electron 仍逐页验证 12 个业务表面及 next/classic 行为；几何、溢出、重叠、焦点、键盘、窄屏、长文本与空态断言全绿 | 见「逐页状态」；记忆页依赖后端初始化；便签正文区留白（D-05） |

### 逐页状态（基线 2444ffd6，详细见 `docs/ui-visual-audit-2026-08-02.md`）

| 页面 | 状态 | 备注 |
| --- | --- | --- |
| 便签 | Hermetic verified | 真 `wa-input`；正文 textarea 不填满高度（D-05） |
| 翻译 | 视觉通过 | `wa-tooltip`=3 + native 增强；覆盖 73.5% |
| 日志 | 视觉通过 | `wa-tooltip` + native 增强 |
| 插件 | 视觉通过 | `wa-tooltip` + native 增强；长列表（全页 4.9kpx）预期 |
| 任务 | Hermetic verified | 无表单控件（列表页）；空态首屏留白（数据相关） |
| 笔记 | 视觉通过 | `wa-tooltip` + native 增强 |
| 记忆 | Hermetic verified | 「初始化未完成」空态，依赖后端初始化 |
| 论坛 | 视觉通过 | 空态首屏留白（数据相关） |
| 协同Canvas | 经典实现通过 | 已恢复 `origin/main`，独立窗口不加载新版 runtime |
| 监听RAG | 结构迁移 | shell 挂载但 WA 参与为 0（tooltip 选择器指向不存在的按钮，D-02） |
| 工具ToolBox | 视觉通过 | 50 工具全 `wa-card`；Lucide≥2；焦点/键盘/空态/长文本/窄屏全过 |
| 数据VchatManager | 结构迁移 | uiMode 恒 classic，next 从不触发（D-03） |
| 全局设置 | 视觉通过 | 增强 + 保存栏 + 搜索 + 焦点，classic 拆除 |

所有本地验证前后均运行：

```bash
npm run check:ui-system
git diff --check
```

组件或页面只有在对应剩余项全部完成，并有新的 Electron 截图审查证据时，才可将 `partial` 升为 `migrated`。
