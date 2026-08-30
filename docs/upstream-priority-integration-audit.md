# 上游逐项同步与成熟实现保留方案

更新日期：2026-08-30  
当前本地稳定基线：`08511fa5`  其中包含恢复后的设置页 UI 增量。  
当前上游基线：`origin/main`（当前抓取到 `4df8f4fa`）。

## 目标

在不重写旧开发历史、不整体覆盖本地成熟实现的前提下，逐项吸收上游新增能力。代码与业务行为发生冲突时，保留行为更完整、生命周期更安全的一方；上游新增能力必须纳入，但应适配到本地已有的 owner、Surface、状态和测试边界。

本方案适用于当前分支相对 `origin/main` 的上游差异。共同祖先实际为 `037a3b9d`；从计划指定的上游里程碑 `b9e2b573` 到当前 `origin/main=4df8f4fa`，first-parent 队列实际只有 4 个提交。共同祖先到上游的 96 个差异中，前 92 个已在本地旧开发历史中以不同拓扑存在，不能重复 cherry-pick。它是执行合同，不把尚未审计的提交或测试写成已完成状态。

## 不变边界

- 不改写 `codex/vcpchat-settings-harness-all-workspace-20260824` 的既有历史；`backup/pre-upstream-priority-20260830` 继续作为回滚对照。
- 不整体替换 StreamCoordinator、StreamProjection、MessageRenderer、ChatDomRenderer、聊天协议、IPC、持久化、Plugin Loader、动态壁纸和聊天内容渲染。
- 设置页只允许改变 presentation、适配层、样式和对应测试；canonical business node、persisted key 和保存语义保持不变。
- 不引入 React、Vue、Cordis 或第二份 durable UI state。
- 所有 listener、observer、timer、portal、异步任务和临时 DOM 必须由明确 owner 管理，并在 dispose 时达到 quiescence。

## 当前基线与证据

| 项目 | 值 |
| --- | --- |
| 本地稳定提交 | `08511fa5` |
| 上游抓取提交 | `4df8f4fa` |
| 共同祖先 | `037a3b9d` |
| 共同祖先到上游差异 | 96（历史拓扑差异，不等于待 cherry-pick 队列） |
| 计划队列（`b9e2b573..4df8f4fa`） | 4 个 first-parent 提交 |
| 本地历史领先量 | 约 1000+，不作为逐项重放队列 |
| 设置恢复提交 | `f45f7fd5`、`1e477e7d`、`15ca4203`、`08511fa5` |
| 未提交工作区 | 仅 `.codebuddy/`，不纳入本方案 |

## 逐项审计记录

上游提交按拓扑顺序建立清单；本轮明确关注 `b9e2b573` 至 `4df8f4fa` 的 4 个 first-parent 提交。共同祖先到上游的其余历史差异只用于核对，不重复导入。每个提交在任何 cherry-pick 或手工适配之前，必须填写以下字段：

```text
提交：<hash> <标题>
文件范围：<文件列表>
业务域：语音输入 / 移动同步-CDS / TTS / Electron-依赖 / 聊天核心 / 设置-UI / 文档测试
本地改造交集：无 / 仅展示层 / 运行时架构 / 业务状态
边界影响：持久化、IPC、聊天协议、生命周期（逐项说明）
上游行为：<新增或修复的可观察行为>
本地成熟实现：<已有 owner、状态、DOM、适配和测试>
决策：直接吸收 / 局部适配 / 保留本地并记录差异 / 暂缓
验证：<focused test、门禁、Electron journey 或阻断条件>
```

审计清单按以下顺序维护：

1. 语音输入引擎与辅助窗口能力；
2. 移动同步与 CDS 协议；
3. TTS 供应商及语音面板；
4. 聊天核心和流式运行时；
5. 设置、主题和外观 UI；
6. Electron、依赖、打包和 lockfile；
7. 文档、脚本、测试和证据产物。

基础设施先于依赖升级，业务行为先于视觉微调；同一提交同时跨多个域时拆成局部适配，不用整文件接收。

## 冲突决策规则

### 可以直接吸收

- 不与本地改造文件重叠的纯业务修复；
- 已有本地测试无法覆盖、且上游提供明确回归测试的安全边界修复；
- 不改变 persisted key、IPC 参数和 canonical DOM 的小型兼容修复。

### 必须局部适配

- 同时触碰本地 Surface/Stream/Renderer owner 的提交；
- 同时触碰设置 DOM 与设置桥接的提交；
- 上游把行为写进旧 listener、旧全局状态或隐藏 DOM，而本地已有明确 owner 的提交；
- 依赖上游新 API，但本地已有等价 capability seam 的提交。

局部适配时先保留本地结构，再把上游行为接入现有 capability；不得复制一份 durable state，也不得恢复已退役的旧 listener。

### 暂缓

