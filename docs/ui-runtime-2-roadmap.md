# VCPChat UI Runtime 2 动态开发路线

> 状态：施工中（目标模式已启动）  
> 建立日期：2026-08-24  
> 适用目录：`/Users/asahi/Documents/Codex/VCPChat-newarchitecture`  
> 对照对象：本机 `deepseek-harness` 的 Client UI / Slot / Theme / lifecycle 机制
> 上位规范：[vcpchat-harness-uiux-architecture.md](/Users/asahi/Documents/Codex/VCPChat-newarchitecture/docs/vcpchat-harness-uiux-architecture.md)；本文件只负责执行顺序、consumer、证据与删除账本
> 最近核验：2026-08-26；R2-00 Composer slice 已达到 complete；R2-01 Overlay/notification slice 已闭合；R2-03 为 semantic-token-projection-active；R2-08 为 scoped-service-assembly-active（仍委托 legacy LifecycleScope，public API 未就绪）；R2-02 为 typed-production-consumer-active（legacy bridge、Classic fallback 与完整 stress 证据仍未闭合）。目标模式本轮收窄为可测量的 Harness 等价链：`reference pack → 单个 Light-DOM primitive → SettingsRoot 真实 consumer → DOM/geometry/interaction/screenshot/artifact 证据 → 删除对应 legacy presentation`。当前 active slice：R2-02C `harness-reference-pack-and-first-primitive-vertical-slice`；已接入的 primitives 只算迁移期 production slices，不代表完整 renderer 或 pixel-level equivalence 已完成。
> 本轮补充 Harness `Input` reference pack（DOM/geometry），作为下一批 range/choice 之前的 CSS/DOM 基线；尚未将 Input 或 Range 宣布为生产 primitive。
> 2026-08-26：`homeVisualTagline` 已接入 TS Light-DOM Input primitive，保留 native input 与 SettingsUiService 业务链；源码 `npm run test:uiux` 21/21、Settings Electron gate 通过。该字段 legacy input wrapper 已跳过，待 artifact-only Input smoke 与完整 screenshot geometry 证据后再扩大迁移。
> 2026-08-26：generated-only Electron smoke 已覆盖 Input primitive（`vcp-uiux-input-wrap`）的产物加载与 teardown 路径；`node scripts/test-electron-uiux-theme.mjs` 通过。
> 2026-08-26：`appearanceSidebarRadiusChoice` 已接入 TS Choice primitive；Settings Electron gate 已验证 native option count、selected source、option class 与点击切换。legacy startup fallback 仍保留，待 reload/Classic 等价证据后退役。
> 2026-08-26：generated-only Electron smoke 已覆盖 Choice artifact（挂载、native selected source、dispose 路径）；`node scripts/test-electron-uiux-theme.mjs` 通过。
> 2026-08-26：`appearanceSidebarAvatarSize` 已接入 TS Light-DOM Range primitive，native range 仍为唯一业务源，output 同步与 teardown 由 scope 管理；源码 `npm run test:uiux` 23/23、Settings Electron gate 通过。尚未扩大到其他 range 字段。
> 2026-08-26：Range 批次已扩展至 `appearanceSidebarRowHeight` 与 `appearanceCustomRadius`，三字段共用 TS Range contract；Settings Electron gate 验证三字段挂载，源码 UIUX tests 通过。下一步补 generated-only Range smoke 与三字段 legacy projection retirement。
> 2026-08-26：generated-only Electron smoke 已覆盖 Range artifact 的挂载、input→output 同步和 teardown 路径；`node scripts/test-electron-uiux-theme.mjs` 通过。
> 2026-08-26：Range output projection 已从 `appearance-studio.js` 移除，三字段 output 现在由 TS Range primitive 单一 owner 负责；appearance engine 仅保留规范化与语义应用。Settings Electron gate 与 UIUX tests 通过。
> 2026-08-26：Range 批次 source-equivalence 审计通过（legacy rows/inline styles/selectors 均为 0）。`global-settings-manager.js` 对 range 的读取是持久化命令输入，不属于 presentation projection；启动 fallback 仍按 reload/Classic 等价条件保留。
> 2026-08-26：`showHomeVisualBrand` 与 `showHomeVisualTagline` 已接入 TS Toggle primitive；native checkbox 保持业务源，legacy `.slider` presentation 在该字段上隐藏并由 owner teardown 恢复。源码 `npm run test:uiux` 24/24、Settings Electron gate 通过。
> 2026-08-26：generated-only Electron smoke 已覆盖 Toggle artifact 的 checked source、legacy slider 隐藏和 teardown 路径；`node scripts/test-electron-uiux-theme.mjs` 通过。Toggle 双平面证据闭合。
> 2026-08-26：Toggle generated smoke 进一步断言 dispose 后 native checkbox 回到原始 label、legacy slider display 恢复为空；artifact 可逆性闭合。
> 2026-08-26 latest checkpoint：Toggle/Range/Choice/Input/Select/ThemeTokenOwner 全部启用后，Settings Electron gate、generated artifact smoke、60-cycle lifecycle stress 均通过；stress 指标稳定为 listeners 618、resources 341、nodes 8410、detached 0。
> 2026-08-26：ColorPair 接入后再次完成 Settings-only 60-cycle stress；listeners 625、resources 347、nodes 8412，cycle 1→60 稳定且 detached roots/options/icons 为 0。
> 下一候选 `userAvatarBorderColor` 为 color input + text mirror 双控件，已建立 `color-pair.dom.json` / `color-pair.geometry.json` 基线；在单一 source/mirror owner、invalid-text 恢复和双控件 teardown 证据齐全前不接入生产。
> 2026-08-26：ColorPair 已完成 production integration；artifact consistency（34 files）、artifact smoke、Theme Electron journey 与 Settings-only 20-cycle stress 均通过。该双控件现可作为后续 color/text Settings 字段迁移模板。
> 2026-08-26：Settings Electron journey 新增 ColorPair snapshot probe，外部 `userAvatarBorderColor` 更新会同步刷新 color source 与 text mirror；双控件 snapshot ownership 证据闭合。
> 2026-08-26：Settings Electron journey 新增 Home Visual Toggle snapshot probe，验证两个 checkbox 可由外部 snapshot false→true 往返恢复，且不触发聊天业务路径；Toggle ownership 证据闭合，旧 startup fallback 仍按兼容边界保留。
> 2026-08-26：新增 Toggle DOM/geometry reference pack（`toggle.dom.json`、`toggle.geometry.json`），与已通过的 generated-only artifact smoke 对齐。
> 当前 primitive ledger：Field、Select、Input、Range、Choice、Toggle 均已有 TypeScript Light-DOM 实现；Settings 外观/首页字段已按单一 typed owner 接入，覆盖源码测试、generated artifact smoke、Electron DOM/geometry/interaction、snapshot/reload 与 60-cycle lifecycle stress。R2-02C 仍未 complete：ThemeTokenOwner、剩余未迁移 Settings 字段、Classic fallback 收口和全量 legacy deletion 仍是后续工作；聊天渲染/流式/协议/Plugin Loader 继续冻结。
> 2026-08-26：修正 `check-chat-kernel-consumers.mjs` 依赖扫描为忽略注释文本；`npm run guard:chat-kernel-consumers` 重新通过（17 kernel files），未修改任何聊天运行时代码。
> 2026-08-26 checkpoint：`npm run test:uiux` 25/25、`npm run check:uiux:artifacts`、`npm run guard:chat-kernel-consumers` 全部通过；primitive 与聊天冻结边界保持稳定。
> 2026-08-26：在 ThemeTokenOwner + Toggle/Range/Choice/Input 全部启用后重新完成 Settings-only 60-cycle stress；listeners 618、lifecycle resources 341、nodes 8410 全程稳定，detached roots/options/icons 仍为 0。
> 2026-08-26：ThemeTokenOwner 已落地为 document-level reference counting；多个 ThemePresenter 共存时，单个 presenter dispose 不会恢复/清空仍被其他 presenter 使用的 semantic tokens。`npm run test:uiux` 25/25 通过。
> 2026-08-26：ThemeTokenOwner 变更后的 generated artifact smoke、Electron theme journey、Settings Electron gate 全部通过；主题切换/reload 与 Settings visual contract 未回归。
> 2026-08-26：Settings-only 60-cycle lifecycle stress 通过；cycle-1..60 listeners 620、lifecycle resources 337、nodes 8406、detached roots/options/icons 0，确认 Range/Choice/Input 扩展未引入 listener 或 owner 增长。Range 三字段不存在旧 presentation fallback；仅保留 global-settings-manager 持久化读取。
> 2026-08-26：Classic parity 与 retirement boundary guards 均通过；Range 三字段在旧路径中仅保留 global-settings-manager 的持久化读取和 appearance-studio 的规范化/语义应用，无重复 presentation output 写入。新增 `range.dom.json` / `range.geometry.json` reference contract。
> 最近证据：`node --test tests/chat-surface.test.mjs tests/chat-surface-slots.test.mjs tests/main-chat-surface-adapter.test.mjs tests/chat-plugin-manifest.test.mjs`（19/19）；`npm run test:electron-main-chat-sequences`（next-main-chat-default，24 actions，25 VCP requests，required 1/1）
> R2-01 证据：`node --test tests/overlay-coordinator.test.js tests/escape-dispatcher.test.js tests/notification-menu-controller.test.js`（9/9）；`node scripts/test-ui-system.mjs`；`node scripts/test-settings-wa-electron.mjs`（Settings Harness structure gate passed）。R2-03 证据：`npm run test:uiux` 的 ThemePresenter semantic token/teardown 合同；`node scripts/test-appearance-studio.mjs`。R2-08 证据：`npm run check:uiux`；`npm run test:uiux`（Settings、Theme、scoped registry contracts）；`npm run check:uiux:artifacts`；`npm run test:uiux:artifacts`；`npm run test:electron-uiux:artifacts`（Electron 仅加载 generated browser-entry 并执行 generated Settings adapter save/dispose contract）；`tests/uiux-service-registry.test.mjs`（parent invalidation、reverse unwind、async disposer quiescence）。仍不声明 public runtime ready，因为 UiScope 继续委托 legacy LifecycleScope，且缺完整 packaged artifact/跨平台证据。

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
| U4 Settings Surface | R2-02 | typed-production-consumer-active（legacy bridge retirement and broad lifecycle evidence pending） |
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
batch: R2-02C
mode: target
focus: harness-reference-automation-and-primitive-contract
status: active
production_consumer: global SettingsRoot + Appearance Studio
consumer_kind: internal production consumer; typed adapter migration slice
first_slice: existing settings capability boundary + modules/uiux/adapters/settings.ts
completed_slice: semantic token projection + scope-owned SettingsUiService/RustAssistantUiService assembly + typed SettingsRoot observation, failure/retry/timeout/late-result/teardown evidence
next_slice: automate Harness DOM/computed-style/state diff for Input/Field/Select, then use the diff to drive one production primitive contract and only afterward resume Forum/Settings field expansion
blocked_by: UI Apps smoke 的 dynamic-wallpaper disabled-manifest readiness（不阻塞 Settings Surface contract）
excluded: chat-message-internals, plugin-loader, child-page-migration, generic-vdom-before-consumer
last_verified: 2026-08-26
evidence: npm run check:uiux; npm run test:uiux; node --test tests/creation-controller.test.js; node scripts/test-ui-system.mjs; node scripts/test-appearance-studio.mjs; node scripts/test-settings-wa-electron.mjs; npm run test:electron-uiux-theme
```

2026-08-26 target-mode correction：目标工具中的 objective 保持 active 且无法原地改写，因此以本账本作为可执行目标的权威镜像。后续批次不得以“更多字段已迁移”作为单独进度；必须先闭合 Harness reference、Light-DOM contract、真实 consumer、四层等价证据和对应 legacy deletion。聊天渲染/流式/协议/持久化/Plugin Loader 继续冻结。

2026-08-26 target-mode verification：目标收窄后的最小证据集通过：`npm run check:uiux`、`npm run test:uiux`（26/26）、`npm run check:uiux:artifacts`（34 generated files）、`npm run test:uiux:artifacts`、`node scripts/check-settings-source-equivalence.mjs`（legacyClean=true）、`node scripts/test-settings-wa-electron.mjs`（Settings Harness structure gate passed）以及 `npm run guard:chat-kernel-consumers`。本批没有新增字段迁移，未触碰聊天冻结边界。
2026-08-26：新增 `npm run check:harness-reference`，对 reference pack 的 17 个文件、8 个 primitive DOM/geometry 合同执行可重复静态门禁。Forum `adminUsername/adminPassword` 暂不进入施工：全局提交路径仍会编排 Forum 保存，直接接入字段 owner 会形成第二个 command owner；待 dirty/autosave seam 可单一化后再推进。
2026-08-26：Forum `adminUsername` / `adminPassword` 已进入 typed field-owner 阶段：TS Light-DOM Input primitive 提供 32px/8px/8px geometry 与 scope-owned teardown；字段 owner 负责 debounce、save、failure/retry 状态和 close flush，native inputs 与 ForumConfigUiService 保持业务/command source；全局提交路径在 owner 挂载时跳过重复 Forum save。Electron Settings gate 新增两项 primitive DOM 断言并通过；仍需补齐独立 failure/timeout/reload/teardown 证据后，才能删除剩余 legacy orchestration。
2026-08-26 lifecycle correction：Forum owner 已将 `run` 注册到 state，`flushSettingsAutosave()` 现在可以在关闭时真正提交 pending credentials；此前只设置 timer 而未暴露 run 的缺口已修复，`check:uiux`、global save regression 与 Settings Electron gate 通过。
2026-08-26 Forum owner evidence：Settings Electron journey 新增真实 username 输入保存、password close-flush、重新打开持久化恢复断言；`ForumConfigUiService` state 与 Input DOM 均验证通过。failure/timeout 注入和剩余 legacy orchestration 删除仍待独立批次。
2026-08-26：`ForumConfigUiService` 新增确定性的 `timeoutMs` adapter 合同；hung save 会返回 retryable failure，不再依赖文件权限模拟。`tests/uiux-forum-config-adapter.test.mjs` 覆盖 timeout，generated artifact consistency/smoke 与完整 UIUX tests（27/27）通过。
2026-08-26 artifact evidence：`test-uiux-artifact-smoke.mjs` 新增 generated Forum timeout 场景；源码与 generated 平面的 hung-save→retryable-failure 合同均通过。
2026-08-26 primitive contract alignment：TS Input primitive 现在复刻 Harness 的 `wrap → optional icon → input.input` Light-DOM 层级，并优先使用 `--dsw-alias-*` token、保留 VCP fallback；dispose 精确恢复原始 input class/父级。`npm run test:uiux` 27/27 与 artifact consistency 通过。该切片仍不等同于全量 pixel diff。
2026-08-26 renderer-kernel slice：新增 `modules/uiux/runtime/dom-renderer.ts`，提供 scope-owned `mount`、text update 与 keyed insertion/dispose；首次真实 contract test 通过，暂不作为 public runtime API 或通用 Virtual DOM。
2026-08-26 renderer-kernel update：keyed handle 新增 deterministic `update()`，覆盖 reorder/add/remove 后的节点复用与 owner dispose；`npm run test:uiux` 28/28、generated artifact consistency 通过。kernel 仍仅服务 UIUX 内部真实 consumer。
2026-08-26 renderer-kernel portal：`DomRenderer` 新增 owner-bound `portal(node, container)`，支持节点迁移、原位置恢复和 dispose；与 keyed update 一起形成 mount/update/keyed/portal/dispose 最小合同，测试 28/28 通过。
2026-08-26 renderer-kernel listener：新增 scope-owned `listen(target, type, handler)`，dispose 后 listener 不再触发；renderer kernel 最小合同现覆盖 mount/update/keyed/portal/listen/dispose，`npm run test:uiux` 28/28 通过。
2026-08-26 target-mode checkpoint：目标模式继续保持 active，但本阶段验收口径进一步收窄为可测量的 Harness 等价链。Field description/error 节点已通过 `DomRenderer.mount` 接入一个真实 Settings primitive consumer；source-plane bridge 与 generated artifact 已同步，`npm run check:uiux`、`npm run test:uiux`（28/28）、`npm run build:uiux`、`npm run check:uiux:artifacts`、`npm run check:harness-reference`、`npm run check:harness-contracts` 全部通过。该 checkpoint 只证明 renderer kernel 的真实 consumer 接入，不提升为 public runtime 或 pixel-equivalent；下一切片固定为 Input/Field/Select 的固定 viewport DOM/computed-style/state 快照与 diff 自动化，并在证据闭合后删除对应 legacy presentation。
2026-08-26 primitive state contract：新增 Input/Field/Select 的 disabled、selected、error、`aria-describedby` 与 teardown 回滚测试；`npm run test:uiux` 29/29 通过。该证据仍属于 jsdom 行为合同，尚不能替代 Electron 固定 viewport 的 computed-style/pixel diff。
2026-08-26 generated snapshot gate：新增 `npm run check:harness-snapshot`，从 generated artifact 实际挂载 Input/Field/Select，并依据 reference pack 验证 Light-DOM nesting、ARIA、selected state 与 teardown 恢复；该 gate 已通过，明确作为 DOM/state 快照层，后续继续扩展 Electron computed-style 与截图容差层。
2026-08-26 Electron geometry evidence：`test-electron-uiux-theme.mjs` 扩展为读取 generated Input 的 computed `height/gap/padding/borderRadius/fontSize/lineHeight`，并与 Harness geometry reference 断言；重试后 journey 通过。首次启动因本机缺失 VCP-CDS 二进制与 renderer ready 时序失败，保留为环境阻断证据，不计入通过次数。
2026-08-26 Select DOM alignment：Select menu 已从 `list → item` 调整为 Harness 目标层级 `list → viewport → itemWrap → item`，保留 native select、键盘导航、outside-dismiss、portal 和 owner dispose 行为；`npm run test:uiux` 29/29、`npm run check:harness-snapshot` 与 generated Electron journey 均通过。该切片仍未宣称完整 CSS/pixel equivalence，viewport/itemWrap 的最终 geometry 继续由后续 computed-style diff 门禁确认。
2026-08-26 Select token provenance：Select trigger/menu/item/description/error 的颜色改为 `--dsw-alias-*` 优先、VCP token fallback；`check:harness-contracts` 新增 token provenance 检查，UIUX、snapshot 与 Electron artifact journey 全部通过。该变更只影响 UI presentation，不改变 native select 或 Settings command path。
2026-08-26 Select hierarchy evidence：静态 contract gate 与 Electron generated snapshot 现在同时断言 `menu-viewport`、`menu-item-wrap` 层级存在，防止回退到 list 直接承载 item；Electron journey 通过。下一步仍是固定 viewport 截图与像素容差，不把结构证据扩大解释为视觉等价。
2026-08-26 screenshot evidence：Electron generated journey 现在在固定 primitive 场景写出 `uiux-primitive-contract.png` 并断言截图大小超过 1KiB；该证据证明 screenshot capture 可重复执行，但尚未与 Harness reference image 做 pixel diff，暂不提升 equivalence 状态。
2026-08-26 Select CSS provenance：补齐 Harness Menu 的 `viewport`（flex column）与 `itemWrap`（relative）几何语义，并保持 DSW alias token 优先；source/build、contract、29 项 UIUX 测试及 Electron artifact journey 全部通过。
2026-08-26 Select geometry diff：Electron artifact journey 扩展断言 menu `min-width/radius`、viewport `display/flex-direction`、item `gap/radius/font/line-height`，与 Harness geometry reference 对齐；journey 通过。该证据仍是固定场景 computed-style gate，不等同跨页面 pixel diff。
2026-08-26 Select visual delta audit：确认 Harness selected row 的 trailing check marker/透明背景与当前 VCP selected background projection 不同；已登记为下一条隔离 primitive slice，在实现真实 check node 与状态截图前不宣称 pixel equivalence。
2026-08-26 Select selected marker：已新增 Light-DOM trailing `.vcp-harness-menu-item-check`（`aria-hidden`、CSS glyph、selected-only visibility），selected row 改用 Harness interactive hover token，不再依赖 selected fill；UIUX 29/29、snapshot 与 build 通过，Electron generated journey 已加入 selected-marker 断言并通过。
2026-08-26 dual-page pipeline priority：根据最新等价审计，R2-02C 暂停继续迁移 Settings 字段与扩展 renderer；当前唯一阻断任务升级为 Input/Field/Select 双页面 fixture 流水线：真实 Harness fixture + VCP generated fixture，固定 viewport/DPR/font/theme，产出 DOM structural、geometry、contract-scoped computed-style 与 pixel diff 四层报告。现有 VCP snapshot/screenshot 只算单页面证据，不能替代 Harness 对照图。
2026-08-26 fixture matrix scaffold：新增 `fixture-matrix.json` 与 `npm run check:harness-fixture-matrix`，锁定 800×600、DPR 1、system-ui、Input/Field/Select 九个状态及 DOM/geometry/computed-style/screenshot/pixel-diff 五层输出；当前状态明确为 `matrix-defined-harness-capture-pending`，未把矩阵定义误报为 Harness 参考图或 pixel diff 完成。
2026-08-26 fixture source audit：确认 Harness 生产组件通过 `packages/client/web` Vite/React 入口和 Vitest/jsdom 测试暴露，没有可直接加载的静态 fixture 页面；新增 `fixtures/README.md` 记录真实 source-of-truth、同内核要求和禁止手工复制 markup 的规则。双页面 capture 仍为当前唯一主线。
2026-08-26 Harness web build probe：在本机执行 `pnpm --dir /Users/asahi/Documents/Codex/deepseek-harness run build:web` 成功（Vite 6.4.3，413 modules）；确认可从生产 web entry 产出浏览器 artifact。尚未生成 primitive-isolated fixture 页面，因此 matrix 状态仍保持 `matrix-defined-harness-capture-pending`。
2026-08-26 freeze-boundary audit：最近三项提交仅涉及 UIUX Select、Harness contract/screenshot 脚本和路线文档；`npm run guard:chat-kernel-consumers` 通过（17 个冻结 kernel files），确认未修改 StreamCoordinator/StreamProjection/MessageRenderer、聊天协议、持久化或 Plugin Loader。
2026-08-26 legacy retirement audit：`npm run guard:classic-retirement` 与 `node scripts/check-settings-source-equivalence.mjs` 通过；已迁移 Range/Toggle 字段的 legacy rows、inline styles、CSS selectors 均为 0。`appearance-studio` 对这些 key 的读取仅用于规范化/语义应用，未发现重复 presentation output；该证据支持继续收窄 legacy deletion，但不代表全量 Settings bridge 已退役。

2026-08-26 priority recalibration：根据 Harness 等价审计，施工顺序调整为四层门禁：
1. `reference automation`：reference pack 必须能从固定 viewport 产出 DOM/computed-style/state 快照并生成 diff 报告；
2. `primitive contract`：Input/Field/Select 先完成源码级 DOM nesting、`--dsw-alias-*` token、icon/ARIA/focus 状态；
3. `renderer kernel`：仅实现已有真实 consumer 需要的 mount/update/keyed list/portal/focus/dispose，不提前造通用 Virtual DOM；
4. `legacy deletion`：每个 primitive 证据闭合后删除对应 bridge/projection，未满足前不得继续扩大字段迁移。
Forum 字段当前降级为上述门禁的 consumer 验证，不再单独作为“迁移完成率”指标。
2026-08-26：新增 `npm run check:harness-contracts`，静态对照 Harness Input/Select reference JSON 与 VCP primitive source 的 DOM class、ARIA marker 和 `--dsw-alias-*` token；该门禁通过，作为自动 computed-style/pixel diff 之前的早期 contract drift 检查。

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

当前 SettingsRoot 状态（2026-08-24）：全局 Settings form submit 已通过 `VCPUISettingsBridge.getTypedService().save.execute()` 进入 typed command owner；`SettingsUiService` 与局部 `RustAssistantUiService` 现由 bridge-owned child scope 内的 `UiServiceRegistry` 装配，SettingsRoot 通过 `get('settings-ui')` 与 Rust 控件 consumer 读取；显式 release、owner teardown、逆序 dispose、provider failure rollback、Rust refresh/save 迟到结果隔离与 generated artifact smoke 已有 focused 证据。Rust command failure 现在发布 `vcp-settings-save-result: success=false`，保留 SettingsRoot 打开并进入 retry 状态；global settings 已写入的部分保持 durable，但不会掩盖 Rust capability 的失败。该 registry 只用于 UI service assembly，不接入 Plugin Loader、chat manifest 或全局插件协议。clean external snapshots 现在真实驱动用户身份、assistantAgent 动态 select、服务器 URL、VCP API/File/Log 连接字段、语音 mode/识别器路径/本地与网络 provider、分布式服务/工具注入/思维链/上下文净化/AI 按钮/音乐控制 checkbox、净化深度与可见性、flowlock/middle-click/regenerate controls、chat presentation/layout mode、用户气泡宽度与 stream tuning 及其可见性、摘要模型、Home、Appearance（density/radius/typography/fontScale/contentWidth/surface/sidebar geometry）、字体 preset/custom、聊天气泡和 smooth streaming 控件；checkbox/radio 使用 `checked` 投影，动态 assistant options 通过 MutationObserver 重放 snapshot，sidebar radius radio group、range output（px）与 hidden compatibility select 同步，dirty/in-flight 时仍拒绝外部覆盖。Rust adapter 只消费既有 `getRustAssistantConfig` / `saveRustAssistantConfig` capability，不复制 Rust durable state、不改 IPC/配置格式；global save 已通过该 typed command 路由。`event-listeners.js` 的 Rust 初始填充和 `mainChatSettingsPresentationOwner` 的 Rust DOM projection 在 typed service 可用时均降为 compatibility fallback；`node scripts/test-settings-wa-electron.mjs` 已覆盖 clean projection、失败保存、重试、重载恢复、3 次 repeated reopen 和 owner teardown，`tests/global-settings-save.test.mjs` 覆盖 Rust command failure retry terminal state。其余 legacy projection 仅保留未迁移字段和 Classic compatibility fallback，dirty/autosave 编排仍由 legacy `settings-bridge.js` 与 global settings manager 控制，因此 R2-02 当前是 `typed-production-consumer-active`，不是 complete。

R2-02 退出审计（2026-08-24）：已迁移字段对应的 `mainChatSettingsPresentationOwner` 写入均在 typed service 可用时 gated；forum-config、networkNotesPaths、assistantRuntime diagnostics 均已有独立 typed Surface、失败/迟到/teardown 证据。当前阶段提升为 `typed-production-consumer-active`，但不标 complete：剩余工作是删除已完全覆盖的 legacy bridge presentation 分支、确认 Classic/upstream fallback 没有被 typed assembly 破坏，并继续补 renderer-destroy 及更广泛生命周期证据。`node scripts/test-settings-wa-electron.mjs` 现已通过 60 次 close/reopen，验证 `settings-presentation` 与 `ui-services` 各保持单一 scope、network path 行数稳定、四个 typed services 持续存在，随后显式 renderer teardown 仍能撤销全部 owner；此前超时原因为测试选择器漏查 root 自身，已修正为 `#globalSettingsModal.vcp-harness-settings-root`。本批另修正 readiness marker 的 service/consumer 边界、teardown 撤销、partial-root 与跨 await/root identity race，并加入单元证据；Home visual 的 `showHomeVisualTagline` 已纳入 typed Settings snapshot projection，Settings WA persistence、Appearance Studio 与 Electron Settings gate 均通过。Settings-only 60-cycle stress 通过，但混合全局 lifecycle stress 仍观察到 listener 增长，未将全局生命周期门禁标为通过。

