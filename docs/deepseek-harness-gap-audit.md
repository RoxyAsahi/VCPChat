# VCPChat 与 DeepSeek Harness 差距审计

审计日期：2026-08-22。

本文根据 `C:\VCP\vchat-develop\deepseek-harness` 当前的 `AGENTS.md`、`docs/architecture.md`、`docs/event-producer-consumer.md`、`docs/defensive-patterns.md`、`docs/testing.md` 和 `dsh-code-review` 规范，对 VCPChat 当前源码、测试门禁和 vD7 审计证据进行横向比较。

这不是要求 VCPChat 变成 DeepSeek Harness 的迁移计划。两者产品边界不同：DeepSeek Harness 是可配置的 agent runtime，VCPChat 是带 Classic/Next UI、Electron 窗口、插件和本地数据服务的桌面聊天产品。下文将差距分为三类：

- **应补强**：会直接降低 VCPChat 的 correctness、可维护性或发布可信度。
- **可选择演进**：有长期价值，但不应阻塞当前 D0-D7 收口。
- **产品差异**：Harness 的机制不应机械复制到 VCPChat。

## 总览

| 领域 | Harness 的基线 | VCPChat 当前状态 | 判断 |
| --- | --- | --- | --- |
| 运行时组合 | 一切都是可卸载 plugin，配置层组合 profile/bundle | 有 named owner、capability 和部分 plugin registry；renderer 仍是 Electron composition root，模块装配主要写死在代码 | 应补强，但不做全量 plugin 化 |
| 事件系统 | 类型声明、mode、payload、producer/consumer 生成矩阵 | 已有 consumer/facade gate；DOM、preload、内部 callback、公共协议仍未统一登记 | 应补强，按事件路线 E0-E7 推进 |
| 类型和协议 | TypeScript strict、声明合并、discriminated union、branded id、边界 schema | 生产核心仍以 JavaScript 为主，依赖正则/运行时测试和 capability 约定；opaque id 尚未系统 branded | 应补强，先从跨边界和高价值协议开始 |
| 持久事实 | append-only typed session event log；model-visible means logged | 主要是历史/消息文件和 persistence authority；StreamSession/Projection 已分离，但还不是统一可重放 session log | 应补强，长期方向 |
| 能力接缝 | Service Definition + Provider + Consumer 三角色完整 | 已有 repository、coordinator、surface、owner 和 facade；部分 `electronAPI` 仍是宽 capability，provider contract 不总是独立登记 | 应补强，按 capability 演进 |
| 测试方法 | unit、100% per-file coverage、real entry、keyless snapshot、built artifact、real API e2e | Chat Kernel/UI、Electron、Windows matrix 很强；snapshot/replay、artifact plane、packaged smoke 仍不完整，当前 packaged smoke 失败 | 应补强 |
| 生命周期 | effect 注册可逆、dispose 达到 quiescence、回调异常隔离 | vD5/vD6 已显著补强，stream/surface/owner 有 drain 和迟到隔离；全仓仍存在非统一 owner/legacy 路径 | 应补强，持续门禁 |
| 配置和部署 | profile、bundle、patch overlay、配置 catalog、配置错误尽早失败 | package/build 配置和 Electron 入口为主，环境/窗口能力分散，缺统一 profile composition | 可选择演进 |
| 安全边界 | env scrub、私有随机 spill、进程树、wire/durable boundary 校验 | 有 Electron security、embedded-app、IPC 测试；安全规则分散，未形成统一 boundary policy | 应补强 |
| 文档治理 | 文档有唯一事实源、生成 catalog/graph、Agent Note、doc-sync/website build | D0-D7 和 UI 文档已整理，仍有多份历史/当前文档和测试数字漂移风险 | 应补强 |
| 发布成熟度 | source/artifact plane 分离，built smokes，跨环境 CI | CI 基本门禁通过；当前 packaged artifact 因 `electron-edge-js` native rebuild 失败，D7 仍阻塞 | 应补强，发布阻塞项 |
| Harness 特有能力 | subagent、workflow、ACP、headless/web/CLI 多宿主 | VCP 有插件、Voice/Rust、Classic/Next 和辅助窗口，但不是同一类 agent harness | 产品差异，不追求对齐 |

## 1. 运行时组合与 plugin 化

### Harness 基线

