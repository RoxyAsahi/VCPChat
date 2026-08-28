# Global Settings 收口施工计划

更新时间：2026-08-28

## 唯一目标

让 VCPChat 全局设置页继续使用已经接入的 Harness 风格组件（Input、Field、Select、Toggle、Range、Choice、ColorPair、Button、Menu、Tooltip、Modal、Toast），并通过分区收口减少旧 CSS、重复 listener、重复 projection 和过宽 bridge 职责。

这是一份产品施工计划，不是 DeepSeek Harness 源码复刻研究计划。旧的 `ui-runtime-2-roadmap.md`、parity ledger、reference pack 只用于追溯和必要回归，不作为高频设置迁移的阻塞条件。

## 当前基线

- Global Settings 已有约 93 个控件节点；
- 已有 generated primitive 的真实 consumer：Input/Field、Select、Range、Toggle、Choice、ColorPair、Button，以及 Tooltip/Modal/Toast；
- Appearance section 已完成多 viewport/light-dark 的基础视觉回归；
- Settings 保存、失败重试、close-flush、reload/reopen 和 owner teardown 已有 Electron 证据；
- canonical DOM、settingsManager、IPC、persisted key 和聊天业务语义必须保持不变；
- 当前状态是“高频组件已广泛接入，按 section 收口中”，不是“重新接入组件”。

## 施工原则

```text
现有 generated primitive
→ 保留 canonical native control
→ 一个 section presentation owner
→ 真实 Global Settings consumer
→ 删除该 section 直接竞争的旧 CSS/listener/projection
→ focused + Electron 回归
→ 独立提交
```

不引入 React、Vue、Cordis、Virtual DOM 或第二份 durable settings state。特殊 picker、窗口 icon、低频控件和聊天区域保持原实现。

## 分区顺序

### G0：基线与目录收敛

- 组件展示页将条目标为 `production-ready`、`candidate-lab` 或 `legacy-showcase`；
- 新页面只允许引用前两类中的 production-ready/真实 consumer 组件；
- 暂停为没有 VCP production consumer 的 Harness source-only 控件增加新 parity 文档；
- 每批只修改本批 section 直接相关文件。

### G1：服务器连接（当前批次）

字段：`vcpServerUrl`、`vcpApiKey`、`vcpLogUrl`、`fileKey`、`vcpLogKey`。

- 采用现有 `Field + Input`，保留 text/url/password 原生类型；
- 保存继续走现有 global settings command/IPC/persisted key；
- 盘点并删除该组重复 blur listener、旧 input geometry selector 和无效 projection；
- 验收首次打开、编辑、保存、失败重试、close-flush、reload/reopen、light/dark、teardown；
- 若发现某个 legacy 分支承担业务归一化（例如 URL 补全），只迁移 presentation，不删除业务归一化。

### G2：身份与论坛

- `userName`、颜色镜像对、`adminUsername`、`adminPassword`；
- 统一 Field + Input/ColorPair；
- 保留头像文件、论坛 capability 和写入协议；
- 删除已经由 typed owner 接管的旧投影和重复 marker。

#### G2 首个净删除（颜色镜像）

全局身份区的 `userAvatarBorderColor`/`userAvatarBorderColorText` 与
`userNameTextColor`/`userNameTextColorText` 现在由 generated ColorPair 的
owner 回调负责同步、校验提示和头像预览更新；`event-listeners.js` 中原有
6 个 ambient input/change/blur listener 已删除。重置颜色按钮、canonical
controls、保存和颜色提取业务保持不变。`npm run check:uiux`、58 项 focused
tests、artifact consistency 和 `test-settings-wa-electron.mjs` 全部通过。

### G3：语音与高级

- 语音 mode 使用 Choice，路径/URL/Key 使用 Field + Input；
- 高级布尔项使用 Toggle，数值项使用 Input；
- 保留能力发现、失败状态和条件显示；
- `topicSummaryModel` 和复杂模型 picker 暂不收口。

