# VCPChat Harness UI/UX 架构重构规范

> 状态：已采纳，作为 UI/UX 重构的上位约束
> 
> 目标：在不引入 React/Vue/Cordis、不改造业务域和聊天核心的前提下，使 VCPChat 的 UI/UX 运行时、Surface、组件、主题和生命周期尽可能接近 DeepSeek Harness 的源码组织方式；当前施工目标为 R2-02C Settings single-owner migration。

## 1. 范围与冻结边界

### 1.1 本次允许激进重构的范围

- UI/UX Runtime 与 Surface 组合方式；
- TypeScript UI 包和类型边界；
- Settings、Theme、Shell、Overlay、Chat Surface 的 presentation；
- Web Components、DOM renderer、primitive、slot、focus 和 overlay；
- UI 状态的 snapshot/command/subscribe 投影；
- UI 生命周期、effect、owner、dispose、异步终态和诊断；
- UI 专用的 typed IPC adapter；
- UI CSS、tokens、主题、可访问性和视觉证据；
- 删除重复 UI DOM、旧 selector、旧 presentation facade 和无消费者 UI bridge。

### 1.2 本次明确冻结的范围

- VCP 协议和消息协议；
- StreamCoordinator、StreamSession、StreamProjection 的业务语义；
- 消息持久化格式、ChatRepository 和历史数据；
- 流式 chunk 顺序、terminal、cancel、retry 和 persistence 行为；
- 模型调用、工具执行、插件 Loader 和主进程业务服务；
- Notes、Translator、Memo、Forum 等业务子页面的业务逻辑；
- 用户数据迁移和旧配置格式；
- Cordis 或其他全局插件容器。

UI Runtime 可以消费这些能力，但不得复制、替代或重新解释它们。

## 2. Harness 源码对应原则

| DeepSeek Harness | VCPChat UI/UX 实现 | 约束 |
| --- | --- | --- |
| Plugin composition | `UiModule` + `UiSurface` + `UiScope` | 仅用于 UI/UX，不接管业务插件 Loader |
| Service Definition / Provider / Consumer | UI service definition / Electron adapter / Surface consumer | 每个 UI 能力必须有真实 consumer |
| `ctx.effect()` / reversible registration | `UiScope.effect()` / disposer | 注册即拥有，销毁即撤销 |
| Typed event map | UI event contracts | 事件表达事实，不替代 snapshot |
| Session projection | Domain snapshot projection | UI 只读业务快照，不复制 durable state |
| React renderer boundary | TypeScript DOM renderer / Web Components | 不引入 React/Vue |
| Package invariant | UI contract/invariant gate | 每个公共 UI 能力必须有可执行不变量 |
| Source/artifact plane | TS source + Electron built smoke | 源码测试不能替代产物测试 |
| Profile/bundle composition | UI surface manifest / provider manifest | 只描述 UI provider，不扩展业务配置系统 |

## 3. 目标架构

```text
Electron main / preload business capabilities
                ↓ typed UI adapters
┌──────────────────────────────────────────────┐
│ VCPChat UI/UX Runtime                         │
│  UiContext                                    │
│  UiScope / Effect                             │
│  UiServiceRegistry                            │
│  Snapshot / Command / Subscribe               │
│  SlotRegistry                                 │
│  OverlayCoordinator / FocusScope              │
│  ThemePresenter / TokenResolver               │
│  Diagnostics / Invariants                     │
└──────────────────────────────────────────────┘
                ↓
┌──────────────────────────────────────────────┐
│ UI Surface consumers                          │
│  SettingsSurface   ThemeSurface               │
│  ShellSurface      MainChatSurface            │
│  OverlaySurface    AppSurface                 │
└──────────────────────────────────────────────┘
                ↓
 TypeScript DOM renderer / Web Components / native fallback

Existing business domain and chat runtime remain below this boundary.
```

UI Runtime 不创建聊天 Store，不接管流式 renderer，不直接操作业务 IPC。它通过 typed adapter 读取状态、发出命令，并负责 presentation 生命周期。

## 4. TypeScript 策略

### 4.1 默认规则

- 新增 UI/UX 代码默认使用 TypeScript；
- 使用 ESM 和严格类型检查；
- 类型定义、运行时代码、Electron adapter、Surface consumer 分离；
- 旧 JavaScript 允许作为迁移适配层，但不得成为新公共 UI API 的实现语言；
- 不为迁移而一次性重写业务 JavaScript。

### 4.2 推荐目录

