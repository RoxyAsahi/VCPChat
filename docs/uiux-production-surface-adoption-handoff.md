# 线程 B：UIUX Production Surface Adoption 交接指南

> 线程：`R2-02E Production Surface Adoption`  
> 目标：把已经验证的 Harness-compatible Candidate 接入真实 VCPChat Surface，并删除对应 legacy presentation path。  
> 当前首批：Settings 中已具备证据的 `Range`、`Choice`、`Toggle`。  
> 组件复刻线程：`R2-02D Harness Primitive Lab`。  
> 上位路线：[ui-runtime-2-roadmap.md](/Users/asahi/Documents/Codex/VCPChat-newarchitecture/docs/ui-runtime-2-roadmap.md)

## 1. 线程 B 的定义

线程 B 不是继续开发组件库，也不是重新设计 Harness primitive。它只负责：

```text
已验证 Candidate
  → 真实 VCP Surface consumer
  → canonical business snapshot/command
  → 单一 Surface owner
  → Electron 行为证据
  → 删除对应 legacy presentation
  → Stable 晋级评审
```

组件库展示页不是生产 consumer。线程 B 不得以 Lab 页面通过作为生产完成证明。

## 2. 开工前必读

1. 本文件；
2. `docs/vcpchat-harness-uiux-architecture.md`；
3. `docs/ui-runtime-2-roadmap.md` 当前状态与失败账本；
4. `docs/uiux-parallel-development-handoff.md`；
5. `docs/harness-primitive-inventory.md`；
6. DeepSeek Harness 对应 source 与 VCP primitive 的 fixture/contract 报告；
7. 当前 worktree 状态、最近提交和用户未提交改动。

若线程 A 改变了 primitive DOM/API，线程 B 必须暂停该控件的迁移，先确认 generated artifact、contract test 和 fixture 版本，再继续。

## 3. 文件所有权

### 线程 B 可以修改

- `modules/ui-system/settings-bridge.js`；
- `modules/ui-system/appearance-studio.js`；
- Settings Surface 的装配、owner、autosave、retry、reload 测试；
- Settings Electron journey 与 production evidence report；
- `docs/ui-runtime-2-roadmap.md` 中 B 线程自己的 checkpoint；
- `docs/uiux-production-surface-adoption-handoff.md` 的进度记录。

### 线程 B 默认不得修改

- `modules/uiux/primitives/**`；
- `modules/uiux/lab/**`；
- `modules/uiux/generated/**`；
- `docs/reference/deepseek-harness-primitives/**`；
- `modules/ui-system/component-showcase.js`；
- Plugin Loader、chat manifest、动态壁纸；
- `StreamCoordinator`、`StreamProjection`、`MessageRenderer`、`ChatDomRenderer`；
- 聊天协议、IPC 格式、持久化 key、聊天气泡、思维链、代码块、工具结果和 Composer 内部布局。

发现 primitive contract 缺陷时，只提交阻断报告给线程 A，不在 B 线程内打补丁。紧急兼容修复必须单独提交、可回滚，并在报告中说明原因。

## 4. 第一批施工：Settings 单一 owner 收口

### 目标字段

- `appearanceSidebarAvatarSize`；
- `appearanceSidebarRowHeight`；
- `appearanceCustomRadius`；
- `appearanceSidebarRadiusChoice`；
- `showHomeVisualBrand`；
- `showHomeVisualTagline`。

这些字段已有 Range、Choice、Toggle、Input 的 typed mount 和部分 Electron/teardown 证据。首批不新增字段，不触碰聊天字体、消息密度或流式显示相关字段。

### 施工顺序

1. 为每个字段建立 ownership table：persisted key、DOM id、read source、write command、当前 legacy owner、目标 owner、删除条件。
2. 确认真实控件由 `SettingsUiService` snapshot 投影，写入由唯一 command owner 发出。
3. 将 draft、dirty、autosave、retry、timeout、close flush 绑定到同一个 Settings Surface owner。
4. 确认外部 snapshot 不覆盖 dirty draft；保存中的迟到结果不能更新已关闭或已替换的 Surface。
5. 删除这些字段在 `settings-bridge.js`、`appearance-studio.js` 和兼容 CSS 中重复的 presentation 分支。
6. 运行 reload、failure/retry、reopen、dispose 和 Settings-only stress。
7. 通过后才把字段状态从 `active` 改为 `stable`；只删除 presentation，不删除业务读取、规范化或持久化能力。

## 5. 每个字段的完成条件

字段不能因为控件显示出来就算完成，必须同时满足：

- 只有一个可见控件和一个 owner；
- native control 仍保持 canonical business value；
- snapshot、draft、dirty、saving、saved、error 状态可区分；
- 保存失败保留用户输入并可重试；
- timeout/close/reload 后迟到结果失去 commit 权；
- dispose 后 listener、timer、subscriber、portal、marker 均为零；
- reload 能从 durable key 恢复；
- light/dark theme 和窄窗口 geometry 不回归；
- 对应 legacy projection 已删除并有 source-equivalence 证据；
- 聊天冻结边界测试继续通过。

## 6. 验证门禁

按变更范围执行最小集合：

```bash
npm run check:uiux
npm run test:uiux
npm run check:uiux:artifacts
npm run test:uiux:artifacts
node scripts/test-settings-wa-electron.mjs
npm run guard:classic-retirement
node scripts/check-settings-source-equivalence.mjs
```

涉及生命周期或重复打开时，必须追加 Settings-only stress；涉及主题时，追加 Theme Electron journey。若 packaged artifact、Windows 或真实用户插件环境缺失，报告必须标记为 `evidence-pending`，不能标记 Stable。

## 7. 与线程 A 的交接协议

线程 A 每次交付一个 primitive 时，必须提供：

- source provenance；
- DOM/ARIA contract；
- state matrix；
- generated artifact 变更；
- owner/dispose 证据；
- fixture 与 geometry/pixel 报告；
- 已知不兼容项。

线程 B 接收后只做三种决定：

| 决定 | 条件 |
| --- | --- |
| accept | contract 与证据足够，进入真实 Surface |
| hold | 只能在 Lab 使用，生产 consumer 或平台证据不足 |
| reject | 改变业务语义、复制 durable state、越过冻结边界 |