Forum-config 独立 Surface（2026-08-24）：`ForumConfigUiService` 已通过 bridge-owned `UiServiceRegistry` 装配，管理员账号/密码由 typed snapshot 消费，保存由 typed command 路由到既有 `loadForumConfig/saveForumConfig` capability；失败会保持 SettingsRoot 打开并发布 retryable save result。该 adapter 不复制论坛 durable state、不改 IPC 或配置格式。`networkNotesPaths` 也已由 typed snapshot 在 clean form 上幂等重建动态输入行，dirty form 不会被外部 snapshot 覆盖；`assistantRuntime*` 已由只读 `AssistantRuntimeUiService` 消费 runtime status snapshot，旧 diagnostics projection 在 typed service 可用时降为 fallback。

Select projection cleanup（2026-08-24）：Harness Select/Choice 在重建选项 DOM 前会先执行旧 option listener cleanup，避免 detached option listener 随 SettingsRoot refresh/reopen 累积；`node scripts/test-settings-wa-electron.mjs`、`node scripts/test-settings-wa.mjs` 与 `npm run check:uiux` 通过。

Avatar preview projection（2026-08-24）：`userAvatarUrl` 的 SettingsRoot 预览读取已由 typed Settings consumer 接管，上传与 `saveUserAvatar` capability 仍保持在既有业务 owner；Electron gate 覆盖 data-URL 显示与 clear，Classic fallback 保留。

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