Harness 没有一个把所有服务写死的 privileged core。模型、工具、session、persistence、settings、sandbox、agent loop 都是 plugin，通过 Cordis context、effect 和 profile/bundle 组合。插件卸载时，注册项和监听器反向撤销。

### VCPChat 差距

VCPChat 已经吸收了“可替换 owner”和“显式 capability”的部分理念：`StreamCoordinator`、`ChatSurface`、`RenderDependencies`、`ChatHistoryPersistence` 和各类 main-chat owner 都是清晰进步。但当前 composition 仍主要集中在 `renderer.js`、`main.js` 和 preload 的手写装配中：

- service 创建顺序和依赖多数是代码内固定的；
- capability 的接口、provider 和 consumer 并非总是三份明确记录；
- 部分公共窗口/插件能力仍通过宽的 `electronAPI` 或兼容 facade 暴露；
- 非聊天模块的 listener/registry 不一定经过统一的 reversible-effect 原语。

### 建议

先建立轻量的 `CapabilityDefinition`/owner manifest：记录接口、provider、consumer、生命周期和 smoke，不引入 Cordis。优先覆盖聊天、history、stream、surface、settings/presentation 和 embedded app。只有当多个 provider 真正独立演进时，才引入配置式装配。

## 2. 类型安全与协议表达

### Harness 基线

Harness 要求 strict TypeScript、声明合并的 typed event map、discriminated union、`assertNever`、branded opaque ids，以及在 JSON、wire、durable/file、worker 等边界校验。

### VCPChat 差距

VCPChat 核心路径仍是 JavaScript。当前安全性主要来自：

- capability closure；
- 静态源码 gate；
- focused tests；
- 部分运行时 `Object.freeze`、payload normalization 和 Electron 边界检查。

这不能完全替代编译期保证。尤其是 `conversationKey`、`operationId`、`messageId`、`topicId` 等值在代码层面通常仍是普通 string；不同 authority 之间容易发生语义错传。事件、IPC channel、插件命令和 terminal kind 也没有统一的 discriminated union。

### 建议

不要一次性把仓库改成 TypeScript。按边界渐进：

1. 为 stream/history/surface 事件和 terminal 建立逻辑定义与 payload schema。
2. 为跨 owner 的 identity 引入模块级 branded constructors，先阻止明显混用。
3. 为 preload/public plugin 协议建立 schema 和版本字段。
4. 新增逻辑必须使用 discriminant 分支；旧代码只有在触及时迁移。

## 3. 持久事实与 session log

### Harness 基线

Harness 的 session log 是模型上下文、恢复、projection、telemetry 和 replay 的唯一来源。`model-visible means logged` 是硬约束；结构性格式变化有版本号和迁移策略。

### VCPChat 差距

VCPChat 已经正确地区分了：

- stream transient state；
- terminal/persistence authority；
- history repository；
- DOM projection。

但当前 durable truth 仍以聊天历史/消息数据为中心，不是统一的 append-only typed event log。因此下列能力仍较弱：

- 从单一日志重建一次发送的 request、stream、cancel、terminal 和 persistence 结果；
- 对用户可见但未持久化的中间状态做确定性 replay；
- 跨窗口/跨 Surface 对同一 operation 做统一审计；
- 对 session 格式和事件兼容性做明确版本管理。

### 建议

把它列为长期 E3/E7 方向，先不要替换现有历史存储。第一步只为关键事实增加可重放的事件记录或测试 transcript：message requested、stream terminal、history persisted/failed、surface lifecycle。等事件图谱稳定后，再评估 append-only log 是否值得成为新的持久化 authority。

## 4. Capability seam 完整度

### Harness 基线

一个 capability seam 必须有 Service Definition、Provider、Consumer 三个角色。provider 可以替换，consumer 不应依赖实现细节；同一能力可在不同 profile 组合。

### VCPChat 差距

VCPChat 的 `ChatRepository`、`StreamCoordinator`、`ChatSurface` 等已接近这一模式，但仍有两类缺口：

- `electronAPI` 同时承载 query、command、subscription、窗口操作、设置、文件、主题和各种历史协议，粒度远大于单一 capability；
- 一些 owner 通过约定使用 capability，但接口没有独立的定义文件、版本、失败语义和动态 consumer 清单。

这会让测试很难判断一个 consumer 是依赖“聊天历史能力”还是依赖整个 Electron 环境。

### 建议