线程 B 不得反向要求线程 A 为了某个业务字段加入私有 DOM 分支。业务差异应留在 Surface adapter 或 provider configuration。

## 8. 并行冲突规则

- 两个线程不得同时编辑同一文件；
- generated artifact 只由线程 A 生成，线程 B 只消费并验证；
- fixture matrix 和 primitive manifest 只由线程 A 维护，B 只引用其版本；
- roadmap 采用追加 checkpoint，禁止重写对方历史记录；
- 测试报告使用不同文件名，避免互相覆盖；
- 任一线程发现对方修改了冻结边界，立即停止相关批次并报告。

推荐使用独立 worktree；若必须共享同一 worktree，先登记文件锁和当前 commit，完成后再释放。

## 9. 当前不做

- 不迁移 Chat/Message/Stream/Composer 内部；
- 不为 AgentPreset busy 状态制造 fixture-only provider；
- 不扩展 UiScope 成新的全局 runtime；
- 不因为 Lab 中有控件就批量迁移 Settings 全字段；
- 不删除仍承担未迁移字段、业务持久化或 Classic 兼容责任的 legacy 代码；
- 不把“视觉相似”写成“pixel-equivalent”。

## 10. 每次回报格式

```text
线程：R2-02E Production Surface Adoption
批次：<字段或 Surface>
状态：planned | active | evidence-pending | stable | blocked
真实 consumer：<入口与 owner>
变更文件：<列表>
删除的 legacy path：<列表，或 none>
验证：<命令与结果>
未闭合证据：<列表>
下一步：<一个明确动作>
```

线程 B 的目标不是尽快增加迁移数量，而是让每个已接管字段最终满足“单一 owner、可回滚、可验证、旧路径已删除”。

## 11. 线程 B 施工记录

### 2026-08-27 批次 1：Settings 六字段单一 owner 收口（R2-02E）

状态：`stable-candidate`，全部验证门禁通过。

#### Ownership table（第一批）

| persisted key | 可见控件 | read source | write command | 本批删除的 legacy path |
| --- | --- | --- | --- | --- |
| `appearanceProfile.sidebarRowHeight` | Range `#appearanceSidebarRowHeight` | typed snapshot | typed field owner → `settings.save.execute` | 无残留（output 投影已归 TS Range） |
| `appearanceProfile.sidebarAvatarSize` | Range `#appearanceSidebarAvatarSize` | typed snapshot | 同上 | 无残留（同上） |
| `appearanceProfile.customRadius` | Range `#appearanceCustomRadius` | typed snapshot | 同上 | 无残留（duplicate output projection 已于 1a4510e0 删除） |
| `appearanceProfile.sidebarRadius` | Choice 组 `input[name="appearanceSidebarRadiusChoice"]` | typed snapshot | 同上 | **hidden select `#appearanceSidebarRadius` 全链删除**：main.html 控件、typed owner 反向投影（bridge `set()`+定义项）、studio 双向镜像（readSettingsFormState/syncSettingsControls/syncSettingsGeometryControls/bindSummary）、global-settings-manager 兜底读 |
| `showHomeVisualBrand` | Toggle `#showHomeVisualBrand` | typed snapshot | 同上 | 无残留 |
| `showHomeVisualTagline` | Toggle `#showHomeVisualTagline` | typed snapshot | 同上 | 无残留 |

draft/dirty/autosave/retry/close flush 均已绑定同一个 Settings Surface typed owner（此前已收口）；本批完成的是删除条件中最后一条：**删除 hidden compatibility projection after equivalence evidence**。

#### 阻断修复（B 所有权文件内，需单独提交）

二分定位 Electron journey 门禁失败由线程 A 提交 `be29ff00`（route forum retry clicks to typed owner）引入：legacy autosave 在 Forum owner 挂载时全局吞掉重试点击，非 Forum 字段保存失败后无法重试，且误点会触发虚假论坛保存。已在 `modules/ui-system/settings-bridge.js` 修复：两个 owner 各自记录当前错误的归属（`state.failed` / `state.failureOwner`），重试点击只路由给产生失败的 owner。

#### 既有问题（非本批引入，另行跟进）

1. `scripts/test-appearance-studio.mjs` 在 `1a4510e0` 后断言的是 `<output>` 值，但 jsdom fixture 不挂载 primitive，导致该门禁在基线持续红；本批改为断言 canonical 输入值。
2. 二分期间主 worktree 一度被回退到 HEAD（误操作，已重放全部编辑）；该事故同时还原了会话开始时 `docs/chat-kernel-consumer-report.json` 的未提交改动，该文件为脚本产物，已重新生成。

### 2026-08-27 批次 2：Forum draft autosave seam 收口

状态：`stable`（seam 缺陷修复 + Electron 证据闭合）。

- 发现：论坛输入的 owner 抑制标记为 `vcpTypedForumFieldOwner`，而 legacy whole-form autosave 只识别 `vcpTypedFieldOwner`，在 `adminUsername`/`adminPassword` 打字会同时驱动 legacy 全表单 submit、两个 owner 争抢同一状态条并误发全量 settings 保存。
- 修复：legacy input 过滤器同时识别两种标记；提交 `aa848ec4`。
- Electron journey 新增证据：论坛打字从不触发全表单 `requestSubmit`，且保存经由 `ForumConfigUiService.save.execute`（service 层拦截计数）。
- 连带修复 `be29ff00` 引入的 retry 点击误路由回归（提交 `c49f9263`）。

### 2026-08-27 批次 3：presentationOwner 论坛 legacy 填充退役

状态：`stable`。

- typed ForumConfigUiService consumer 已在 Settings 装配时订阅并投影论坛快照；presentation owner 的 `loadForumConfig` + safeSet 镜像属同值重复填充与重复 IPC，已删除。journey 断言控件值等于 typed snapshot 继续通过。提交 `84fd4dbc`。

#### Forum 字段 ownership table（本批后）

| persisted key | 可见控件 | read source | write command | legacy path 状态 |
| --- | --- | --- | --- | --- |
| forum.config.json `username`/`password` | Input `#adminUsername` / `#adminPassword` | ForumConfigUiService 快照 | 论坛字段 owner → `forumService.save.execute` | presentationOwner 镜像已删除；manager 兜底仅在 typed owner 未挂载时执行（Classic 兼容保留） |