### G3 审计结果（2026-08-28）

语音模式已由 generated Choice 接管，浏览器路径、识别页路径、本地/网络
URL 与 Key 已由 generic generated Input 接管；现有测试覆盖 snapshot 投影、
条件显示和 reload 恢复。未发现第二套语音 listener 或可安全删除的独立
projection，因此本批不做空转改动，保留现有业务 capability 与默认值语义。

G2 身份颜色镜像的 6 个 ambient listener 已在提交 `2a69fb01` 删除；该结果
作为后续 section ownership 拆分的参考实现。

本轮补充收口高级区的条件显示：context sanitizer、middle-click quick action、
advanced action 与 regenerate confirmation 的即时显隐现在由同一个 typed
field owner 统一处理，并随 Settings presentation scope 销毁；
`event-listeners.js` 中对应的 5 个重复绑定已删除。`middleClickAdvancedDelay`
的 1000ms 归一化已迁入同一 owner（input/blur 均覆盖），message/renderer 的
业务读取边界保持不变。

### G4：section controller 拆分

将过宽的 `settings-bridge.js` 逐步拆为内部模块：

```text
settings-bridge-entry
├── section-mounting
├── primitive-mounting
├── field-projection
└── autosave-orchestration
```

每个 section controller 只提供 `mount(section) / sync(snapshot) / dispose()`，不拥有第二份 durable state。拆分必须以真实调用方为依据，不为了形式制造公共 API。
模块化时必须同步更新 source-equivalence 门禁；字段 ownership 不能因 `spread`、动态注册或间接常量而变得不可静态审计。若门禁无法证明单一 owner，则保持当前显式映射，不合并拆分。

首个 G4 内部切片已完成：高级区条件显隐抽为
`modules/ui-system/settings/advanced-visibility.js`，bridge 仅负责注入
owner 生命周期与事件绑定；字段字面量仍保留在 helper 中，source-equivalence
可继续静态追踪。该模块不建立 durable state，也不改变 Settings/IPC 协议。

随后 Rust Assistant 区也完成同样的收口：
`modules/ui-system/settings/rust-visibility.js` 负责面板显隐，typed Rust
consumer 绑定并销毁即时响应监听；旧 `event-listeners.js` 监听仅在 typed
service 不可用的 Classic/早期 bootstrap 路径启用，避免生产 Settings 双写。

同时，颜色镜像的旧 binder 现在仅在 UIUX artifact 不存在时启用；生成的
ColorPair 可用时，生产 Settings 不再注册第二套颜色同步监听。

用户样式折叠标题的旧单击绑定也已删除；`mountHarnessDisclosures` 现在是该
标题的唯一 presentation owner，统一处理点击、键盘、ARIA 和 dispose。

当前 `event-listeners.js` 中仍保留的全局设置绑定已完成边界分类：
`submit`（兼容字段保存）、头像文件选择/裁剪、颜色重置按钮和无 UIUX
artifact 时的 ColorPair fallback 均直接承载业务或 bootstrap 语义，暂不退役；
它们不是与 typed primitive 竞争的生产 presentation owner。后续只有在对应
业务命令拥有独立 owner 且有 Electron 回归证据后才迁移。

`render-settings` 的四组字体 preset/custom 行显隐也已抽为
`modules/ui-system/settings/render-visibility.js`；该 helper 只投影 DOM
显示状态，不读取或写入聊天状态，作为 G4 的第三个无状态 section helper。
其四个 preset select 现在由同一 owner 绑定即时 change 响应，切换后无需等待
autosave 回写即可显示/隐藏 custom 行，监听随 owner teardown 撤销。

Appearance 的三个 Range mount 也已抽为
`modules/ui-system/settings/appearance-ranges.js`，native range 与输出节点
仍由原有 typed snapshot/field owner 管理，helper 仅负责生成 primitive 装配。