1. R2-02C 首先生成完整 Settings 字段 ownership report；每项必须列出 persisted key、DOM id/name、读写 owner、dirty/save/retry owner、legacy path、删除条件与验收证据。
1.1 新增 `reference automation` 子批次：从 DeepSeek Harness 固定 viewport 生成 DOM/computed-style/state 快照，建立结构 diff、逐属性 geometry diff、状态截图 diff 与 token provenance 报告；在该门禁前不宣称 pixel-equivalent。
2. 已暂停扩大字段迁移。首批 Appearance/Home/Radius typed owner 保持 active；Harness reference pack 已建立，Input/Field/Select vertical slice 继续按源码级 contract 闭合，期间不新增字段。
   2026-08-26 增量：`showHomeVisualBrand` 与 `homeVisualTagline` 已加入同一 owner，通用 projection 重复写入已删除；Settings Electron failure/retry/reload/teardown 与 60-cycle listener-stable 证据通过。
   同日增量：`appearanceProfile.customRadius` 与 px output 纳入同一 owner，圆角 draft 合并路径完整化；chat/message renderer 仍未触碰。
   Appearance select group 同步纳入 typed owner（density/radius/typography/fontScale/contentWidth/surface），Settings Electron gate 通过；兼容 fallback 退役仍待 reload/Classic 等价证据。
   Legacy projection retirement 同步完成：`mainChatSettingsPresentationOwner.js` 中上述 Appearance/Home/Radius 的 19 行 safeSet/safeCheck 已删除；Settings Electron/source/unified/UIUX gates 通过。该 owner 仍保留其他未迁移字段，因此 R2-02C 不标 complete。
