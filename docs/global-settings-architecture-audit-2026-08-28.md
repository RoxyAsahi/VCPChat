# Global Settings 架构审查与收口方案（2026-08-28）

## 结论先行

Global Settings 已经是 Harness 风格组件的大型真实 consumer，不需要回退，也不需要现在重写底层 renderer。当前主要问题是旧表单编排、样式和新 typed presentation 并存，导致收口成本高。

## 当前事实

按当前工作树检查：

- `globalSettingsForm` 静态包含约 93 个 input/select/textarea/button 节点；
- `settings-bridge.js` 约 2111 行，承担挂载、投影、autosave、兼容和字段特殊逻辑；
- bridge 中约 59 个 typed/harness mount 调用点；
- VCPUI consumer gate：12 个已有生产/Electron 证据的 stable consumer、20 个 candidate、32 个展示组件；
- `check-harness-parity-status` 仍为 `pass=false`，有 4 个 capture gaps；这是证据账本状态，不等于 Global Settings 未接入；
- 现有样式中约 99 处 `:not(.vcp-harness-button)` 排除规则，说明旧 CSS 与新 Button 仍在同一文件平面竞争；
- 主题相关读取/选择器仍有大量历史路径（全仓约 809 处命中，包含定义、兼容和实际读取），不能把 ThemeTokenOwner 视为已完全收口。

当前全局设置已使用或部分使用：Input、Field、Select/Menu、Range、Toggle、Choice、ColorPair、Button、Disclosure、Tooltip/Modal/Toast。其余字段不是“等待首次接入”，而是等待分组收口、旧路径删除或特殊语义裁决。

## 与 DeepSeek Harness 的结构差异

### Harness

```text
feature plugin
  → settings namespace scope/store
  → typed slot contribution
  → React SettingsRoot / section
  → primitive (Button/Input/Menu 等)
  → CSS Modules + --dsw-* tokens
```

Harness 的设置功能按 feature package 拆分；每个 namespace 有自己的 snapshot、mutation、locale、slot 和生命周期。SettingsRoot 只负责 shell、导航和 slot composition，字段 owner 不集中在一个 bridge 文件中。

### VCPChat 当前

```text
main.html 静态 globalSettingsForm
  → settingsManager / global-settings-manager
  → settings-bridge.js
      ├── typed SettingsUiService / field owner
      ├── generated Light-DOM primitive adapter
      ├── legacy autosave / collect / special fallback
      └── 大量分拆后的旧 CSS
```

VCP 的优点是 canonical DOM、既有业务/IPC/持久化可保留，且不需要引入 React/Cordis。差异在于：字段按页面集中、业务与 presentation seam 混在 bridge、旧 CSS 仍参与 cascade、VCP 的 Toggle/Range/ColorPair 属于本地合同而不是 Harness 原生 primitive。

## 技术债分级

### P0：双轨 presentation（必须持续减少）

- typed primitive 与 legacy enhancer 对同一节点重复尝试；
- `settings-bridge.js` 同时承担 service、字段投影、动态 DOM、autosave 和兼容逻辑；
- 旧 CSS 通过 `:not(.vcp-harness-*)` 规避竞争，而不是按 ownership 分层；
- 部分字段仍由 legacy collect/特殊 helper 写入。

### P1：职责边界过宽

- Global Settings 的 93 个控件仍以一个静态 form 为中心，缺少明确 section controller；
- service snapshot、native control value、draft/dirty 状态之间存在多个 presentation projection；
- Field、Input、Select 等 primitive 解决了视觉和生命周期，却没有统一的 section-level composition API。

### P1：主题与 token 清债未完成

- ThemeTokenOwner 已存在，但 body class 和旧主题 selector 仍广泛存在；
- 新 token 与旧颜色/阴影/radius 规则并行，导致不同 section 的视觉漂移。

### P2：证据和组件目录膨胀