- 需要尚未安装的本地引擎、Windows 打包环境或外部服务才能验证的提交；
- 会整体改写聊天协议、持久化格式或插件边界的提交；
- 只有截图变化、没有明确生产消费者或验收标准的展示改动。

## 每个功能组的验收

每完成一个功能组，至少运行其 focused tests，并记录结果；设置组额外运行：

- `npm run check:uiux`
- `npm run build:uiux`
- `npm run check:uiux:artifacts`
- `node --test tests/uiux-primitives.test.mjs tests/uiux-settings-bridge-modules.test.mjs tests/global-settings-save.test.mjs`
- 全局设置首次打开、重开、reload、保存失败重试；Select/LanguageRow 菜单、Escape、外部点击和 dispose。

聊天/流式组额外运行 Chat Kernel guard、operation sequence、辅助窗口 reload/crash 场景；Electron/依赖组额外运行对应平台和打包检查。未具备所需平台证据时，只能标记为“代码已适配，证据待补”。

## 第一批执行队列

第一批不从最新提交整体 merge，而是按最早可验证的业务能力增量开始：

- 语音输入引擎：核对 preload、IPC、runtime 和降级路径；
- 移动同步/CDS：核对协议字段、错误合同、锁与降级模式；
- TTS 供应商：核对配置迁移、失败重试、Surface owner 和供应商切换；
- Electron/依赖升级：最后处理 package、lockfile、原生模块和打包产物。

聊天核心与设置 UI 分别进入专项队列，不与基础设施提交混合。语音窗口若与本地 Surface 架构冲突，只吸收行为级修复，不整文件接受上游。

## 当前 4 个上游提交审计结果

| 顺序 | 提交 | 业务域 | 文件范围 | 与本地成熟实现的交集 | 边界影响 | 当前决策 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `8fecce4b` 加速工程推进 | 聊天请求编排、辅助语音窗口 | `Voicechatmodules/voicechat.js`、`modules/chat/singleChatRequestOrchestrator.js`、`modules/chatManager.js`、`modules/tavernRulesEngine.js`、Rust Assistant、2 个测试 | 高；本地已有 Surface-owned renderer、stream 和 history authority | `sendToVCP` 签名不变；新增规则/附件/模型构建，改变 stream registration 与请求生命周期；持久化 key 不变 | 局部适配；先审阅 orchestrator 行为和测试，不整提交接收 |
| 2 | `accc88e5` 狂暴工程迭代收尾 | Windows 原生语音输入 | VoiceChat UI、`voiceHandlers.js`、Rust voice runtime 与 Windows 二进制 | 高；本地 VoiceChat 和 capture 生命周期已有改造 | 移除 native mode select；capture settle、F24 停止键和状态字段变化；IPC capture 生命周期变化 | 暂缓；需要 Windows/Electron journey，先补生命周期测试 |
| 3 | `3eae725a` 加固 | 语音 capture debounce | `modules/ipc/voiceHandlers.js` | 高 | session timer、trailing-edge debounce、自动结束；IPC 事件名不变 | 暂缓；先补 timer/stop 竞态测试 |
| 4 | `4df8f4fa` 加固 | 辅助窗口中止请求 | VoiceChat、Rust Assistant | 高；本地已有 stream runtime | `interruptVcpRequest` 成功后立即 `streamRuntime.cancel`；无持久化/协议变化 | 局部适配；接入现有 `interruptHandler`，不整文件覆盖 |

这 4 个提交是当前真正需要处理的上游队列；共同祖先到 `origin/main` 的其余历史差异不重复导入。任何“直接 cherry-pick”都必须先满足表中的边界和验证条件。

### 52df169a 之前的存储/协议依赖链审计

以下提交在拓扑上属于 `52df169a` 的前置依赖链（并非待按顺序 cherry-pick 的新队列）。它们依赖上游后续的 Wire 1.4 或 `owners/topics/messages` 新表，不能在当前 Wire 1.2 与 `entity_index/message_index` 基线上整体接收。保留上游行为意图，先记录可抽取的无协议增量，待端到端迁移批次单独处理：

| 提交 | 主要变化 | 与当前基线的冲突 | 决策 |
| --- | --- | --- | --- |
| `5acfef67` | 合并 Owner Manifest，强化复合身份校验 | 本地仍使用 agent/group dataType，移动端 Wire 1.2 不兼容 | 暂缓；只保留现有 Topic owner 冲突 guard |
| `192ec595` | 迁移 owners/topics/messages 规范表与复合主键 | 会破坏现有墓碑、历史索引和已验证数据库 | 暂缓；需迁移脚本与回滚方案 |
| `f4f9a96a` | 清理旧状态日志/注释 | 依赖新表，无独立行为收益 | 随 schema 批次处理 |
| `a8ead26f` | 将 central avatar 状态迁入 CDS | 改变头像持久化归属并新增 HTTP 端点 | 暂缓；需移动端与 CDS 同批发布 |
| `12f7315a` | Wire 1.4、严格帧键和 v2 HTTP 端点 | 与当前 Wire 1.2 协议不可混跑 | 暂缓；不得 cherry-pick |
| `60a23e84` | source hash 快路径、prepared statement、reconcile 锁 | 依赖新 schema/字段 | 后续抽取锁与快路径思路，映射到本地表后再实现 |
| `ba186996` | ingest 事务锁、批量 Topic 更新、avatar path cache | 依赖新 schema 与 v3 reconcile 端点 | 后续局部适配；先不引入新端点 |