3. 继续维护 `docs/reference/deepseek-harness-primitives/`，并把人工登记逐步替换为自动产物；无自动 diff 的 primitive 只能保持 candidate。
4. 在已有 Input/Field/Select 真实 consumer 上抽取最小 renderer kernel；退出条件是 mount/update、keyed list、portal、focus 和 deterministic dispose 至少有一个生产 Settings consumer 与 artifact smoke 证据。
5. 每个 primitive 的四层证据闭合后，立即删除对应 legacy projection；R2-02C 关闭后才推进 R2-03 的 Theme legacy reads 清零。
6. R2-08 继续保持 scoped-service-assembly-active：`UiServiceRegistry`、generated artifact 与 `LifecycleScope` 委托均保留现状；在补齐 packaged artifact/跨平台证据前，不声明 public runtime ready。
7. 保持 R2-00/R2-01 的能力由真实 consumer 驱动，不开放任意 selector/HTML 注入，也不创建第二套生命周期或 durable UI Store；Plugin Loader 与 chat plugin protocol 保持冻结。

补充门禁记录：本批补回 `nextUiNotificationForum` / `nextUiNotificationMemo`，并让 NextShell controller 成为唯一 owner；旧 `event-listeners.js` 中对应的重复 document-level binding 仍保持注释隔离。Plugin Loader 与 chat plugin manifest 的越界改动已回退，UI Runtime 只消费既有插件能力；完整 UI Apps smoke 仍受 `VCPDistributedServer/Plugin/VChatDynamicWallpaper/plugin-manifest.json.block` 外部 readiness blocker 影响，本轮不擅自启用用户禁用插件。