- 32 个展示组件中有相当部分是 source-only Candidate；
- parity/reference/fixture 文档多于真实产品接入所需；
- 4 个 capture gaps 不应阻塞高频 Settings 收口。

## 是否需要底层重构

不建议现在做“重新实现 Harness renderer”或把整个 Global Settings 改成 React/Vue。现有 `LifecycleScope`、generated primitive、native canonical node 和 service adapter 足以支撑产品收口。

需要的是有限的底层拆分：

1. `settings-bridge.js` 保留为入口/装配器，但把字段定义、section controller、primitive mounting、autosave orchestration 分成四个内部模块；
2. 引入一个轻量 `SettingsSectionController` 合同：`mount(section) / sync(snapshot) / dispose()`，不复制 durable state；
3. 每个 section 只允许一个 presentation owner，native control 仍是业务节点；
4. 旧 CSS 按 section 逐步改为低 specificity 基础层，新 primitive 自己拥有 control geometry；
5. 只有当一个 section 的全部字段迁移并有回归证据后，才删除该 section 的 legacy branch。

这属于“模块化收口”，不是“底层架构重写”。

## 推荐施工顺序

### 阶段 A：建立收口基线（1 个批次）

- 固定本报告和字段 ownership 表为当前基线；
- 组件展示页分为 `production-ready`、`candidate-lab`、`legacy-showcase`；
- 暂停为 source-only Harness 控件补新 parity 文档。

### 阶段 B：服务器连接 section

字段：`vcpServerUrl`、`vcpApiKey`、`vcpLogUrl`、`fileKey`、`vcpLogKey`。

- 统一 Field + Input（password/url/text 保持原生类型）；
- 保存仍走现有 global command/IPC/persisted key；
- 清理该 section 直接竞争的旧 CSS、blur listener 和重复 projection；
- 验收 open/reopen/reload、失败重试、close-flush、light/dark、teardown。

### 阶段 C：语音与高级功能 section

- Voice：Choice + Field/Input；
- Advanced：Toggle + numeric Input；
- 保留服务发现和能力失败语义；
- `topicSummaryModel` 的复杂 picker 继续 bespoke。

### 阶段 D：Section controller 收口

- 将 8 个 category section（身份、连接、外观、消息、划词、语音、高级、快捷）按 controller 拆开；
- controller 只拥有 presentation listeners/observers，不拥有第二份 durable state；
- `settings-bridge.js` 变成薄装配层。

### 阶段 E：债务清理与视觉统一

- 逐 section 删除 `:not(.vcp-harness-*)` 兼容 selector；
- 清理无调用方 helper、重复 marker、重复 disposer；
- 统一 `--vcp-*` 到已确定的 UI token alias，不在每个 primitive 里继续发明 token；
- 以真实页面的明显视觉一致性为验收，不把跨页面 pixel diff 作为高频迁移前置。

## 不动的边界

不修改 StreamCoordinator、StreamProjection、MessageRenderer、ChatDomRenderer、聊天协议、IPC、持久化、Plugin Loader、chat manifest、动态壁纸、聊天内容、思维链、代码块、工具结果或 composer/input 内部布局。特殊 picker、窗口级 icon、低频 DiffBlock 继续保留原实现。

## Definition of Done

一个 Global Settings section 收口完成，必须满足：

- 真实字段已由目标 primitive/Field owner 接管；
- canonical DOM、settingsManager 业务语义、IPC 和 persisted key 不变；
- 同一节点不存在双 owner；
- 直接竞争的旧 listener/CSS/projection 已删除或有明确保留理由；
- Electron 首次打开、重开、reload、失败恢复和 teardown 通过；
- light/dark 与常见窗口尺寸无明显溢出、遮挡或 cascade 回退。

## 总体判断

当前不是“架构走歪”，而是“产品接入已先行，内部模块化和旧债清理滞后”。最有效的路线是保留现有 Harness 风格组件和 canonical business boundary，按 section 做有限拆分和净删除；不要再用完整 Harness parity 研究替代真实 Global Settings 收口。
