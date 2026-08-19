# 主聊天 UI 当前架构与交付基线

> 状态：当前事实的唯一权威文档
> 核对日期：2026-08-19
> 分支：`codex/design-system-upstream-no-workflow-20260817`
> 文档入口：[`README.md`](./README.md)

文件名中的 `next-ui` 是历史命名，不表示产品仍有 Classic/Next 两套主窗口。

## 1. 当前产品拓扑

主窗口只有一套 presentation，由 `main.html` 的
`data-vcp-ui-surface="main-chat"` 明确声明。运行时不存在布局切换 manager、模式状态通道、
Classic 主窗口 DOM 或 Classic/Next remount。

```text
上游聊天、助手、通知、设置与插件业务
├── 既有 manager / renderer / IPC / data protocol
├── MainChatCommands（共享操作入口）
└── canonical main-chat Surface
    ├── Shell controllers
    ├── AppTabHost / EmbeddedAppController
    ├── OverlayCoordinator / EscapeDispatcher
    ├── Appearance Studio / Ask Nova / Creation Surface
    ├── VCPUI adapter
    │   └── Web Awesome 离线行为内核或受控 native fallback
    └── 上游共享消息、输入、列表和插件业务 DOM
```

本轮收敛的发布阻塞项已经落到代码与门禁：内嵌 WebContentsView 只允许声明的本地页面继续导航，
外部 URL 转交系统浏览器；创建 Surface 在 Web Awesome 完整加载失败或部分注册时，整块切换到
同一 VCPUI 控件树的 native kernel；主题预览、持久化和主进程确认广播各只有一个权威事务；
`superdoc` 无生产消费者，已从生产依赖移除。`mainChatSurface` 是唯一标签宿主入口，旧
`topTabManager` 文件和运行时名称不再存在。

内嵌 Notes、Translator、Memo、Forum 等仍是上游独立页面。它们不使用主窗口 Surface，
也不接收 `uiMode` URL 参数；这是页面边界，不是第二套主窗口布局。

## 2. `uiMode` 现状

- 新设置不再生成或保存 `uiMode`。
- Appearance Engine、Studio、全局设置和操作序列不再接收 `uiMode` 参数或事件。
- 内嵌页面 URL 不再追加 `?uiMode=classic`。
- 内部能力判断统一经过 `window.VCPSurfacePolicy.isMainChat()`。
- `main.html` 已删除 `data-ui-mode`，主窗口只使用 `data-vcp-ui-surface="main-chat"`。
- 边界门禁禁止主聊天和子页面重新引入该历史标识。

`next-ui-*` ID、class 和 CSS 前缀仍属于视觉资源命名，不是运行时模式状态；运行时入口已统一为
`mainChatSurface`，避免业务代码继续依赖旧的 `topTabManager` 名称。

## 3. 已完成能力

| 能力 | 状态 | 主要证据 |
|---|---|---|
| 单一主窗口 Surface | 已完成 | retirement/delta boundary gate |
| Shell 控制器拆分 | 已完成 | `modules/ui-system/next-shell/` 窄控制器 |
| 生命周期所有权 | 核心完成 | `LifecycleScope`、Task、Overlay、renderer recovery 测试 |
| 原生 View 会话清理 | 核心完成 | close/destroy/reload/crash 与 replacement identity 测试 |
| 操作序列测试 | 可用基线 | 固定 seed、故障注入、trace 重放、资源不变量 |
| Appearance 单一状态 | 已完成本轮收敛 | 单一默认 profile、无 mode 参数、保存/回滚测试 |
| Web Awesome adapter | 已完成核心边界 | 离线 closure、manifest、失败终态、Surface scope ownership |
| 插件兼容边界 | 已保护 | Loader 不由 UI 生命周期接管 |
| 上游消息组件语义 | 已保护 | Next-owned CSS 不重绘结构化消息内部组件 |
| 上游子页面边界 | 已保护 | 12 个页面保持原页面、无 WA runtime、无 mode query |
| 启动主题门 | 已修复 | 有界 settings timeout、统一 fallback、非阻塞错误 host、启动门故障测试 |

## 4. 架构边界

本路线不做以下工作：

- 不改变聊天业务 DOM、manager、IPC 或数据协议。
- 不接管前端插件 Loader、第三方插件卸载或动态壁纸生命周期。
- 不重画代码块、工具结果、思考链、日记等上游结构化消息组件。
- 不给独立业务子页面批量套用 VCPUI 或 Web Awesome。
- 不引入 React、Vue、Solid 或第二套应用容器。
- 不因命名不理想而批量重命名稳定的 `next-ui-*` DOM identity。

## 5. 当前验证状态

本轮 canonical Surface 与启动主题门修复后的当前验证：

```bash
npm run check:ui-system
npm run test:electron-ui-apps
npm run test:electron-main-chat-group-sequences
git diff --check
```

上述命令已在 2026-08-19 当前工作树通过；`npm run test:electron-stability` 也通过，包含
设置竞态、主聊天序列和 3 次预热 + 20 次生命周期压力循环。提交前仍必须再次核对文件归属，
并确认 `styles/themes.css` 等用户独立修改未进入提交。

启动主题门的 reject、timeout、缺少 preload API、幂等释放和正常启动状态已有独立单元测试；
Electron smoke 另外确认正常启动后门已释放且错误 host 保持隐藏。

Windows 真机 DPI/IME、长时间 soak 和第三方插件组合仍属于发布证据，不可由 macOS 单元测试
替代。它们不阻止架构代码进入审查，但必须在发布判断中显式标注。

## 6. PR 就绪定义

达到以下条件才可称为“适合创建或更新 PR”：

1. 生产主聊天中不再存在 `uiMode` 运行时分支；历史设置字段只用于数据兼容读取。
2. 主聊天、设置、内嵌应用和生命周期门禁全部通过。
3. 相对目标上游分支无未解决冲突。
4. `styles/themes.css` 等用户独立修改未被误纳入。
5. 工作树中的并行改动已按所有权审查并形成可解释提交。
6. PR 描述明确区分自动证据、待补 Windows 证据和非目标。

在这些条件满足前，状态只能描述为“施工中”，不能沿用旧文档中的历史通过结论。

## 7. 后续顺序

1. 补齐 Windows DPI/IME、ASAR 增量失败和 30–60 分钟人工 soak 证据。
2. 持续运行现有生命周期、Web Awesome 和操作序列回归，不重复重构已完成的核心。
3. 任何子页面设计迁移必须独立立项并提供真实消费者、回滚与生命周期证据。

## 8. 更新规则

- 当前事实变化时，同一改动必须更新本文和对应边界测试。
- 施工日志写入提交或专项文档，不再追加到本文。
- 历史文档不得自称当前路线；文档权威关系由 [`README.md`](./README.md) 管理。
- 自动测试通过只能证明已覆盖路径，不得写成“没有任何 bug”。