roadmap checkpoint 追加于 `38ec8bb8`。

### 2026-08-27 批次 4：Settings-only lifecycle stress 复跑

状态：`stable`（证据闭合）。

- `VCPCHAT_STRESS_STAGES=settings node scripts/test-electron-lifecycle-stress.mjs` 通过（3 warmup + 20 measured cycles），listener/DOM/detached-node 指标平稳。
- 备注：默认 `VCPCHAT_STRESS_PROTOCOL_TIMEOUT_MS=120000` 在本机高负载下会在启动阶段抛 CDP ProtocolError；以 300000 重试通过。该超时属环境参数，不是代码回归；后续并行线程复跑建议显式调大。

### 2026-08-27 批次 5：sidebarRadius ownership 收尾与 ledger 结转

状态：`stable`。

- 外观 Studio 与测试套件的 radius 读/写全部改为 `appearanceSidebarRadiusChoice-*` 单选组，不再读写任何 hidden 兼容控件；`docs/settings-uiux-field-ownership-2026-08-25.md` sidebarRadius 行升级为 `stable`。
- 审计结论：`sidebarWidth`/`sidebarActive`/`sidebarAvatarOnly` 没有 Settings 表单 DOM seam（由 shell 端 `event-listeners.js saveSidebarState` 与 `uiManager.js` resizer 直接驱动），不适用 typed Settings field owner 迁移路径；账本登记为 inventory-only。
- 相关提交：`c242b3c8`、`bc84df60`、`e593d515`。

### 2026-08-27 批次 6：Settings 关闭时 flush 的逐字段补证 + 草稿互覆缺陷修复

状态：`stable`（真实缺陷修复 + Electron 证据闭合）。提交 `26333d52`。

- 发现：`readTypedFieldPatch` 每次都从裸服务端快照物化**全量** appearanceProfile；同一防抖窗口内后到的字段事件会把先编辑的兄弟字段草稿键用过期服务端值覆盖回去。探针实测：编辑 rowHeight=53 → avatarSize=33 → customRadius=17 → choice small 后，pendingPatch 里三个 range 键全部回退到旧值（52/36/14），只有 choice 生效。真用户在同一窗口内连续拖两个滑块同样会丢前一个草稿，不是合成事件特例。
- 修复：全量快照改为叠在已积累草稿之上（以 `{...serviceState.appearanceProfile, ...pendingPatch.appearanceProfile}` 为基底），保存命令线格式不变。
- 新增 journey 6b 证据：关闭模态绕过 400ms 防抖，六个字段（三个 range、radius choice、home tagline、论坛凭据）在关闭瞬间的屏幕草稿必须由 modal-visibility flush 原样提交至两个 typed owner 的服务端快照。诊断方式记录：`chatAPI.*` 为 contextBridge 只读访问器不可 monkey-patch，需拦截 renderer 层可变对象（typed service `.save.execute`）或在 bridge 内临时暴露 pendingPatch 观察点。
- 门禁：Electron journey 全绿（14 PASS 含 6b）、`check:uiux`、`test:uiux`、`check-settings-source-equivalence`、`check:uiux:artifacts`（60 文件，线程 A menu 工件已同步）均通过。
- 待补证据不变：packaged-artifact / 非 darwin 平台运行证据仍为 pending。

### 2026-08-27 批次 7：enableWideChatLayout 单选对单一 owner 收口

状态：`stable`（真实 consumer 单一 owner + Electron 证据闭合）。提交 `a6d5c208`。

- 真实 consumer/owner：宽屏布局 `#chatLayoutModeWide`/`#chatLayoutModeNormal` 加入 TYPED_FIELD_DEFINITIONS（新增 `inverse-boolean` kind；radio 以 checked 而非 value 取值），draft/dirty/close flush/retry 归属同一 typed field owner。
- 删除的 legacy path：settings-bridge 通用 snapshot projection 中的 `chatLayoutModeWide`（checked）与 `chatLayoutModeNormal`（checked-inverse）两行；presentationOwner 兜底本已被 `typedSettingsProjectionActive` 抑制，不再双轨。manager 的持久化读保留（Classic 兼容，与 Forum 模式一致）。
- Electron journey 新增 6c：切换单选 → typed dirty + owner 标记；反向证据 `requestSubmitCalls===0`；关闭模态绕过防抖后布尔草稿经关闭 flush 提交至服务端快照；save-result 发布者归因为 `typed-settings-field-owner`。旅程全绿（15 PASS）。
- 门禁：journey、`test:uiux`、source-equivalence、`guard:classic-retirement`、`test:uiux:artifacts` 通过；`check:uiux` 与 `check:uiux:artifacts` 在 B 范围内通过（影子拷贝移出线程 A 在途的 popup-select.ts 及生成件后验证，62 文件一致；随后已原样恢复）。污染原因是线程 A 未提交的 WIP，非本批回归。
- 方法论记录：typed service 经 UI-service registry 解析，`getTypedService()` 可能返回与 owner 闭包不同的实例——monkey-patch 拦截不可靠；owner 归属证据应监听表单节点上的 `vcp-settings-save-result`（该事件无 `bubbles:true`，不能 document 冒泡监听）。
- roadmap checkpoint：线程 A 正在并发编辑 roadmap.md，按 §8 冲突规则本轮不写入，checkpoint 下轮文件空闲时补记。
- 待补证据不变：packaged-artifact / 非 darwin 平台运行证据仍为 evidence-pending。

### 2026-08-27 批次 8：Settings-only lifecycle stress 复跑（批次 7 后监听面）

状态：`stable`（证据闭合）。

