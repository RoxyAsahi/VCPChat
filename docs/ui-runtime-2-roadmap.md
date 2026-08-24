# VCPChat UI Runtime 2 动态开发路线

> 状态：施工中（目标模式已启动）  
> 建立日期：2026-08-24  
> 适用目录：`/Users/asahi/Documents/Codex/VCPChat-newarchitecture`  
> 对照对象：本机 `deepseek-harness` 的 Client UI / Slot / Theme / lifecycle 机制
> 上位规范：[vcpchat-harness-uiux-architecture.md](/Users/asahi/Documents/Codex/VCPChat-newarchitecture/docs/vcpchat-harness-uiux-architecture.md)；本文件只负责执行顺序、consumer、证据与删除账本
> 最近核验：2026-08-24；R2-00 Composer slice 已达到 complete；R2-01 Overlay/notification slice 已闭合；R2-03 为 semantic-token-projection-active；R2-08 为 scoped-service-assembly-active（仍委托 legacy LifecycleScope，public API 未就绪）；R2-02 为 typed-settings-command-active；当前 active slice：Settings scoped assembly → 剩余真实控件迁移与旧 bridge 收缩
> 最近证据：`node --test tests/chat-surface.test.mjs tests/chat-surface-slots.test.mjs tests/main-chat-surface-adapter.test.mjs tests/chat-plugin-manifest.test.mjs`（19/19）；`npm run test:electron-main-chat-sequences`（next-main-chat-default，24 actions，25 VCP requests，required 1/1）
> R2-01 证据：`node --test tests/overlay-coordinator.test.js tests/escape-dispatcher.test.js tests/notification-menu-controller.test.js`（9/9）；`node scripts/test-ui-system.mjs`；`node scripts/test-settings-wa-electron.mjs`（Settings Harness structure gate passed）。R2-03 证据：`npm run test:uiux` 的 ThemePresenter semantic token/teardown 合同；`node scripts/test-appearance-studio.mjs`。R2-08 证据：`npm run check:uiux`；`npm run test:uiux`（Settings、Theme、scoped registry contracts）；`npm run check:uiux:artifacts`；`npm run test:uiux:artifacts`；仍缺 artifact-only Electron smoke，故不声明 public runtime ready。

## 0. 这份文档的职责

这是一份动态路线账本，不是一次性设计宣言。它只记录四类事实：

1. 当前目标模式与已经进入生产的代码；
2. 每个阶段的真实消费者、退出证据和未闭合风险；
3. 当前施工批次、下一批次和明确非目标；
4. 相对上一版路线的新增、删除和原因。

每次进入新的施工批次，必须同时更新本文件的“状态账本”、对应代码、最小测试和证据链接。计划中的能力不得写成已交付；只有生产消费者、owner、撤销路径和行为证据齐全，才能从 `planned` 变为 `active` 或 `complete`。

## 0.3 上位规范到执行批次的映射

`vcpchat-harness-uiux-architecture.md` 是范围、冻结边界和 Definition of Done 的权威来源；本路线不再重复定义另一套目标架构。执行关系如下：

| 上位规范 | 本路线执行批次 | 当前状态 |
| --- | --- | --- |
| U0 事实与架构冻结 | R2-00 前置登记、工作树和证据账本 | complete |
| U1 TypeScript UI foundation | R2-08 `modules/uiux/` typed kernel | scoped-service-assembly-active（局部 registry + Settings producer/consumer；public API not ready） |
| U2 Overlay / Focus / Primitive kernel | R2-01 | notification/lease slice complete，journey 持续补证据 |
| U3 Theme service | R2-03 | semantic-token-projection-active（legacy theme reads remain） |
| U4 Settings Surface | R2-02 | typed-settings-command-active（state projection/controls still partly legacy） |
| U5 Shell 与 Chat Surface | R2-00、R2-04 | Chat Composer slice complete，Shell 持续迁移 |
| U6 App Surface | R2-05 | planned |
| U7 旧 UI 清理与发布证据 | R2-07 | planned |

新 UI 公共 API、primitive 和 Surface 从 R2-08 起默认使用 TypeScript；当前既有 JavaScript 改动只作为有编号的迁移适配层，不扩展新的稳定 UI API。

## 0.1 长期目标（North Star）

最终目标是把 VCPChat 的 UI/UX 变成接近 DeepSeek Harness 的可组合运行时，而不是在旧架构外面继续包一层 wrapper。激进重构只发生在 UI/UX 边界；业务域与聊天核心保持冻结。