```text
modules/uiux/
  runtime/       scope, effect, services, diagnostics
  contracts/     snapshots, commands, events, manifests
  primitives/    field, select, menu, disclosure, overlay
  surfaces/      settings, shell, chat, apps
  providers/     theme, ipc, native, webawesome
  adapters/      existing business and Electron adapters
```

是否进一步拆成 workspace package，必须由真实 UI consumer 和构建收益证明；目录拆分本身不是完成标准。

## 5. UI Service seam

每个 UI 服务必须由三部分组成：

```text
Definition
  → Provider / Adapter
  → Consumer / Surface
```

例如设置：

```text
SettingsUiDefinition
  → ExistingSettingsManagerAdapter
  → SettingsSurface
```

例如主题：

```text
ThemeUiDefinition
  → ThemeSnapshotAdapter
  → ThemePresenter + Surface consumers
```

禁止：

- Surface 直接访问全局业务变量；
- Surface 直接拼接 IPC payload；
- 为 UI 方便复制一份业务持久化状态；
- 只为测试或展示页建立公共 UI service；
- 没有真实 consumer 的 registry kind。

## 6. 生命周期和 Effect 规范

所有 UI 副作用都必须属于一个 `UiScope`：

- DOM listener；
- timer、observer、animation；
- overlay lease；
- focus capture/restore；
- portal/menu；
- UI IPC subscription；
- Slot contribution；
- async task 和 abort signal。

`dispose()` 必须：

1. 先撤销提交权和 generation；
2. 取消新任务；
3. 撤销注册、listener、overlay 和 DOM contribution；
4. 等待 in-flight async work 到达 quiescence；
5. 允许重复调用且结果稳定。

Surface 关闭、导航、renderer reload、WebContentsView crash 和 setup 失败都必须走同一 owner teardown 路径。

## 7. 流式聊天保护合同

UI/UX 重构不得改变以下链路：

```text
IPC chunk
  → StreamCoordinator
  → StreamSession
  → StreamProjection
  → existing ChatDomRenderer
```

UI Runtime 只提供 `MainChatSurface`、Slot、Theme、Overlay 和 Focus consumer。它不得：

- 接管 chunk；
- 决定 terminal；
- 复制 stream state；
- 改写消息协议；
- 改写持久化格式；
- 通过隐藏旧控件转发聊天命令。

每个 UI 迁移切片都必须继续通过 chunk 顺序、取消、重试、历史切换、迟到结果隔离、terminal persistence 和 Surface dispose 测试。

## 8. Harness-compatible Renderer 策略

目标不是重新设计一套“没有 React 的 VCP UI”，也不是只在现有节点上叠加 class。目标是建立一个 **Harness-compatible renderer**：复刻可验证的 Harness DOM、CSS、交互和生命周期合同，只将 React renderer 替换为窄的 TypeScript DOM renderer。

```text
Harness React component
        ↓ 同构 contract
VCP Harness-compatible primitive
        ↓
TypeScript Light-DOM renderer / lifecycle shell
        ↓
Native / Web Awesome / fallback provider
```

第一阶段默认使用 Light DOM。Web Component 可以作为 mount、update、dispose 的生命周期壳，但不得把可见结构、CSS 或业务状态藏进 Shadow DOM。这样 Harness CSS 能直接镜像，DOM nesting 与 computed style 可比较，语义 token 也能穿透到 Surface。只有确有浏览器隔离需求的控件才可以提出 Shadow DOM 例外，并必须单独记录其等价验证方法。

### 8.1 Primitive 合同

每个 primitive 不是一个 CSS class，而是以下四层的唯一 owner：

1. Harness 对应的 DOM structure、class name 和 ARIA；
2. 源码镜像的 CSS geometry 与 semantic-token 映射；
3. 完整 interaction state machine；
4. listener、portal、focus 和 transient DOM 的 lifecycle owner。

例如 `Select` 必须拥有 trigger、保留的 native business select、menu portal、option rows 以及 `closed/open/focused/hovered/selected/disabled/outside-dismissed/escape-dismissed/destroyed` 状态。它不读取 IPC、不保存 settings、不持有聊天状态。

renderer 第一阶段只提供显式 mount/update/dispose、keyed list、属性/text 差异更新、owner-bound event、portal 和 focus restore；不得为了概念完整性先造通用 Virtual DOM。provider 只能替换底层实现，不能改变 primitive 的 DOM 语义、尺寸、键盘、Escape/outside-dismiss、ARIA 或 teardown 合同。

### 8.2 源码映射与等价门禁

每个进入生产的 primitive 必须在 `docs/reference/deepseek-harness-primitives/` 下登记源文件和保留项；VCP 实现文件顶部也必须注明 Harness 来源。不得手工“重新解释”间距、line-height、radius 或状态色；颜色仅允许通过 VCP semantic token 映射。