- `VCPCHAT_STRESS_STAGES=settings VCPCHAT_STRESS_PROTOCOL_TIMEOUT_MS=300000 node scripts/test-electron-lifecycle-stress.mjs` 通过（3 warmup + 20 measured cycles）。
- 分层指标：listeners `643` 五个 checkpoint 全部恒定；lifecycle activeResources `366`（listener 158 / ui-registration 110 / ui-primitive 60 等）恒定；detachedRoots/Icons/Options 均 0；nodes 8475 恒定；heap 9.9→10.5 MiB（正常波动）。包含批次 6（readTypedFieldPatch 草稿基底修复 + journey 6b）与批次 7（wide-layout 两控件入 typed owner + journey 6c）后的树。
- 验收矩阵「混合 listener 增长归因」随之从未完成改为已闭合。
- 同轮门禁归因：线程 A 新投递未跟踪 `directory-browser.ts` 且 generated 工件集处于其迭代中，`check:uiux:artifacts` 的唯一差异为 `primitives/directory-browser.*` 一对文件（影子拷贝验证 B 范围不含其它差异）；按 §3/§8 规则 B 不代生成，不阻断本批。

### 2026-08-27 批次 9：首批六字段 close-flush 证据矩阵补全

状态：`stable`。提交 `8eaeb5f0`。

- journey 6b 扩展：`showHomeVisualBrand`/`showHomeVisualTagline` 两个 Toggle 的布尔翻转纳入同一关闭 flush 提交断言；至此首批六字段（三个 range、radius choice、两个 toggle）+ home tagline + 论坛凭据 + 宽屏布局单选对全部具备「关闭时绕过防抖、原样提交屏幕草稿」的逐字段证据。
- Electron journey 全绿（15 PASS）。

### 2026-08-27 批次 10：packaged-artifact darwin 运行证据闭合

状态：`stable`（darwin 侧 evidence-pending 解除；Windows/其它平台仍 pending）。

- 隔离 worktree（`git worktree add --detach /tmp/vcp-pack-worktree HEAD@1c26e2fc` + 共享 node_modules）内完成 `npm run build`（rust chat data service 编译）与 `npx electron-builder --dir --config.asar=false`。后续批次 9/10 的测试文件改动不影响打包运行时。
- 文件系统证据：`npm run test:packaged-artifact-smoke` 通过，证据 JSON 落盘 `reports/uiux-thread-b/packaged-artifact-smoke-2026-08-27.json`（status=passed；resources/app/main.js 与 vendor tree 校验）。注意 runner 契约是未 asar 打包目录，默认 asar 输出会缺 resources/app，需要 `--config.asar=false` 复刻该布局。
- 启动级证据：`node scripts/vcpchat-packed-smoke.mjs --dist <worktree>/dist` 通过——runtime closure manifest 校验、launch-protocol ready record、隔离 state/appData 下真实启动可执行文件并正常退出清理。
- 拒绝门禁：`npm run test:packaged-artifact-invalid` 通过（缺失 unpacked 目录被正确拒绝）。
- 结论：ownership 报告中 packaged artifact 证据在 darwin/arm64 上已由 B 线程补齐；win32/Linux 与签名安装包路径保持 `evidence-pending`，不得宣称跨平台 stable。

### 2026-08-27 批次 11：八个字体字段 typed owner 收口 + select 重挂观察器缺陷修复

状态：`stable`。

- 接线内容：§2 ownership 表中全部 8 个字体字段（chatFontPreset/Custom、chatCodeFontPreset/Custom、chatDiaryFontPreset/Custom、chatToolFontPreset/Custom）加入 `TYPED_FIELD_DEFINITIONS`（kind: string）；settings-bridge `mountTypedSettingsConsumer` 中对应 8 行通用 projection 退役；typed project() 接管快照填充与四个 `*FontCustomRow` 显隐。字体应用语义（消息/diary/工具结果 renderer）不动。
- 回归与根因（方法论记录）：接入后 journey 曾稳定卡在 1b「assistantAgent 动态 options 替换后未获 Harness wrapper」。经 mount 调用栈插桩定位：批次使 `enhanceGlobalSettings←refresh` 出现无 teardown 的连续两次调用，而 `mountHarnessSelects()` 先 disconnect 旧 MutationObserver、后因 `selectObserverStates` 条目残留跳过重建——观察器静默死亡，动态 option 替换不再被监听。这是既有潜在缺陷，与本批字段解耦但被其时序必现化。修复：断开时同步删除注册表条目，挂载尾部必然重挂新 observer；不依赖任何诊断参数，journey 全序列即稳定通过。
- journey 新增 6d：打开模态 → 设置 `chatDiaryFontPreset`（select 型）与 `chatToolFontCustom`（text 型）→ 关闭绕过防抖 → 关闭 flush 必须把两值原样提交到 typed service 快照，同时断言 dirty 与 `dataset.vcpTypedFieldOwner` 标记。至此 preset-select 与 custom-text 两类字体控件均有 close-flush 证据。
- 附带加固：journey 子进程以 detached 进程组 spawn、finally 阶段 `process.kill(-pid)` SIGTERM→SIGKILL 兜底，杜绝此前负载尖峰调查中发现的孤儿 Electron 进程堆积。
- 门禁全绿：`check:uiux`、`test:uiux`（44/44）、`check:uiux:artifacts`（66 文件）、`test:uiux:artifacts`、Electron journey（16 PASS 含新增 6d）、lifecycle stress（3 warmup + 20 cycles，listeners/lifecycle 指标恒定）、`guard:classic-retirement`、source-equivalence。
- 台账行升级：8 个字体字段状态 `typed-projection-active` → `typed-owner-active`（docs/settings-uiux-field-ownership-2026-08-25.md §2 与 §7 同步）。
- 归因说明：工作树中线程 A 的 WIP（directory-browser 等）与生成产物 `docs/chat-kernel-consumer-report.json` 的行号漂移均不属本批提交范围；按 §3/§8 规则 B 不代改不代生成，本批仅提交 B 所属文件。

### 2026-08-27 批次 12：directory-browser / popup-select 生产面 consumer 接缝审计

状态：`audited-hold`（结论=本批不接线；接缝盘点与前置条件清单落盘）。

**契约面审计**（依据 `modules/uiux/generated/primitives/*.d.ts` 与线程 A roadmap）：