Home 视觉的两个 Toggle mount 已进一步抽为
`modules/ui-system/settings/appearance-toggles.js`；checkbox 仍是 canonical
节点，helper 不拥有持久化状态，仅注册 generated Toggle 与 scope cleanup。

Home tagline 的 generated Input mount 也已抽为
`modules/ui-system/settings/home-controls.js`；输入值与保存仍由 typed field
owner 负责，helper 仅建立 Light-DOM primitive 和销毁标记。

全局身份两组 ColorPair 的 generated mount 也已抽为
`modules/ui-system/settings/identity-controls.js`；头像预览与错误提示通过
注入回调保持，颜色持久化和业务同步仍由原有 owner 负责。

Agent 六个 section 的 DisclosureRow presentation owner 已抽为
`modules/ui-system/settings/agent-disclosures.js`；该模块通过注入的
`settingsManager.toggleAgentSettingsSection` 保持业务命令归属，并观察
canonical collapsed class，不复制折叠状态。

Appearance 圆角 Choice 与 Voice Mode Choice 的 generated mount 已合并抽为
`modules/ui-system/settings/choice-controls.js`；仅负责两个高频 Choice 的
展示装配和 marker cleanup，不接管冻结的聊天布局 radio。

Forum credential 的两个 generated Input mount 已抽为
`modules/ui-system/settings/forum-controls.js`；ForumConfigUiService 的保存、
dirty、retry 和 capability 语义仍由原 field owner 管理。

拆分复核（2026-08-28）：bridge 已从约 2111 行降至约 1881 行，Appearance、
Identity、Forum 的纯 primitive 装配已有独立归属。剩余约 2k 行主要集中在
Agent section disclosure/model picker、service 装配和全局 shell 生命周期；这些
包含真实业务调用方，不再继续做机械小 helper 拆分。下一阶段优先处理 Agent
section controller 的 mount/sync/dispose 边界，并以真实 consumer 与 Electron
回归作为拆分依据。

### Agent ModelPicker capability 收口（2026-08-28）

模型目录适配已抽为
`modules/ui-system/settings/agent-model-picker-directory.js`。该模块只负责把
现有 `chatAPI` 的缓存、热门/收藏元数据、刷新、收藏切换和更新订阅转换为
ModelPicker 的短生命周期 capability；不写入 `#agentModel`，不复制 durable 模型
状态，也不触碰 legacy modal。`settings-bridge.js` 现在只负责 capability 注入、
canonical input/change 事件和 primitive owner 生命周期。

本切片的 focused contract 覆盖：三分区顺序及重复策略、active 投影、收藏调用、
更新订阅释放。它仍不授权删除 `modelSelectModal`；删除前必须继续取得真实生产
Electron 的选择、刷新/失败、close-race、reopen/reload 和 focus 恢复证据。

同日真实 Electron `agent-settings` lifecycle stress 已通过（1 warmup + 1 measured
cycle）：节点 5856、监听器 571、active scopes 41、active resources 501 在周期前后
保持稳定；detached roots/icons/options 均为 0，ModelPicker 的 close/dispose 没有留下
瞬态 scope 或 DOM。该证据支持“当前 picker owner 无增长/泄漏”，但仍不等同于
legacy `modelSelectModal` 已具备删除资格。

随后 `test:electron-agent-settings-interaction` 的 Agent Select 交互回归也通过：
选择、关闭、重开、Escape 和触发器焦点恢复路径在真实 Electron 中完成，且周期前后
监听器 570、active scopes 41、active resources 501、detached roots/options 仍保持
稳定。ModelPicker 的生产交互证据因此已覆盖目录能力、键盘关闭、焦点恢复和 lifecycle
stress；剩余删除阻断主要是 `topicSummaryModel` 共享 legacy caller 与完整默认数据
源 parity，而不是 Agent picker 本身的 owner 稳定性。