R2-02 failure contract 增量（2026-08-24）：Forum typed command 的显式失败与异常、头像文件保存的显式失败与读取异常，均发布 retryable `vcp-settings-save-result: success=false` 并终止当前提交事务；对应回归证据位于 `tests/global-settings-save.test.mjs`。该增量不改变头像、设置或 IPC 数据格式，也不影响 legacy bridge 的剩余迁移职责。

R2-02 timeout/late-result 增量（2026-08-24）：typed Settings save 超时现在调用 `cancelPendingSaves()` 失效当前 generation，迟到 IPC 结果不能重新发布 Settings snapshot；generated artifact consistency、artifact smoke 与 Electron Settings journey 均通过。该能力仍属于迁移期 Settings service，不代表 legacy bridge 已退役。

R2-02 projection simplification（2026-08-24）：删除 Settings typed projection 表中重复的 `enableUserChatBubbleUi` 映射；行为保持不变，避免同一 consumer 对同一控件执行重复投影。Electron Settings journey 与 UIUX type check 通过。

R2-02 retry-chain 增量（2026-08-24）：timeout cancellation 现在同时切断 bridge 内部未完成的串行 save chain，并撤销旧请求的 external snapshot publication rights；重试不会继续排在永久挂起的旧 IPC 后面。typed adapter、generated artifact 与 Electron Settings evidence 均通过。