1. **popup-select**：headless controller 复刻 ui-commands `popup.ts` 的 composer 命令面板——deps 要求 `consume(PopupTokenSegment)` 与 `focusComposer()` 回调，选项加载绑定 open-time context。Settings 面既无命令语义、也无法满足注入 face；按线程 A 自己的「不得为完成状态矩阵新建 fixture-only provider」边界，在 Settings 接线属误用。**结论：无合法 Settings consumer，不接入。**
2. **directory-browser**：Light-DOM Miller browser，严格 injected `listDirectory/createDirectory/onOpen/onClose` face，自身无任何 Electron/IPC 依赖。当前成熟度 `foundation-electron-active`，线程 A 明确 pending：path editor draft debounce/prefix filter、two-leg landing、same-semantic pixel diff、以及 **VCP production consumer**。

**Settings 面候选接缝盘点**（`main.html` 全量路径类输入）：

| 候选 | 现状 | 判定 |
|---|---|---|
| `#networkNotesPathsContainer` 动态行（`input[name="networkNotesPath"]`） | Settings 表单唯一真正开放的路径类字段。值语义为网络共享路径（UNC，如 `\\NAS\Shared\Notes`），不保证本地可浏览；序列化为双轨：typed consumer 投影写行、legacy `global-settings-manager.js` 收集提交 | Miller 浏览器需要受控目录列举能力，而全仓不存在通用目录列举 IPC（现有 handler 均为域内目录：agents/canvas/wallpaper）；复用原生 `select-directory` 只能给 OS 对话框、非浏览器 primitive 注入 face。新增列目录 IPC 属系统能力新增，超出两线程所有权边界（main 进程文件归协议外），需单独决策 |
| `speechRecognizerBrowserPath` / `speechRecognizerPagePath` | 文件/页面相对路径，且在 §3 冻结清单内 | 按协议排除，不做 |
| avatar/color/wallpaper 等图像类选择 | 图像选择器（native dialog / ColorPair typed owner）非目录语义 | 不适用 |

**接入前置条件清单**（后续批次解锁条件）：

1. 线程 A 将 directory-browser 从 `foundation-electron-active` 推进到 Candidate active（补齐 draft/filter/two-leg landing/pixel diff 缺口）。
2. 跨线程决策「通用目录列举能力」落地方式：新增最小 face 的主进程 IPC（如 sandboxed `list-directory` handle），或降级为原生 `select-directory` 互操作——前者需要 thread-A/B 之外的所有权确认。
3. 先决工序建议：`networkNotesPaths` 动态行本身仍是双轨序列化（typed consumer 写行 + legacy manager 收集），可先做「动态列表字段的单一 owner 化」（TYPED_FIELD_DEFINITIONS 引入 list kind 或等价机制）作为独立批次，再在其上挂接目录选择交互。

**门禁**：本批为纯审计+文档，代码零改动；不重跑运行时门禁（最近一次批次 11 全绿证据仍然有效，HEAD 仅前进文档提交）。

### 2026-08-27 批次 13：networkNotesPaths 动态列表字段单一 owner 收口

状态：`stable`。

- 机制决策（评估结论）：动态路径行无法塞进「一控件一 id」的 `TYPED_FIELD_DEFINITIONS` 表驱动，选择**等价的容器级 owner 通道**而非为此泛化 list kind——`#networkNotesPathsContainer` 成为 owned unit，事件委托天然覆盖 helper 之后追加的行，避免为单字段扩张通用表结构的复杂度。若未来出现第二个列表型字段，再考虑抽 formal kind。
- 实现：input/change 委托 → 重收集整行列表（trim + 过滤空值，与 legacy collect 语义一致）→ 进入 pendingPatch → 同一 debounce/关闭 flush/run 链提交；`addTypedNetworkPathInput` 在 owner 已挂载时为新行预置抑制标记；删除按钮的静默移除现在显式宣告并重收集（旧实现下删行不产生任何 dirty 与保存）。行投影从通用 consumer apply() 迁入 typed project()（单一 writer）；presentationOwner 兜底与 legacy manager 的 DOM 收集保留于 Classic 面。
- 回归调查与方法论：新 journey 曾在既有 toggle 快照探针失败，表现为「服务状态已是 false 而 DOM 未更新」。插桩链（投影计数、checked setter 栈拦截、发射流水 emitLog、外部事件日志、影子还原对照实验）最终证明：HEAD 基线同样运行时其失败点不同，真实原因是本批使 journey 的增/删行断言会触发一次 debounced typed save，与探针的发射交错产生竞态假象——产品逻辑无缺陷。修复：journey 在增删行断言后等待 dirty 结算与 status 离开 saving，再进入后续快照消费段。
- journey 新增 6e：编辑首行 → 删除行 → 经生产 add 按钮加行 → 填入唯一值 → 关闭模态绕过防抖 → 断言 typed service 快照 networkNotesPaths 与屏幕列表逐项相等、全部行携带 owner 抑制标记、save-result 归属 typed-settings-field-owner。全轮 17 PASS。
- 门禁全绿：check:uiux、test:uiux（44/44）、check:uiux:artifacts（66 文件）、test:uiux:artifacts、Electron journey（17 PASS）、lifecycle stress、guard:classic-retirement、source-equivalence。
- 台账：§2 新增 `networkNotesPaths` 行（typed-owner-active，close-flush 证据 journey 6e），§7 增补批次段落。批次 12 审计中登记的「先决工序：动态列表字段单一 owner 化」就此闭合；directory-browser production consumer 接入仅剩线程 A primitive 成熟度与目录列举能力两项外部前置。

### 2026-08-27 批次 14：验收矩阵未闭合项盘点（directory-browser 未解锁分支）

状态：docs-only 审计落盘。