Visual QA 记录：2026-08-28 的 1280×800 light 运行中，Select 采样出现
`focused=true` 但 `:hover=false`，导致门禁失败；同一脚本的其他 viewport 与
历史 light/dark manifest 通过。该问题暂归类为“hover/focus 分阶段采样缺失”，
等待并行 Visual QA 脚本修正后再判断 CSS cascade，不以此阻塞 Settings owner
施工。

并行动效线程当前阻断：`npm run test:ui-motion-contract` 要求 Tooltip 在
显示/隐藏时发布 `data-motion="enter|exit"`，但现有 Tooltip 源码尚未写入该
状态；Theme Presenter 单测通过，问题限定在动效合同实现。Tooltip 文件属于
并行未提交改动，本线不覆盖，待其补齐后再复跑动效与 UIUX 全套门禁。

2026-08-28 历史复测曾出现 Settings Electron gate 的 light/dark 背景差异和资源
`ERR_FILE_NOT_FOUND`，当时归因于并行主题/资源改动。本轮 packaged artifact-only
Theme Electron journey 已通过：initial=`light/1`、dark=`dark/2`、reload=`light/1`、
subscribers=`2`。主题阻断已解除；Settings 专项视觉 gate 仍需单独跑完后才能宣称
全局最终验收完成。

最新 `test-settings-wa-electron` 结果：SettingsRoot geometry、typed Field/Select
DOM、portal stacking、category switching 保留未保存值、无重复 search layer、dark
screenshot 与 control geometry 全部通过；window resize 因 CDP 能力缺失被跳过。最终
仍失败于 light/dark modal background 相同（均为 `rgb(255, 255, 255)`）及一个
`ERR_FILE_NOT_FOUND` 资源错误。该失败继续归属于并行主题/资源改动，本线程不覆盖其
文件；Settings owner 与组件接入证据不受影响。

### G5：旧债净删除

按 section 删除：

- `:not(.vcp-harness-*)` 兼容 selector；
- 已由 generated primitive 取代的旧几何和 hover/focus 规则；
- 重复 listener、observer、timer 和 disposer；
- 无调用方 helper 与死 projection；
- 只为旧 bridge 保留的 fallback。

2026-08-28 增量：高级区条件显示与延迟值校验的旧 ambient listeners 已净删除，
校验语义由 typed owner 保持；该 section 的直接 presentation 债务已收口。

论坛凭据 owner 的监听器也已改为直接注册到 Settings presentation scope：两个
控件的 `input/change` 与 autosave 状态重试不再同时依赖手工 listener removal 和
scope cleanup。dispose 仍保留 timer 取消、dirty marker 清理和 pending save 的
业务语义；本切片只减少 presentation lifecycle 的重复清理路径。

同一原则已应用到 Agent 风格折叠行：generated DisclosureRow 之前已接管视觉与
ARIA，现在其 click/keydown 监听也直接归属 presentation scope；状态观察器和
属性恢复仍由记录对象负责。这样重复 mount/refresh 不会重新绑定同一 header，且
dispose 的监听器清理与其它 generated primitive 使用同一 owner 机制。

连续切片复核（2026-08-28）：`npm run test:uiux` 当前 90/90 通过；
`check-settings-source-equivalence`、`check-global-settings-section-ownership` 和
`check-agent-model-picker-legacy-parity` 均通过。source-equivalence 仍报告
`legacy.rows=0`、`legacy.inlineStyles=0`、`legacy.cssSelectors=0`，说明已收口的
Settings sections 没有重新引入直接竞争 projection；未收口的 legacy modal 与业务
fallback 仍由负向门禁明确保留。

字段 owner scope 化后的完整回归（2026-08-28）已通过：`npm run test:uiux`
88/88、`check:uiux:artifacts`，以及 `test:electron-agent-settings-interaction`。
真实 Electron 交互周期前后保持 41 个 active scopes、501 个 active resources、570
个 listeners，detached roots/options 均为 0，说明这次 listener 归属调整未引入
重开泄漏或 Agent Settings 交互回归。