沿已有 capability closure 继续拆小：`chatHistoryCapability`、`streamTransportCapability`、`themeCapability`、`notificationCapability`、`windowCommandCapability`。每次只从真实 consumer 需要的最小方法集合开始，不把 `electronAPI` 复制成更多 facade。

## 5. 测试与证据

### 已经接近 Harness 的地方

VCPChat 在桌面运行时测试上其实有自己的优势：

- Chat Kernel 当前 146/146；
- UI System 当前 97/97；
- UI Apps、主聊天、辅助 crash/reload、Windows matrix 都有真实 Electron 入口；
- 生命周期测试观察 listener/resource/detached roots，而不只检查函数调用；
- CI 曾暴露并修复 Electron postinstall 安装问题。

### 仍有差距

Harness 的测试层还包括：

- per-file coverage gate；
- keyless snapshot/replay 作为用户/模型可见行为合同；
- built `lib`/bin/worker 的真实入口测试；
- packaged artifact smoke；
- real API e2e 与明确的自跳过策略；
- source plane 与 artifact plane 不混用。

VCPChat 当前审计明确记录：

- packaged artifact 尚未生成，`electron-edge-js` native rebuild 失败；
- D7 仍缺完整支持的 Windows/打包/GPU-DPI 证据；
- manual soak artifact 仍为 `manual_observation_required`，不能替代操作员 checklist；
- 新增的 transcript/contract/evidence 框架尚处于扩展阶段，还没有 Harness 那样稳定的统一 replay 入口。

### 建议

发布前优先级应高于新增事件类型化：

1. 修复或明确隔离 packaged artifact 的 native rebuild 失败。
2. 形成一个最小 keyless chat transcript replay，覆盖发送、stream terminal、cancel 和 persistence failure。
3. 为实际打包入口建立 smoke，而不是只测 unpacked source。
4. 以后再考虑按模块逐步提高 coverage，而不是直接复制 100% per-file 门槛。

## 6. 生命周期、并发和错误语义

### Harness 基线

Harness 特别强调：

- async state 不能当同步 state；
- dispose 必须等待 quiescence；
- 回调异常不能阻断其他 listener；
- timeout、signal、exitCode 等正交结果必须分别报告；
- provider 多种错误表示要在公共 API 归一化。

### VCPChat 当前状态与差距

vD1-vD6 已把 generation、operation identity、terminal arbitration、quiescent dispose、late-result isolation 做成了主聊天核心路径的证据。这一部分已经接近 Harness 的 defensive 标准。

差距主要在全仓一致性：

- 非聊天 Electron 窗口和旧插件不一定采用相同的 async outcome vocabulary；
- IPC `invoke`、`send`、subscription 的错误和取消语义不是统一类型；
- 某些 callback/DOM 事件仍依赖调用方自行捕获异常；
- 进程、临时目录、外部命令和资源清理规则没有一个统一的 VCPChat defensive policy 文档。

### 建议

新增跨模块的异步操作时，先定义结果字段：`status`、`timedOut`、`cancelled`、`signal`、`exitCode`、`error`，并明确哪些是 terminal。建立少量共享 helper 和负向测试即可，不要为旧模块大面积改写。

## 7. 配置、profile 和可部署组合

### Harness 基线

Harness 通过 profile、bundle、patch overlay 组合运行时；配置 catalog 自动生成；缺少自包含配置时尽早失败；deployment-varying tunables 不写死在 plugin 中。

### VCPChat 差距

VCPChat 当前主要通过：

- `package.json` scripts/build 配置；
- Electron command line flags；
- settings 文件；
- plugin manifest 和窗口入口；
-环境变量/本地数据目录

完成装配。缺少一个统一的“当前运行 profile”概念，导致：

- main chat、Classic、Next、auxiliary window 的能力组合不总是显式列出；
- 某些默认值分散在 renderer、preload、main process 和 settings owner；
- 配置错误有时在启动后才暴露。

### 建议

建立只读的 runtime composition manifest，先用于诊断和测试，不立即改造 boot：记录窗口、Surface、capability、插件、版本和禁用原因。等 manifest 稳定，再把真正需要部署变化的配置迁移到它。

## 8. 安全边界

### Harness 基线

外部命令使用 scrubbed env；spill/temp 使用私有随机目录和独占创建；wire、worker、durable file 和 queued input 是明确的校验边界；路径删除防 symlink/junction traversal。