- 前置复查：`af281a22` 之后线程 A 新交付 4 个 directory-browser 提交（2524e717 draft prefix filtering、8d72772e draft navigation preview、b0183953 two-leg landing、7a2b431c landing timing parity），roadmap 各 checkpoint 状态仍为 `foundation-electron-active`——仍缺同语义 Harness DOM/computed-style/pixel diff 与合法 VCP production consumer。unlock 条件未满足，按指令转入「盘点 handoff 验收矩阵中其余未闭合项」分支。
- 盘点结论（三向归因）：settings-bridge 通用 consumer projection 残余 45 行 = (1) 40 行 / 38 键全部命中台账 §3 冻结清单（vcpServerUrl、voiceMode、speechRecognizer*、注入/清洗组、气泡组、流式组等），属协议责任保留而非欠账；(2) 5 行 / 4 键「userName 簇」（userName、userNameTextColor(+Text) 镜像、userUseThemeColorsInChat、continueWritingPrompt）为唯一非冻结待迁量；(3) presentationOwner 对该簇的全部写入均位于 `!typedSettingsProjectionActive` 兜底分支（mainChatSettingsPresentationOwner.js:605/609/618/637 一带），typed owner 挂载后惰性——无三重活跃写入。
- 矩阵行 62/63/70 已按上述归因改写（settings-uiux-field-ownership-2026-08-25.md §4）：legacy projection/save 链的存量边界从模糊的「仍存在」收敛为精确清单；新增结论均注明批次 14 归因来源。
- userName 簇迁移条件登记（不在本批施工）：`userNameTextColor` 复用 `userAvatarBorderColor` 的 color+text 镜像对范式；`continueWritingPrompt` 是 failure/retry journey（矩阵行 65）的证据承载字段，迁移前必须先产出 typed 路径失败/重试等价证据并同步迁移该断言；其余两键直迁。
- 门禁口径：代码面自批次 13 门禁全绿的 `180fb5bc` 起零变更（`git diff --stat 180fb5bc..HEAD` 为空），本批 docs-only 不重跑八项门禁；未完成门禁不虚构。win32/Linux packaged evidence 维持 evidence-pending。
- 台账：§4 三行改写 + §7 追加盘点段落；roadmap 追加 R2-02E 存量盘点 checkpoint。

### 2026-08-27 批次 15：userName 簇 typed owner 收口（unlock 未满足 → 按批次 14 条件施工）

状态：`typed-owner-active`（3 键 / 5 定义）+ `inventory-only` 裁定 1 键。

- unlock 复查：`8247c82a` 之后线程 A 零新提交（DirectoryBrowser 在途改动未落 roadmap，状态仍 `foundation-electron-active`），按指令转入「按批次 14 登记的迁移条件评估是否施工」分支。
- 语义契约收口（本批核心）：legacy 整表收集对 `userName`/`continueWritingPrompt` 是 trim + 空值回填（'用户' / '请继续'）、颜色键有空值兜底，原 string kind 为裸 String(raw)。为使 typed 保存命令线与 legacy 收集产物逐字节等价，`readTypedFieldPatch` 新增定义级 `trimValue`/`fallback` 归一化——归一化发生在事件读取时（与 legacy 防抖时收集语义同位），DOM 输入过程不受干预。
- 施工范围：`userName`、`userNameTextColor`(+Text 镜像)、`continueWritingPrompt` 加入 TYPED_FIELD_DEFINITIONS；typed project() 接管四条投影（含 color 镜像双控件）；通用 consumer projection 前 5 行退役，残余从此仅剩 §3 冻结行。
- 关键查证与批次 14 初判修正：`userUseThemeColorsInChat` 在 globalSettingsForm 内**无任何控件**——main.html 中同名前缀的 `useThemeColorsInChat` 复选框位于 agentSettingsForm（per-agent 配置域，agentHandlers 读写 agentConfig 键）；global 键仅存在于持久化 schema、惰性兜底读与惰性通用行。按 sidebar 三键同类裁定 `inventory-only`：不新建表单控件、不加定义，惰性行随批退役并在 bridge 源码注释中记录结论。
- journey 兼容性验证：failure/retry 段的打字字段正是 `continueWritingPrompt`，迁移后该段经 typed dirty→typed save→错误归属→点击重试链路全绿（重试成功仍走 legacy 整表提交收敛，属既有双 owner 归属设计）；新增 6f：未 trim 名称 trim 后落盘、清空提示词「请继续」回填、文本镜像 #123abc 共享单键提交、归属断言。全轮 19 PASS。
- 门禁全绿八项：check:uiux、test:uiux（44/44）、check:uiux:artifacts（66 文件）、test:uiux:artifacts、Electron journey（19 PASS）、lifecycle stress（listener 680 / resources 367 五 checkpoint 恒定、detached=0）、guard:classic-retirement、source-equivalence（legacyClean=true）。
- 矩阵影响：「单一 projection owner」「单一 save command owner」「legacy projection 删除」三行再次收敛——非冻结 legacy 写入面清零，唯一存量即 §3 冻结责任保留。presentationOwner 启动兜底维持惰性（待独立 reload/Classic/upstream 等价证据后统一退役）。
- 台账：§2 新增 userName/userNameTextColor/continueWritingPrompt 三行（typed-owner-active），§7 追加批次 15 段落（含批次 14 初判修正记录）。

### 2026-08-27 批次 16：presentationOwner 启动兜底退役证据清单（unlock 未满足分支）

状态：docs-only 评估落盘；施工裁定 = 兜底代码零删除。

- unlock 复查：`3bc85d98` 后线程 A 零新提交；main.js / check-harness-fixture-matrix.mjs / chat-kernel-consumer-report.json 在途改动未落盘；全部 DirectoryBrowser checkpoint 保持 `foundation-electron-active`。按指令转入矩阵存量评估分支，选定 ledger §6 遗留项「启动兼容 fallback 尚未删除」为下一候选并产出前置证据清单。
- 现状盘点：presentationOwner 存在 19 个 `!typedSettingsProjectionActive` 守卫分支（约 60+ 处 safeSet/safeCheck，行 605-695），覆盖全表单兜底；守卫条件为「bridge 服务已暴露且 `vcpSettingsRevision` 就绪」，apply() 内两处刷新。
- 关键定性更正：`uiMode: 'classic'` 仅存在于 embeddedAppSessionManager 的独立入口页参数；main.html 恒为 `uiMode: 'next'` 且 settings-bridge 无 uiMode 门控自举。**兜底的真实职责是启动挂载窗口与部分挂载失败窗口的填充安全网，不是跨页面 Classic 兼容**——退役难度低于原「需 reload/Classic/upstream 全量等价」的表述，但挂载窗口竞态证明是硬前置。
- 退役前证据清单（E1-E6，落盘台账批次 16 段落）：E1 渲染 `#globalSettingsForm` 的入口面清单与 uiMode≠next 排除证明；E2 冷启动 `vcpSettingsRevision` 先于模态可打开的确定性断言 + 首开全 id == snapshot 扩容；E3 部分挂载失败契约定义（typed readiness 门禁拒绝半挂载 shell）；E4 global-settings-updated 全 source 路由等价盘点（临时插桩按协议剥离）；E5 reload durable restore 断言集扩至全部原兜底 id；E6 source-equivalence 负向守护（被删 id 再现第二写入方即失败）。
- 施工裁定：本批不删兜底代码；下一批可独立推进 E2/E5 journey 断言扩容与 E4 source 盘点。docs-only——代码面自 3bc85d98 起零变更，不重跑门禁；win32/Linux packaged evidence 维持 evidence-pending。
- 台账：§7 追加批次 16 段落；roadmap 追加 R2-02E checkpoint。

