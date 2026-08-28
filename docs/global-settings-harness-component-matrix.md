# Global Settings 收口矩阵：Harness 模式 → VCPChat

> 真源：`/Users/asahi/Documents/Codex/deepseek-harness/packages/client/` 的生产 Settings 代码。本文用于选择 VCPChat 的组件模式，不把 Harness 不存在的字段类型伪装成现成组件。

## Harness 的实际 Settings 模式

| Harness 真源 | 组件/结构模式 | VCP 采用原则 |
|---|---|---|
| `ui-settings-general/.../SettingsRoot.tsx` | modal shell、侧栏 nav、原生 `button` nav/close、Escape/focus | 保持 VCP SettingsRoot 单一 Shell owner；不为字段复制新 store。 |
| `GeneralSection.tsx` | 单列 Field/section 容器，由 feature 注入条目 | VCP 用分组 Field 行和 category section；字段 presentation 可逐组替换。 |
| `SettingsDocumentAction.tsx` | `Button(outline/sm)` + disabled/error | VCP 的普通二级 action 统一 Button；业务/IPC 不变。 |
| `ui-settings-plugins/.../fields.tsx` | label + native text/password input + hint/error/override/reset | 文本、URL、数字、密码字段用 Field + Input；密码保留 native password 语义。 |
| `ui-primitives/Input.tsx` | icon slot 可选的原生 Input wrapper | 只在需要 icon/统一 geometry 时用；不强行改 textarea/文件选择。 |
| `ui-primitives/Menu.tsx` | 枚举和选择动作使用 Button trigger + Menu，具备 Escape/focus/portal | 长枚举可使用 generated Select/Menu；短 radio 组用 Choice。 |
| `ui-primitives/Button.tsx` | primary/outline、sm/md、disabled | 普通 action 使用；危险、窗口 icon、复杂 picker 保留 bespoke，直到有明确合同。 |

Harness 当前没有通用 Switch、Range、ColorPair 或完整表单 schema primitive；VCP 的 Toggle、Range、ColorPair 是本地组件合同，应继续以 native business node + typed presentation owner 维护，不能声称为 Harness 原样复刻。

## VCP Global Settings 分类

| 字段组 | 字段/节点 | 目标组件模式 | 当前状态 | 收口动作 |
|---|---|---|---|---|
| 用户身份 | `userName`、avatar/name color、`resetUserAvatarColorsBtn` | Field + Input / ColorPair / Button | 已有 typed owner | 清理字段组直接竞争 CSS/legacy projection；不改头像文件业务。 |
| 论坛与连接 | `adminUsername`、`adminPassword`、`vcpServerUrl`、各类 key/url | Field + Input（password/url/text） | Forum 已 typed；连接字段仍 legacy | **首批**：把连接凭据作为同一 Field/Input 切片；保留现有 save/complete URL 语义。 |
| 网络路径 | path 行 + `addNetworkPathBtn` | repeatable Field + Input + Button(outline/sm) | 已有 typed dynamic rows/Button | 只清理该行旧样式/重复 listener，不重写 list persistence。 |
| 外观首页 | home visual toggles/tagline、density/radius/typography selects | Toggle、Input、Select | 已有 typed owner | 作为视觉回归基线，不扩大到聊天字体。 |
| 外观几何 | sidebar ranges/radius radios | Range + Choice | 已有 typed owner | 维持；补 Field 描述与 CSS 清债时按单组处理。 |
| 聊天字体、布局、流式 | `chat*`、presentation/layout、smooth streaming | **冻结** | 部分旧 typed projection 存在 | 不新增接入或重构；仅在与本轮无关的现有代码中保持兼容。 |
| 划词助手/Rust | `assistantAgent`、rules、thresholds、keywords | Select、Toggle、Input/Textarea | 混合 owner | 第二批：先做可见 Field layout 与 Input/Select，业务 capability/异步诊断不动。 |
| 语音 | mode、URL/key、浏览器路径 | Choice + Field/Input | voice mode 已 Choice | 第二批：收口文本/密码输入与条件显示，保留服务发现。 |
| 高级功能 | feature booleans、numeric depth、topic model | Toggle + Input；model picker bespoke | 混合 owner | 第三批：只迁 Toggle/Input；`topicSummaryModel` picker 暂缓。 |
| 快捷操作 | prompt、delay、quick-action select/toggles | Textarea + Input + Select + Toggle | 多数 legacy | 第三批：按一个字段组接入，不触碰聊天中键行为。 |

## 第一批：连接字段收口合同

范围限定为 `vcpServerUrl`、`vcpApiKey`、`vcpLogUrl`、`fileKey`、`vcpLogKey`。

- canonical business nodes 和 persisted keys 不变；
- 继续走现有 global settings 保存/错误/重试链路，不新建 durable state；
- 统一使用 generated Input 和 Field layout，password 不改为 text；
- 一个 Settings presentation scope 拥有所有 decoration/listener/disposer；
- 删除该字段组直接竞争的旧 input/field CSS 或 listener；
- 验收：light/dark、open/reopen/reload、保存失败恢复和 scope teardown。

## 非目标

这不是重新实现 Harness React Settings，也不是全局 Settings 大重写。Source-only Harness 控件、完整 cross-app pixel diff、ModelPicker legacy modal retirement、聊天内容和流式均不阻塞上述分批收口。