```text
任意高频 UI 任务
  → 一个明确的 typed UI adapter（Domain snapshot / command / subscribe）
  → 一个明确的 Surface owner
  → 一个明确的 Slot graph occupant
  → 一套 TypeScript primitive / Web Component / theme / focus contract
  → 一条真实 Electron 操作序列
  → 可重放、可回滚、可长期 soak 的证据
```

目标模式必须包含：

- `Service Definition → Provider / Electron adapter → Consumer / Surface`；
- `Effect / Scope / Owner / Dispose` 生命周期，所有 UI 副作用可等待撤销；
- `Snapshot / Command / Subscribe` 状态合同，UI 不复制 durable state；
- TypeScript DOM renderer、Web Components、native/Web Awesome fallback；
- 每个迁移 Surface 完成后删除旧 presentation 路径，而不是永久保留 wrapper；
- StreamCoordinator、StreamSession、StreamProjection、消息协议和持久化作为冻结业务边界，只允许 UI 通过 adapter 消费。

允许的激进方向：

- 将 `main.html` 从“所有页面结构的真源”降级为兼容壳，并逐步把高频 Surface 的结构迁入 owned mount root；
- 将 `renderer.js` 从业务与 DOM 的总装配器收敛为 composition adapter；
- 将 `settings-bridge`、`appearance-studio`、`next-shell` 等 bridge 按任务切片删除，而不是无限扩展；
- 让 Slot graph 成为内部 UI 扩展和未来皮肤/工作流能力的正式入口；
- 在完成真实 consumer 与证据后，激进删除重复 DOM、selector、全局状态和旧 facade。

禁止的激进方向：

- 不复制聊天 durable state；
- 不把消息协议、流式 renderer、插件 Loader、动态壁纸和 Electron 主进程边界重写为 UI Runtime；
- 不用“迁移完成率”替代用户任务、生命周期和跨平台证据；
- 不保留一个没有生产消费者的 Mega Runtime 只因为路线图已经写过。

## 0.2 昼夜持续推进协议

这条路线可以长期推进，但每个自动施工批次必须是有限、可审查、可回滚的切片：

1. 读取当前账本和工作树，确认唯一 active slice；
2. 选择一个真实生产 consumer，写出 invariant、owner、rollback 和 evidence command；
3. 先做最小代码变更和 focused tests，再决定是否扩大范围；
4. 任何异步/跨进程/视觉声明都必须追加真实终态证据，不能用固定延时或文档推断；
5. 批次结束时更新 `last_verified`、consumer report、删除项和下一切片；
6. 连续两个批次没有真实 consumer，自动转 `dormant` 并删除该抽象。

## 1. 目标模式

VCPChat 不复制 Cordis，也不引入 React/Vue；不重写聊天协议、消息渲染器或 Electron 插件 Loader。目标模式是：保留已有业务 owner，通过 typed UI adapter，把 UI 从“共享旧 DOM + selector + bridge”逐步变成“业务 snapshot/command → Surface/Slot → TypeScript DOM renderer / Web Component kernel”。

```text
上游业务 manager / stream / IPC
              ↓
Domain adapter / snapshot / command
              ↓
VCP UI Runtime 2
  ├── Surface owner（LifecycleScope）
  ├── Slot registry（single/list/keyed/chain）
  ├── snapshot + subscribe（不复制 durable state）
  ├── overlay / focus / async contract
  ├── semantic theme tokens
  └── Native / Web Awesome / fallback provider
              ↓
DOM、Web Components、原生 Electron View
```

### 1.1 与 Harness 的对应关系

| Harness 原则 | VCPChat 目标模式 | 明确不照搬 |
| --- | --- | --- |
| Slot declaration / registration | `VCPUI.runtime2.slots` | 全局 Cordis 容器 |
| Fiber effect | `LifecycleScope` + Surface owner | 每个 DOM 节点一个 fiber |
| Session-scoped props | 领域 snapshot / projection | 第二份聊天 Store |
| Theme service | `ThemeSnapshot` + semantic token presenter | 业务模块读写 `body.classList` |
| React renderer boundary | Native/WA provider adapter | 引入 React/Vue 作为全应用容器 |
| Dispose to quiescence | `SurfaceController.dispose()` + owner scope | fire-and-forget cleanup |

### 1.2 不变量