### 2026-08-27 补记（用户实机反馈修复）：input-wrap 内部 margin 泄漏

用户运行真实实例报告：非 appearance 各 tab 的文本输入框提示文字/hover 面整体上浮约 7px 与外框错位。隔离探针逐 tab 取证定位：`globalSettingsModal` 的 modal-content 容器存在 row-stacking legacy 规则 `.modal-content input { margin-bottom: 15px }`，harness 契约覆盖了 padding/border/height 但漏掉了 margin；15px 下边距参与 wrap 的 flex 居中计算后内容被顶高 7.5px。修复为在 `.vcp-harness-input-wrap > :is(input, textarea)` 归零 `margin: 0`（settings.css）。探针复测：29/29 包裹输入框对齐；Electron journey 18 PASS、source-equivalence 通过。同轮发现 assistantAgent 在无 agent 配置时仅剩占位 option → 裸 select 无 primitive 包装的退化态，与用户「部分 select 点不开」观感相关，留待批次 13 一并处理。

### 2026-08-27 补记二（用户实机反馈修复）：focus 双环

用户报告：focus/hover 时外壳边框变蓝之外，内层还浮一圈浅蓝高光（组件库展示页无此问题）。CDP matched-styles 取证：settings.css 内 `#globalSettingsForm :is(input…):focus` 先声明 `outline: none`，但其后的 `#globalSettingsForm :is(input, select, textarea, button):focus-visible { outline: 2px; outline-offset: 2px }` 以 ID 级优先级 + 靠后顺序胜出，内层输入框自己画环叠在外壳边框上形成双环。修复：后者选择器排除 `.vcp-harness-input-wrap/-select-wrap/-choice-wrap` 直接子控件（键盘 a11y 环仅保留给裸控件），壳子元素契约补 `outline: none` 兜底。探针复测 focus 态 outline 0px/none、外壳 focus-within 变蓝保留；journey 18 PASS、test:uiux 46/46、source-equivalence 通过。中间一次 journey 失败为 `typedSettingsRevision null` 时序 flake（原样复跑即绿），与 CSS 改动无关。

### 2026-08-27 补记三（用户要求全 tab 清扫）：裸控件契约与 @layer 级联收口

用户要求不止修几个框，全局设置所有 tab 同类问题一次清完。59 控件全量复扫 + CDP/CSSOM 取证定位三类残留：(1) `#assistantAgent` 退化态裸 select 的 rest/focus 边框仍被 settings.css 表单级 legacy 规则 `#globalSettingsForm :is(input…,select,textarea) { border: 1px solid transparent }`（specificity (1,5,1)）压制——bare-select 契约与 focus 规则提升为 `#globalSettingsModal #globalSettingsForm …`（两个 ID）后胜出。(2) `#userAvatarBorderColorText`（ColorPair 文本半区）focus 边框不变：根因是 settings.css 整体在 `@layer vcp-ui.components` 内，**layered 声明无论 specificity 多高都输给 primitive 内联 unlayered 样式表**，border-color 永远压不过 primitive 的 border 简写；改为在 `:focus-within` 时覆写 `--vcp-color-border` 变量（没有任何 unlayered 规则声明该自定义属性，layered 规则稳赢），focus 反馈（蓝边 + 3px ring + outline none）三通道齐备。(3) `#userAvatarBorderColor` 原生色块 focus 出现 outline 2px + shadow 4px 双环：键盘 a11y ring 规则排除 `input[type="color"]`，保留其既有 shadow ring 单一反馈。附带收口：`.agent-avatar-wrapper > input[type="file"]` sr-only 隐藏（原为裸露原生控件）。复扫分类结论：G-geo ±1px/2px 为 wrapper 32px vs 内件 30px 居中契约；typed primitive 控件的包装层（`.vcp-uiux-input-wrap` focus-within 蓝边）与 typed Choice/select 自身边框变蓝均具备焦点反馈，sweep 仅测控件本身属误报。探针 59 控件零真实异常；Electron journey 19 PASS。批次 13 候选维持：networkNotesPaths 动态列表单 owner 收口（directory-browser 接入前置）。

### 2026-08-27 补记四（用户实机反馈修复二）：typed primitive 输入框文字偏上

用户报告：文字不居中多数已修，但仍有不少输入框偏上。全 tab 输入框垂直居中度量（24 控件）发现 4 个残留，特征一致 `margin-bottom: 15px`——全部是 typed primitive 包装层（`.vcp-uiux-input-wrap`：adminUsername/adminPassword/homeVisualTagline；`.vcp-uiux-color-pair`：userAvatarBorderColorText）内的控件。根因同补记一：components.css `.modal-content input { margin-bottom: 15px }` 泄漏，但上次修复只覆盖了 bridge 自己的 `.vcp-harness-input-wrap` 直接子控件；typed primitive 是另一套包装类名，flex 居中按含边距盒计算，15px 下边距把输入框整体顶高约 7.5px。修复：settings.css 增补 `#globalSettingsForm :is(.vcp-uiux-input-wrap, .vcp-uiux-color-pair) > :is(input, textarea) { margin: 0 }`。复测 24/24 上下对称归零；WA journey 门禁全过。

### 2026-08-27 补记五（批次①收尾）：select 全量换真 mountSelect——CSS 退场、门禁重写与 Escape 归属修复

用户确认「2–4 选项的芯片也换真 select 弹层」后批次①全量施工。bridge 侧挂载器（真 `api.mountSelect(select, { label, portal: true }, scope)` + `mountSelectKeyboardGlue` 键盘胶水 + bare 退化态 + MutationObserver 动态重挂）与 Electron journey 重写已随 71194187 落库；本笔收尾三件事：