Stress evidence refresh（2026-08-24）：`VCPCHAT_STRESS_CYCLES=5 VCPCHAT_STRESS_WARMUP=1 npm run test:electron-lifecycle-stress` 仍在 checkpoint 处失败，listeners 从 baseline 579 增至 609（+30），但 lifecycle scopes/resources、connected elements、detached roots/icons/options 均稳定。该混合场景包含多个非 Settings Surface，不能据此归因或宣布 Settings failure/retry + teardown complete。

Lifecycle attribution harness（2026-08-26）：`test-electron-lifecycle-stress.mjs` 新增 `VCPCHAT_STRESS_STAGES`（可独立选择 `ask-nova,settings,agent-settings,embedded,detached-app,mode-round-trip`）及 opt-in `VCPCHAT_STRESS_TRACE_LISTENERS=1` target/type/stack 追踪，默认完整矩阵与阈值不变。追踪确认每轮 +4 来自 `mountHarnessDisclosures()` 对同一 `.style-collapse-header` 重复注册 click/keydown；原因是 `disclosureStates` 保存 state record 却用 `Set.has(container)` 判断。修复为按 container 查找既有 state 后，`VCPCHAT_STRESS_STAGES=settings VCPCHAT_STRESS_TRACE_LISTENERS=1 VCPCHAT_STRESS_CYCLES=3 VCPCHAT_STRESS_WARMUP=1 VCPCHAT_STRESS_CHECKPOINT_EVERY=1 VCPCHAT_STRESS_SKIP_PREFLIGHT=1 npm run test:electron-lifecycle-stress` 结果稳定为 `585 → 585 → 585`；仅保留 Web Awesome runtime 的两个全局 listener，nodes、connected elements、managed lifecycle scopes/resources、detached roots/icons/options 全部稳定。Settings listener attribution gate 现已通过；混合全局 stress 与其他 Surface 仍需独立归因。