- 一个动态 Surface 只有一个 owner；owner 负责 listener、timer、observer、overlay、IPC task、临时 DOM 和注册项。
- 注册必须返回 release，并随 owner 撤销；不存在只有测试或展示页消费者的稳定公共 API。
- UI 只读取权威业务状态或只读 projection，不创建第二份 durable state。
- `open → focus → interact → commit/cancel/error → restore focus → teardown` 是所有高频 Surface 的共同合同。
- provider 在 mount 前选择并保持稳定；Web Awesome 失败只能回退到同一视觉/交互合同的 native kernel。
- 目标模式新增代码必须能与现有主窗口一起运行；迁移按 Surface/任务切片，不按文件机械重写。

## 2. 当前事实基线

### 2.1 已有、继续复用

- `LifecycleScope`、`SurfaceController`、`ContributionRegistry`；
- Web Awesome 离线 adapter 与 native fallback；
- 主聊天既有 manager、stream、message renderer、IPC 和插件 Loader；
- 主窗口单一 presentation 收敛结果；
- Electron 操作序列、生命周期压力和真实终态测试。

### 2.2 仍然落后的核心

- `main.html` 仍是页面结构真源；
- `renderer.js` 和 `modules/renderer` 仍有大量全局 DOM 查询和直接写 DOM；
- VCPUI 主要是既有节点增强器，不是可组合的 Slot/Surface runtime；
- 主题、设置和显示状态存在多种相互投射的来源；
- 全局设置只有部分 Harness-style 结构，其他高频 Surface 尚无统一交互合同；
- UI 行为合同和任务级视觉证据尚未覆盖完整高频路径。

### 2.3 当前工作批次

```yaml
batch: R2-02
mode: target
focus: scoped-settings-service-assembly-and-real-controls
status: active
production_consumer: global SettingsRoot + Appearance Studio
consumer_kind: internal production consumer; typed adapter migration slice
first_slice: existing settings capability boundary + modules/uiux/adapters/settings.ts
completed_slice: semantic token projection + scope-owned SettingsUiService registry assembly + appearance/font/streaming/base-text control projections, combo-control synchronization, legacy projection gating, and Electron evidence
next_slice: migrate remaining SettingsRoot controls to SettingsUiService commands, then retire matching legacy bridge presentation paths
blocked_by: UI Apps smoke 的 dynamic-wallpaper disabled-manifest readiness（不阻塞 Settings Surface contract）
excluded: chat-message-internals, plugin-loader, child-page-migration
last_verified: 2026-08-24
evidence: npm run check:uiux; npm run test:uiux; node --test tests/creation-controller.test.js; node scripts/test-ui-system.mjs; node scripts/test-appearance-studio.mjs; node scripts/test-settings-wa-electron.mjs; npm run test:electron-uiux-theme
```

## 3. 分阶段路线

### R2-00：Chat Surface Slots 目标模式合同（已完成）

目标：在已有 `createChatSurfaceSlots` 原型上建立最小可运行的 Slot 合同，并由真实的 `standalone-chat-history` 内部应用消费。组件库展示页不能单独作为 Stable 公共 API 证据。

必须交付：

- 演进 `modules/chat/chatSurfaceSlots.js`：registration owner、priority、scope、inject、diagnostics，并抽出可声明允许 Slot 集合的 `createSlotRegistry()`；
- 复用现有 `LifecycleScope` / `SurfaceController`，不再创建第二个 Surface runtime；
- Slot registration 的 owner 绑定、release、absence 诊断；
- Slot mount 失败时同步回滚已创建的贡献，异步 disposer 由现有 Surface owner 等待；
- 一个真实生产 consumer；
- Node contract tests 和静态 `node --check`。

退出证据：注册 → 展示 → owner dispose → Slot absent；mount 失败不留 DOM/listener；重复 mount/dispose 结果稳定；主聊天附件按钮保留 DOM identity、事件和 ARIA，并在 Surface dispose 后恢复原父级位置。

### R2-01：Shell / Overlay / Focus 合同

目标：统一 Topbar、Launchpad、Account Menu、通知、Ask Nova 和 Modal 的 open/focus/dismiss/restore 行为。

不新增第二套全局弹窗 Store；在现有 `OverlayCoordinator` 上提供窄的 owner/lease 合同。

当前进度：`OverlayCoordinator.acquire(owner, { restoreFocus })` 已记录 lease 的 focus origin，并在最后一个 owner release 时恢复；global modal visibility 与 CreationController 已共享该路径。EscapeDispatcher 仍负责优先级决策，避免把 Escape 逻辑塞进 OverlayCoordinator。