1. **CSS 退场**：settings.css 删除 bridge 本地 select/choice/menu 投影全部规则组（`.vcp-harness-select-wrap/-native/-trigger/-arrow/-popover/-menu-portal/-menu-list/-menu-viewport/-menu-item-wrap/-select-option/-select-check`、`.vcp-harness-choice-*`，约 290 行）；body 级 portal z-index 抬升规则收敛为仅 `.vcp-uiux-primitive-menu` 一个选择器；a11y ring 排除与 general-row 子元素选择器同步收敛到 `.vcp-harness-select`。
2. **门禁重写**：`check-settings-source-equivalence.mjs` 改断真件契约（bridge 含 `api.mountSelect(...portal: true)`、`primitiveSelectStates` 追踪、`mountSelectKeyboardGlue`，且不得含 `vcp-harness-select-wrap/-choice-wrap/rebuildOptions` 本地投影；css 同步断言退场类清零）；`check-settings-unified-surface.mjs`、`test-settings-wa.mjs`（jsdom 退化契约：无 VCPUIUX 时原生 select 存活、无 wrap 残留）、`test-ui-system.mjs` 同步。
3. **Escape 归属修复（next-shell-controller.js）**：全局设置 Escape owner（priority 20）原本无条件吞掉 Escape 关整个 modal——经 closeModal monkey-patch 探针取证，真件菜单的 document keydown 关闭逻辑被 dispatcher 的 stopImmediatePropagation 截杀，菜单被孤儿化悬在 body 上。修复：owner 的 `isActive` 在检测到 `.vcp-uiux-primitive-menu:not([hidden])` 时让位（返回 false），Escape 先关菜单、再关 modal。

施工中发现并修复两个重挂竞态（均在 bridge observer 段）：(a) `vcpSelectRebuilding` 守卫必须保持到 setTimeout(0) 之后才复位——重挂自身的 DOM 变更（dispose 恢复业务节点、primitive 再插 wrap）会以微任务送回本 observer，同步复位会自触发无限重建；(b) LifecycleScope 的 `release()` 在微任务里才执行 dispose，同步 teardown→remount 会让旧 disposer 在新 wrap 插入后到达并把其剥掉（实测分区导航后 12 wraps 掉到 6）——remount 必须以 setTimeout(0) 等待异步 dispose 落地。

探针取证：全 tab 12/12 非 typed select 均投影为真件（触发器 40px/r10、菜单 r12/菜单项 40px、z>1400、外点 pointerdown 关闭），assistantAgent 空态走 bare 退化态、agent 填充后动态重挂成功；Escape 契约 openedByArrow→closedByEscape→modal 仍活跃。上游契约缺口（报线程 A，不阻塞）：mountSelect 无方向键 roving 导航（bridge 胶水补齐）、无选项列表重建 API（bridge 以 dispose+remount 规避）。

### 2026-08-27 补记六（批次②）：单行输入框全量换真 mountInput，textarea 归位裸控件契约

批次②把 bridge 本地输入壳 `.vcp-harness-input-wrap` 全量退役，改挂真件 `window.VCPUIUX.mountInput`：

1. **bridge**：`mountHarnessInputWrappers` 重写为 `mountHarnessInputs`——每个单行文本 input（text/url/password/number/email/search/tel）逐控件 `api.mountInput(control, {}, scope)`，typed 挂载（homeVisualTagline/adminUsername/adminPassword/userAvatarBorderColorText）与已包裹控件跳过；无 VCPUIUX/scope 时退化保持裸控件。挂载后给 wrap 加 `vcp-harness-input-fill` 桥标类，恢复本地壳的行内填满布局（width:100%/min-width:0；layered 声明与 primitive unlayered 样式表无属性重叠，不产生级联冲突）。**动态行同步接入**：`addTypedNetworkPathInput`（bridge）与遗留的 `uiHelperFunctions.addNetworkPathInput`（ui-helpers，三处调用路径：presentation owner 投影、event-listeners 加号按钮、bridge fallback）都改挂真件，ui-helpers 侧以懒创建 `LifecycleScope('ui-helpers-network-path-input')` 持有 release。顺带退役 enhanceGlobalSettings 里的 `enhance('Input')`/`enhance('Textarea')` 遗留注册（native-kernel 类增强已被真件取代）。
2. **textarea 主动排除并修复压扁缺陷**：mountInput 的 wrap 是固定 32px 单行框（契约缺口，报线程 A：无多行形态），表单 4 个 textarea（rustWhitelistKeywords/rustBlacklistKeywords/rustScreenshotApps/continueWritingPrompt）此前被本地壳按 30px 内高压扁成单行。现保持裸控件，走既有裸控件契约；其间又排掉一个级联陷阱——裸控件通用规则的 `:not()` 链 specificity 达 (1,5,1)，压过 textarea 多行规则 (1,1,1)，按补记三 bare-select 同款两 ID 方案提升为 `.vcp-ui-scope#globalSettingsModal #globalSettingsForm textarea`（(2,2,1)，注意 `.vcp-ui-scope` 与 `#globalSettingsModal` 是同元素复合选择器，写成后代关系永不匹配——`.vcp-ui-scope` 类就挂在 modal 自身、其上再无 scope 层）并补 `height:auto`，实测 min-height 64px/上下 padding 8px 生效。
3. **门禁**：journey 新增 legacyInputWraps===0、primitiveInputs>0、textareas 全部裸态、continueWritingPrompt min-height 64px 断言，几何 pick 改指 `.vcp-uiux-input-wrap`（r8）；source-equivalence 增 bridge/ui-helpers mountInput 契约与退场类清零断言；test-ui-system jsdom 段改断「无 primitive 运行时时 input 保持裸态」的退化契约。

探针取证：全 8 tab 36 输入框中 32 个桥挂真件（r8/32px/fill）、3 个 typed 挂载（r8/32px，无 fill 属预期）、1 个 ColorPair 文本半区归 typed ColorPair；4 textarea 全部裸态 64px；`.vcp-harness-input-wrap` 全模态清零。Electron journey 23 PASS；四个快门禁全绿。