Settings-only stress evidence（2026-08-24）：`VCPCHAT_SETTINGS_REOPEN_CYCLES=60 node scripts/test-settings-wa-electron.mjs` 通过；60 次 close/reopen 均保持单一 `settings-presentation` 与 `ui-services` scope、稳定 network path 行数和四个 typed services，随后显式 teardown 撤销全部 Settings owner。该证据支持 Settings Surface 自身稳定，但不替代混合全局 lifecycle stress。

R2-02 readiness-boundary 修复（2026-08-24）：legacy Settings owner 不再把“typed service 已装配”误当成“SettingsRoot consumer 已挂载”；现在以真实 `vcpSettingsRevision` projection marker 判定 typed takeover。service 预装配/partial mount 时保留 legacy 初始化，Forum/Rust/runtime fallback 同步遵守该边界。owner 单测、UIUX type check 与 20-cycle Electron Settings journey 通过。

R2-02 marker teardown 修复（2026-08-24）：typed consumer disposer 现在同步撤销 `vcpSettingsRevision` / `vcpSettingsSource` readiness markers，避免复用 root 在 service 不可用时把旧 marker 误认成活跃 consumer；Electron teardown gate 已断言 marker 为 null。

R2-02 partial-root 修复（2026-08-24）：typed projection 只有在 `#globalSettingsForm` 存在时才写入 readiness marker；malformed/partial SettingsRoot 不会被 legacy owner 误判为已接管。Settings Electron gate 与 UIUX type check 通过。