退出证据：真实 Electron 键盘路径、Escape 优先级、Select 不误关 Modal、关闭后焦点恢复、owner 资源归零。

### R2-02：Settings / Creation 页面模式

目标：将全局设置和 Agent/Group 创建抽象成稳定页面模式，而不是继续复制表单 DOM。

页面模式统一包含：Field、Section、Choice/Select、ActionBar、Error、Autosave/Submit、Dirty 状态。

退出证据：保存成功/失败/取消/迟到结果；输入保留；重新打开读取 durable 值；native/WA/fallback 视觉与键盘合同一致。

当前 SettingsRoot 状态（2026-08-24）：全局 Settings form submit 已通过 `VCPUISettingsBridge.getTypedService().save.execute()` 进入 typed command owner；`SettingsUiService` 现由 bridge-owned child scope 内的局部 `UiServiceRegistry` 安装，生产 consumer 通过 `get('settings-ui')` 获取，显式 release、owner teardown、逆序 dispose、provider failure rollback 与 generated artifact smoke 已有 focused 证据。该 registry 只用于 UI service assembly，不接入 Plugin Loader、chat manifest 或全局插件协议。clean external snapshots 现在真实驱动用户身份、服务器 URL、摘要模型、Home、Appearance（density/radius/typography/fontScale/contentWidth/surface/sidebar geometry）、字体 preset/custom、聊天气泡和 smooth streaming 控件；checkbox 使用 `checked` 投影，sidebar radius radio group、range output（px）与 hidden compatibility select 同步，dirty/in-flight 时仍拒绝外部覆盖。`mainChatSettingsPresentationOwner` 已在 typed service 可用时停止覆盖这些迁移字段，保留其余未迁移业务控件；`node scripts/test-settings-wa-electron.mjs` 已覆盖 clean projection、失败保存、重试、重载恢复和 owner teardown。其余读取投影、dirty/autosave 编排仍主要由 legacy `settings-bridge.js` 与 global settings manager 控制，因此 R2-02 整体仍是 typed-command-active 而非完整 Settings consumer。

Creation 现状核验（2026-08-24）：`tests/creation-controller.test.js` 8/8 通过，覆盖命令缺失、Surface 部分失败回滚、Web Awesome 失败后的 native fallback、重复 open、kernel 加载期间 dispose、创建失败恢复和迟到完成隔离。完整 `test-electron-ui-apps-smoke.mjs` 当前不能作为 Creation 的 broad evidence，因为它在进入 Creation journey 前被用户禁用的 `VChatDynamicWallpaper/plugin-manifest.json.block` 阻断（`loaded=true, results=[], dynamicWallpaper=false`）；本路线不擅自启用该插件，下一切片将使用独立 Creation Electron journey 补齐真实 Surface 证据。

### R2-03：Theme Runtime 与语义 Token 真源

目标：主题状态只有一个 snapshot owner，组件不再通过 `body.classList` 猜测主题。

退出证据：source → generated artifact → runtime presenter 一致；light/dark/system、壁纸、DPI 和 fallback 矩阵通过。

当前状态：`ThemePresenter` 已根据 snapshot 投射 light/dark semantic CSS custom properties、`color-scheme` 与诊断属性，并由 Scope dispose 恢复旧 token；但 legacy `body.classList` 读取、部分 surface material/control states 仍存在，因此状态仅为 semantic-token-projection-active，不得描述为单一主题真源完成。

### R2-04：Conversation Surface Slots

目标：为 Composer leading/trailing、消息 action、turn tail、tool view 建立局部 Slot；不重写结构化消息内部 renderer。

退出证据：真实聊天入口可挂载/撤销 slot；流式、取消、主题切换、长消息和 renderer reload 不产生孤儿贡献。

### R2-05：Apps / Embedded Surface

目标：Launchpad、AppTabHost、WebContentsView 和内部 App 统一使用 Surface/Slot contract。

退出证据：注册、打开、激活、reload、crash、注销、tab/session 恢复后，DOM、View、IPC task、listener 和 registry 对账归零。

### R2-06：高频任务与可访问性证据

目标：将 `open → focus → interact → terminal → teardown` 固化为任务级 Electron 测试和视觉基线。

退出证据：主窗口高频路径可仅用键盘完成；ARIA 与真实 DOM 同步；主题、DPI、窗口尺寸、reduced-motion 和 fallback 有矩阵记录。

### R2-07：条件式业务子页面演进

只在某个 Notes/Translator/Forum/Memo 页面存在真实需求时迁移。每个页面必须独立提交 consumer、runtime、teardown、Electron 证据；不以“全站统一”为理由提前迁移。