### VCPChat 差距

VCPChat 已有 Electron security、embedded-app security、preload isolation 和 IPC contract 测试，但安全规则分散在 main/preload/service/test 中，尚未形成统一清单。特别值得补查：

- 外部 Rust/Voice/插件进程继承的环境变量；
- 临时截图、附件、导出和 crash artifact 的权限与随机性；
- Windows junction/symlink 清理；
- plugin/Classic 输入是否在公共协议边界归一化；
- timeout 后进程树和 WebContentsView 是否始终收敛。

### 建议

建立 `docs/vcpchat-defensive-boundaries.md` 和对应静态/动态检查，优先覆盖新增代码和发布阻塞路径。不要因为 Harness 有规则，就对不产生外部副作用的纯 DOM 代码增加无关验证。

## 9. 文档和工程治理

### Harness 基线

Harness 有明确唯一事实源、生成文档、Agent Notes、双语同步、doc-sync、website build、dead-link 检查，并把非平凡设计决定写入同一 PR。

### VCPChat 差距

VCPChat 已经归档了旧路线，建立了 D0-D7 final audit、consumer report 和 evidence roadmap，这是很大的改善。但仍存在：

- current-state、roadmap、audit、evidence 文档数量较多，事实容易重复；
- 测试数字随着上游同步变化，曾出现文档落后于 107/107、129/129 等历史数字；
- 事件、capability、artifact 目前还没有统一生成文档入口；
- JavaScript 导出契约和文档不具备 Harness 那样的自动 JSDoc/文档预算门禁。

### 建议

继续保持“一项事实一个家”：

- D0-D7 合同：roadmap；
- 阶段状态和数字：final audit；
- 事件图：event producer/consumer report；
- UI 当前拓扑：next-ui-current-state；
- 发布证据：evidence manifest。

其余文档只链接，不重复数字和退出条件。

## 10. 不应追求的对齐项

下列 Harness 特性不应被视为 VCPChat 的缺陷：

- Cordis 风格的所有模块都可运行时卸载；VCPChat 的 Electron 主窗口和 preload 有平台生命周期，不能完全等价。
- headless、CLI、ACP、多 profile agent loop；VCPChat 的主要产品契约是桌面聊天和多 Surface。
- DeepSeek-specific real-API 测试、tool schema 和 agent turn log；VCPChat 应关注自身 VCP、Voice、Rust、Classic 和插件协议。
- 100% per-file TypeScript coverage 作为立即门槛；VCPChat 的 UI/Electron 行为风险更适合以真实入口矩阵和生命周期证据衡量。
- 直接拒绝所有旧格式/兼容 facade；VCPChat 明确拥有 Classic 和插件协议，兼容层退役必须由真实消费者和版本策略决定。

## 优先级

### P0：当前发布前

1. 处理 packaged artifact/native rebuild 失败，或明确支持矩阵中该失败的边界。
2. 完成声明支持的 Windows/打包/GPU-DPI 证据和人工 soak checklist。
3. 保持 D7 BLOCKED，直到上述证据和最终静态/动态门禁闭合。

### P1：下一阶段架构补强

1. E0/E1 事件 inventory、schema 和 producer/consumer graph。
2. 最小 keyless chat transcript replay。
3. capability manifest 和 runtime composition manifest。
4. 统一新增异步操作的 outcome/terminal/dispose 规范。
5. `electronAPI` 按真实 consumer 拆出更小 capability closure。

### P2：长期演进

1. 关键聊天事实的 append-only typed session log。
2. 跨窗口/插件/辅助 Surface 的事件回放和诊断。
3. 跨模块安全边界策略与自动检查。
4. 需要时再引入更强的 TypeScript 类型面和 branded identity。

## 结论

VCPChat 与 DeepSeek Harness 的最大差距，不是有没有 `StreamSession` 或 `CustomEvent`，而是 Harness 已经把“可组合运行时、类型事件、durable log、真实入口测试和工程治理”做成了统一制度；VCPChat 目前只在 Chat Kernel/D5-D6 范围内实现了其中一部分。

当前最值得补的不是全仓模仿 Harness，而是把已有的局部优点扩展成可检查的制度：事件图、最小 transcript replay、capability/组合清单、统一 defensive policy，以及真实 packaged 发布证据。其余 Harness 特有能力保持产品差异，不纳入 VCPChat 的完成标准。