R2-02 async-readiness 修复（2026-08-24）：`syncGlobalSettingsToUI()` 在 Forum IPC 与 assistant options 两个 `await` 边界重新读取 typed consumer readiness，避免 consumer 中途挂载后 legacy owner 继续用过期状态覆盖 typed projection。owner 单测、Electron Settings gate 与 UIUX type check 通过。

R2-02 root-identity 修复（2026-08-24）：readiness refresh 不再捕获旧 SettingsRoot 引用；每次跨 await 检查都重新解析当前 modal root，避免 reload/reopen generation 使用已替换 DOM 的 marker。owner 单测、10-cycle Electron Settings journey 与 UIUX type check 通过。

UI System gate audit（2026-08-24）：`npm run check:ui-system` 当前在 `guard:design-subtraction` 阶段失败；大量既有 UIUX/Settings 文件相对旧 baseline `b5931a69...` 未登记，且另有 `styles/themes.css` composer focus contract 报告。该失败不能归因于本批 Settings readiness 修复，也不能通过扩大 allowlist 或重写 baseline 伪造绿色；发布门禁缺口保持独立记录。

可归因子门禁复核（2026-08-24）：`check-ui-async-state-matrix`（5 surfaces × 6 states）、`check-ui-task-journeys`（7 journeys）与 `check-theme-provenance` 均通过；因此当前 Settings readiness 变更的异步状态/任务旅程/主题来源子证据保持绿色，总门禁失败仍限于 baseline/design-subtraction 账本缺口。

Artifact runtime refresh（2026-08-24）：`build:uiux`、`check:uiux:artifacts`、`test:uiux:artifacts` 与 `test:electron-uiux:artifacts` 均通过；generated 20 文件一致，Electron generated theme journey 的 light → dark → reload light 与 subscriber teardown 合同通过。

Settings source-boundary refresh（2026-08-24）：`check-settings-source-equivalence.mjs` 与 `check-settings-unified-surface.mjs` 均通过；shell source equivalence、retired bridge owners、Harness geometry 和 legacy rows/inline styles/selectors 均保持绿色。该证据仍不等同于 legacy Settings bridge 全部退役。

R2-02 network-path consumer 增量（2026-08-24）：`networkNotesPaths` 的 typed projection 现在由 Settings bridge 自己创建/删除 Harness row；Add 按钮优先走 `VCPUISettingsBridge.addNetworkPathInput()`，legacy `uiHelperFunctions.addNetworkPathInput()` 仅保留 capability 不可用时的 fallback。Electron gate 新增 Add/Remove 行证据，60-cycle Settings-only stress 也通过；source-equivalence、unified-surface 与 UIUX type check 通过；字段名和持久化格式未改变。

账本校准（2026-08-24）：本节早期 R2-02 段落中的“3 次/10-cycle repeated reopen”属于历史记录；当前权威 Settings-only 证据为 60 cycles，详见上方 stress evidence 与 network-path consumer 增量。状态仍为 `typed-production-consumer-active`，不标 complete。

R2-02 late-command 修复（2026-08-24）：`VCPUISettingsBridge.addNetworkPathInput()` 在 bridge dispose 后拒绝 late command；Electron teardown gate 已验证 disposed Settings owner 不会被 late network-path row command 复活。

R2-02 URL capability fallback 修复（2026-08-25）：legacy owner 对可选 `completeVcpUrl` capability 改为 capability-aware 调用；缺失时保留 authoritative snapshot 原值，不再因 typed consumer 未挂载而抛异常，也不在 UI 层复制 URL 规范化规则。Settings owner、WA persistence 与 UIUX type check 通过。

R2-02 path-listener ownership（2026-08-25）：network path Add 兼容监听改用 renderer `listenerOwner` 注册，继续优先 typed bridge capability、无 capability 时才 fallback 到旧 helper；Settings Electron gate 与 UIUX type check 通过。

R2-02 post-abort verification（2026-08-25）：上一轮中断后工作树保持干净；`VCPCHAT_SETTINGS_REOPEN_CYCLES=60 node scripts/test-settings-wa-electron.mjs`、source-equivalence、unified-surface 与 UIUX type check 均重新通过。

R2-02 assistant-options capability 修复（2026-08-25）：legacy owner 对不存在于仓库稳定实现中的 `populateAssistantAgentSelect` 改为可选 capability 调用；缺失时保留现有 options 并继续 typed snapshot projection，不再中断 Settings 初始化。owner tests、WA persistence、Electron Settings gate 与 UIUX type check 通过。