`52df169a..b9e2b573` 之间仍有 6 个同步提交（`8d7f8e7e`、`a8e13592`、`006f2260`、`91c9a86b`、`e1405a4c`、`61d9511d`）待逐项检查；其中 `61d9511d` 已知涉及 CDS schema/protocol 版本升级，先按迁移批次暂缓，其余提交不因拓扑邻近而直接接收。

### 已吸收记录

| 提交 | 本地提交 | 验证 | 备注 |
| --- | --- | --- | --- |
| `912d42cb` 修复 SQLite 删除索引绑定 | `f719212f` | `node --test tests/mobile-sync-sqlite-delete.test.js`（4/4） | 无冲突吸收；补入位置绑定修复、删除错误上下文和专门回归测试 |
| `6587f9cc` 恢复删除与对账不变量 | `625469a9` | `node --test tests/mobile-sync-*.test.js`（92/93，1 skip）；`cargo test`（52/52） | 局部合并；保留增量历史扫描、来源状态和本地日志，同时接入实体/消息墓碑、物理 Topic 修复与聚合哈希 |
| `516773a2` 简化 CDS 实体墓碑 | `56188419` | `node --test tests/mobile-sync-*.test.js`（92/93，1 skip）；`cargo test`（54/54） | 直接吸收；仅重构已验证的 CDS 墓碑存储，不改变本地 Wire 1.2 边界 |
| `ef60fc50` 拒绝缺失同步令牌 | `386e4b05` | MobileSync 聚焦测试通过 | 直接吸收启动和 HTTP 鉴权门禁 |
| `d09b8541` 复活时清理墓碑 | `dac06163` | Rust CDS 聚焦测试通过 | 直接吸收 Owner/Topic/消息复活清理 |
| `e6d0573c` 清理未使用变更流 | `8f07df6b` | `node --test tests/mobile-sync-error-contract.test.js`（10/10） | 局部吸收；移除无生产调用方的 change_log/路由，保留错误码注册和 Wire 1.2 golden |
| `eb23b79b` 收缩 CDS 适配器状态 | `a2263a72` | `node --test tests/mobile-sync-*.test.js`（92/93，1 skip）；`cargo test`（53/53） | 直接吸收；清理无效附件结果依赖并收紧实体批量请求上限 |
| `dc54b332` 绑定身份到聚合哈希 | `5d6d6641` | `node --test tests/mobile-sync-*.test.js`（92/93，1 skip）；`cargo test`（56/56） | 与 `a4a2b013` 合并适配；消息指纹和 Topic/Owner 根哈希绑定稳定身份 |
| `a4a2b013` 恢复消息级 LWW 仲裁 | `5d6d6641` | 同上；包含编辑回滚与 updatedAt 断言 | 保留本地 watcher lease/history authority，仅接入 updatedAt、时间/哈希仲裁和协议字段 |
| `d4e57609` 移除实体更新旁路 | `f507699b` | MobileSync 聚焦测试通过 | 直接吸收；实体状态统一走上传、消息推送和墓碑协议 |
| `b4d7cd97` 对齐配置哈希时钟 | `44be7753` | `node --test tests/mobile-sync-*.test.js`（95/96，1 skip）；`cargo test`（56/56） | 与消息版本适配合并；配置 DTO 默认值、哈希时钟和 Rust/桌面语义统一 |
| `074da2cd` CDS 刷新时序 | `0b48d186` | `node --test tests/mobile-sync-sqlite-delete.test.js`（18/18） | 局部适配；在 owner_metadata Phase ACK 前等待一次 reconcile，保留本地阶段 owner |
| `c54f7cb3` 修复设置保存导入 | `2ab75855` | 设置桥接与全局保存回归测试通过 | 直接吸收；补齐消息布局函数导入，未改变设置状态或持久化键 |
| `5b0114d3` 修复 CI YAML | `adfc9684` | `git diff --check` | 直接吸收；仅调整工作流命令块格式 |
| `30c2f3fc` 加固瞬态失败恢复 | `a3034285` | `node --test tests/mobile-sync-*.test.js`（96/96，1 skip）；`cargo test`（56/56） | 局部适配；统一 `SYNC_SNAPSHOT_STALE`、CAS/物理文件校验和流式错误终止，保留本地索引与 writer 生命周期 |
| `52df169a` 隔离损坏 legacy Owner | `d610c102` | `node --test tests/mobile-sync-sqlite-delete.test.js`（19/19） | 局部适配；进程内 Owner 隔离只作用于 legacy Manifest，成功重扫清理标记，central CDS 不读取 |
| `006f2260` 恢复 Topic 时间线 | 待提交 | `node --test tests/mobile-sync-sqlite-delete.test.js`（20/20）；`cargo test`（57/57） | 局部适配；恢复 Topic 使用 ID/mtime 时间，恢复项前置但保留 default 首位与用户配置顺序 |
| `e1405a4c` 保留桌面消息字段 | `252bc539` | `node --test tests/mobile-sync-streaming.test.js`（14/14） | 局部适配；移动推送只 patch 可移植字段，保留桌面扩展和附件本地路径，未改协议 |