等价门禁分为四层，缺一层只能保持 candidate：

1. DOM nesting：关键节点、tag、class 和 ARIA 与参考 contract 对齐；
2. computed geometry：字体、line-height、padding、gap、border 与 radius 逐项采样；
3. interaction sequence：hover、focus、keyboard、disabled、outside-dismiss、Escape 和 dispose；
4. screenshot diff：同一 Electron 主题与窗口条件下可解释的像素差异。

当前 Settings 仍处于 R2-02C 单一 owner 迁移，不得在其遗留 projection、Theme token owner 和 listener 增长闭合前批量实现 primitive。首个实现只能服务一个真实 Settings 字段批次，并同时删除相应 legacy presentation 路径。

## 9. 迁移顺序

### U0：事实与架构冻结

- 将本文设为 UI/UX 架构上位规范；
- 明确 `next-ui-current-state.md` 只记录事实；
- 将 `ui-runtime-2-roadmap.md` 改为执行路线，不再定义范围；
- 登记当前并行未提交改动，禁止与设置合并提交混淆。

### U1：TypeScript UI foundation

- 建立 UI/UX TS 编译入口；
- 实现 `UiScope`、`UiEffect`、`UiServiceRegistry` 最小内核；
- 为旧 JS UI 模块提供 typed adapter；
- 加入 source/artifact 和 contract gate。

退出条件：一个真实 Settings 或 Overlay consumer 使用 TS Runtime，并能通过 reload/dispose/异常回滚。

### U2：Overlay / Focus / Primitive kernel

- Overlay lease；
- Escape priority；
- focus capture/restore；
- Select/Menu/Disclosure；
- keyboard and ARIA contract；
- native/Web Awesome fallback。

退出条件：真实 Electron 操作序列覆盖打开、聚焦、交互、取消、错误、关闭和焦点恢复。

### U3：Theme service

- 唯一 `ThemeSnapshot`；
- semantic token presenter；
- light/dark/system；
- DPI、壁纸和 fallback；
- 禁止组件自行读取 `body.classList` 猜测主题。

退出条件：所有 UI Surface 从同一 snapshot 更新，且主题切换不产生 detached projection。

### U4：Settings Surface

- 保留当前唯一 Harness-style SettingsRoot；
- 将设置桥接改为 typed adapter；
- 字段 schema、自动保存、错误恢复、Select/Menu/Choice 统一；
- 删除旧表单 presentation、重复 CSS 和旧 owner；
- 保持 persisted key、IPC 和业务节点兼容。

退出条件：设置页完成源码几何门禁、Electron light/dark、键盘、自动保存、失败重试、reload restore。

### U5：Shell 与 Chat Surface

- Topbar、Launchpad、Account、Notification、Ask Nova；
- Main Chat Surface 和 Standalone Chat Surface；
- Slot graph 仅开放真实 consumer；
- 不进入消息内部 renderer。

退出条件：主聊天流式、取消、历史、reload/crash 和 Slot dispose 全部维持现有证据。

### U6：App Surface

- AppTabHost；
- WebContentsView session；
- overlay 与 embedded view 对账；
- reload/crash/注销恢复。

退出条件：View、DOM、IPC、listener、task、registry 资源对账归零。

### U7：旧 UI 清理与发布证据

- 删除迁移 Surface 的旧 DOM 和旧 facade；
- 完成 source/artifact、invariant、snapshot、Electron 和人工 soak；
- 只在真实跨平台/打包证据齐全后宣称发布就绪。

## 10. Definition of Done

一个 UI/UX 切片只有同时满足以下条件才算完成：

- 使用明确的 UI Service Definition / Provider / Consumer；
- 新代码使用 TypeScript，旧 JS 仅作为有编号的迁移适配层；
- 所有副作用有唯一 owner 和可等待 dispose；
- 没有复制业务 durable state；
- 没有隐藏旧控件命令总线；
- 有真实生产 Surface consumer；
- 有 focused contract test；
- 有真实 Electron 操作序列；
- 有主题、键盘、焦点、错误、reload 和 teardown 证据；
- 迁移完成后旧 presentation 路径被删除或明确阻断；
- 不改变聊天流式、协议、持久化和插件业务行为。

## 11. 明确不做

- 不引入 Cordis；
- 不引入 React/Vue；
- 不重写聊天核心和流式渲染；
- 不迁移用户数据格式；
- 不为所有业务子页面提前建立通用 Runtime；
- 不以组件库展示页作为生产 consumer；
- 不以“已经有一个 wrapper”代替旧实现删除。