## 4. 已完成施工记录：R2-00 第一切片

第一切片有意保持很小：它不改主聊天、不改插件 Loader、不替换现有 `VCPUI.create()`，只把已有聊天 Slot 原型推进到目标模式合同，并由 standalone-chat-history 作为第一个真实 consumer。

目标 API：

```js
const slots = createChatSurfaceSlots();
const release = slots.register('chat.composer.leading', 'voice', mount, {
  owner: scope,
  priority: 20,
  scope: 'session-maybe',
});
const owned = slots.mount('chat.composer.leading', host, snapshot, { scope });
```

本切片的 API 仍是内部目标模式，不进入 `window`，不注册新的全局 registry kind。未来 R2-08 的 TypeScript foundation 只提供 typed service/scope adapter；不得平行创建第二套 Slot/Surface 实现，也不得用 `createUiRuntime2()` 之类的空 facade 代替真实 consumer。

## 5. 证据与门禁

| 变更轴 | 最小证据 | 扩展证据 |
| --- | --- | --- |
| Slot/Surface kernel | Node contract tests + `node --check` | UI System + Electron app |
| Settings/Overlay | focused tests + real DOM terminal | Electron keyboard/task journey |
| Theme/token | source/artifact static gate | light/dark/DPI/GPU screenshots |
| Chat slots | stream/owner tests | main chat sequence + reload/crash |
| Embedded App | controller tests | lifecycle stress + packaged smoke |
| Cross-platform claim | 不得只用单机替代 | Windows/macOS + manual soak |

## 6. 明确非目标

- 不引入 React、Vue、Cordis 或全应用插件容器；
- 不重写聊天协议、消息节点、流式渲染、VCPTool 或动态壁纸；
- 不通过隐藏 Classic 控件 `.click()` 作为命令总线；
- 不把所有既有业务状态复制进 UI Store；
- 不为了视觉一致一次性迁移所有 Classic 子页面；
- 不把组件库独占展示页消费者直接升级为 Stable 公共 API；
- 不以单台机器绿色测试宣称跨平台、打包或人工 soak 完成。

## 7. 动态更新规则

- 每个施工批次使用唯一 `batch` 编号；完成后保留证据链接和实际代码入口。
- 新增公共 API 必须同时写出 producer、consumer、owner、release 和测试；否则保持 internal/candidate。
- 若一个阶段连续两个批次没有真实 consumer，回退到 `planned` 并删除空 runtime。
- 每次迁移都记录“新增、删除、保留”三张表，优先净删除 selector、facade、重复状态和 bridge。
- 发现跨越业务、provider、主题、生命周期多个轴时，拆成多个批次，除非它们不可分割。

## 8. 当前下一步

1. 先把 R2-03 从 snapshot projection 推进到真正 semantic token presenter，并记录/逐步删除 legacy theme reads。
2. 再让 SettingsRoot 的真实控件通过 `SettingsUiService.state` 与 `save.execute` 工作；在行为等价证据后删除旧 presentation bridge 路径。
3. R2-08 已进入 scoped-service-assembly-active：`modules/uiux/package.json` 建立局部 ESM boundary；scope-owned `UiServiceRegistry` 已由 Settings 生产 bridge 安装并被 SettingsRoot consumer 读取；artifact gate 以临时干净目录重建并逐字节校验 14 个 generated JS/d.ts 文件，artifact smoke 实际加载 generated SettingsUiService 与 registry 执行 save/subscribe/release/dispose contract。runtime 仍委托 legacy `LifecycleScope`，且缺 artifact-only Electron smoke，因此不声明 public runtime ready。
4. 保持 R2-00/R2-01 的能力由真实 consumer 驱动，不开放任意 selector/HTML 注入，也不创建第二套生命周期或 durable UI Store；Plugin Loader 与 chat plugin protocol 保持冻结。

补充门禁记录：本批补回 `nextUiNotificationForum` / `nextUiNotificationMemo`，并让 NextShell controller 成为唯一 owner；旧 `event-listeners.js` 中对应的重复 document-level binding 仍保持注释隔离。Plugin Loader 与 chat plugin manifest 的越界改动已回退，UI Runtime 只消费既有插件能力；完整 UI Apps smoke 仍受 `VCPDistributedServer/Plugin/VChatDynamicWallpaper/plugin-manifest.json.block` 外部 readiness blocker 影响，本轮不擅自启用用户禁用插件。