### 暂缓记录

| 提交 | 阻断条件 | 最小下一步 |
| --- | --- | --- |
| `c8c3e25b` 保留墓碑并暴露 Owner 损坏 | 会删除本地已验证的墓碑保留/损坏降级逻辑，且与当前 CDS 存储语义相反 | 暂不吸收；先以现有 56 个 Rust 测试和 MobileSync 93 项测试为基线，若上游有独立行为需求再局部移植 |
| `6364f03b` MiMo 音色设计模型 | 当前 `SovitsTTS` 仍是本地/旧网络模型结构，直接套用会冲突 | 暂缓；先定义网络 TTS capability，再补 voicedesign 请求和密钥/缓存测试 |
| `f92f4423` TTS 播放速度透传 | 与本地 TTS Surface owner、音频队列和播放时钟实现交集较高 | 暂缓；在现有 owner 中局部接入 playbackRate，并补 Electron 音频队列回归 |
| `5ed0a888` 网络 TTS 供应商切换 | 同时改动设置桥接、TTS 服务、消息菜单和 Surface 生命周期 | 暂缓；拆分供应商请求、设置迁移和播放 Surface 三个独立变更 |

## 回滚与提交策略

- 每个功能组形成独立、可审查的中文提交；提交前保存 `git diff --check`、focused test 和冲突决策。
- 不对旧分支 force-push；需要回退时使用备份分支或可逆提交。
- 任何适配失败先记录复现条件、冲突文件和最小下一步；不能以“测试未跑”宣称完成。
- 最终交付前比较文件树、生成产物、核心业务文件和设置 persisted key，确认没有因同步丢失本地成熟 UI。

## 当前状态

已完成：建立 `08511fa5` 稳定基线，恢复设置页行布局、字号/数值步进、字体选择、自动保存兼容和 portal 层级。  
进行中：按拓扑顺序吸收 MobileSync/CDS 协议修复，当前已完成 `912d42cb` 至 `b4d7cd97`、`30c2f3fc`、`52df169a`、`006f2260` 和 `e1405a4c` 的可验证子集；其余历史差异继续逐项审计。
未完成：`c8c3e25b` 及依赖协议/数据库迁移的提交仍暂缓；语音、TTS、Electron/依赖和设置 UI 专项适配及跨平台证据仍需按受影响范围补齐。

### `30c2f3fc` 局部适配记录

- **保留的上游行为**：配置/历史 CAS、头像物理文件校验、消息索引时间和 Topic 索引漂移统一报告快照过期；CDS 内部 `SNAPSHOT_STALE` 在插件边界映射为 Wire 1.2 的 `SYNC_SNAPSHOT_STALE`；已开始的 NDJSON 响应通过受保护 writer 写入错误帧后再结束。
- **本地结构**：继续使用现有 `entity_index`、消息历史 authority、`NdjsonWriter` 和统一错误 envelope；没有引入上游不存在于本地的 `staleLive` 第二状态，也没有新增全局 listener 或持久化键。
- **验证证据**：`node --test tests/mobile-sync-*.test.js`（96 pass、1 skip）；`cargo test`（56/56）；错误契约 golden、CAS 并发写入和流式背压测试均通过。
- **提交**：`a3034285`（独立中文提交）；当前分支尚未推送。

### `52df169a` 后续手工适配说明

该提交的 `unhealthyLegacyOwners` 隔离机制已按本地 `entity_index` + `scanEntities` 架构局部适配：仅在 legacy 非 central manifest 路径增加进程内 owner 级隔离，区分配置解析失败与事务失败，并在成功重扫或物理目录消失后清理标记；central CDS 路径不维护第二份状态。回归测试覆盖损坏 Owner 不阻塞其他清单、修复后重新纳入 Manifest，且使用真实 `registerRoutes` 消息处理器验证过滤层。