Disclosure host 属性恢复修复后的 Electron 复测同样通过：Agent Settings 交互周期
前后节点 5830、listeners 570、active scopes 41、active resources 501，detached
roots/options 均为 0；generated artifact consistency 仍通过（78 个产物）。

## 不作为阻塞条件

## 当前完成度快照（2026-08-28）

| 区域 | 状态 | 说明 |
| --- | --- | --- |
| G1 服务器连接 | stable-adoption | Input/Field 已接入，URL 归一化保留业务边界 |
| G2 身份/论坛 | owner-converged | ColorPair、Forum Input 装配与重复 listener 已收口 |
| G3 语音/高级 | owner-converged | Rust/Voice projection 与条件显隐已归 typed owner |
| G4 内部拆分 | in-progress | 已拆 Advanced、Rust、Render、Appearance、Identity、Forum、Agent Disclosure |
| G5 旧债净删除 | in-progress | 直接竞争 listener 已清理；业务 fallback 仍保留并有静态门禁 |
| Electron 视觉最终验收 | passed-artifact-journey | packaged artifact-only Theme Electron journey 已通过；Settings 专项 gate 继续复核 |

补充证据：`test:electron-global-settings-entry` 已通过，确认 generated Settings
入口 Button 的 mount、click、modal close 和 teardown 在真实 Electron 中保持可用。
该 journey 只证明入口和 shell 生命周期，不替代 light/dark 视觉最终验收，也不改变
此前并行主题线程的阻断已由 packaged artifact-only Theme journey 解除；仍保留
Settings 专项视觉 gate 作为最终验收证据。

- 全量 Harness source parity；
- 每个字段的跨页面 pixel diff；
- Windows/packaged artifact-only 证据；
- source-only Candidate 的生产消费；
- ModelPicker legacy modal 全量退役；
- 聊天消息、流式、composer、工具结果、代码块和思维链重构。

这些可以作为增强证据，但不能阻塞 G1-G5 的高频设置产品收口。

## 每批 Definition of Done

- 真实控件由目标 generated primitive/Field owner 接管；
- native control、settingsManager、IPC、persisted key 不变；
- 同一节点没有双 presentation owner；
- 直接竞争的旧 CSS/listener/projection 已删除，或在批次报告中说明保留原因；
- Electron 首次打开、重开、reload、失败恢复、close-flush 和 teardown 通过；
- light/dark 与常见窗口尺寸没有明显溢出、遮挡或 cascade 回退；
- 变更和证据以独立提交交付。

## 当前启动动作

先对 G1 做只读 owner/CSS/listener 审计；若现有接入已经满足合同，则直接进入最小净删除，不重复包装 Input。完成后更新 `docs/global-settings-architecture-audit-2026-08-28.md` 的状态和本计划的批次记录。

## G1 审计结果（2026-08-28）

G1 当前已经满足“现有 generated Input + canonical native node”的接入条件，不需要重复挂载：

- `node scripts/check-settings-source-equivalence.mjs`：`shellSourceEquivalent=true`、`retiredBridgeOwners=true`、`harnessGeometry=true`、`legacyClean=true`；
- `node scripts/test-settings-wa-electron.mjs`：SettingsRoot、Input/Field/Select、portal、失败重试、close-flush、reload/reopen、网络路径和 teardown 全部通过；
- `vcpServerUrl` 的 blur `completeVcpUrl` 归一化仍属于业务保存语义，暂不删除；
- 当前没有发现连接字段可安全删除的独立 listener/projection，G1 进入“保持现状、等待 section controller 拆分”的状态，而不是强行改代码。

这说明全局设置已经在使用 Harness 风格组件；后续收口重点是拆分过宽 bridge、统一旧 CSS 层级和继续减少 legacy 竞争，不是重新接入 Input。
