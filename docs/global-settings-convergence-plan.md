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

### G3：语音与高级

- 语音 mode 使用 Choice，路径/URL/Key 使用 Field + Input；
- 高级布尔项使用 Toggle，数值项使用 Input；
- 保留能力发现、失败状态和条件显示；
- `topicSummaryModel` 和复杂模型 picker 暂不收口。

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

### G5：旧债净删除

按 section 删除：

- `:not(.vcp-harness-*)` 兼容 selector；
- 已由 generated primitive 取代的旧几何和 hover/focus 规则；
- 重复 listener、observer、timer 和 disposer；
- 无调用方 helper 与死 projection；
- 只为旧 bridge 保留的 fallback。

## 不作为阻塞条件

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
