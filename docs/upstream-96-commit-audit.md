# origin/main 上游 96 提交逐项审计

更新日期：2026-08-31  
上游基线：origin/main=4df8f4fa  
本地稳定对照：08511fa5  
当前收口提交：a715dfe3（Select 分组适配与专项回归测试随后追加）

## 使用说明

本表覆盖共同祖先 037a3b9d 到 origin/main 的全部 96 个提交。“最终文件与 origin/main 一致”是通过 git diff --quiet origin/main -- <path> 核验，而不是依据提交拓扑推断。共享设置文件即使与上游存在差异，也只允许保留 UI presentation、生命周期 owner 和测试，不复制旧业务状态、IPC 或 persisted key。合并节点没有独立文件变更，不单独 cherry-pick。

域边界：MobileSync/CDS、TTS、语音输入及原生依赖的业务代码以上游为准；设置共享文件采用上游 canonical business node 后重新挂载本地控件；聊天核心只接受行为等价且不改变协议/持久化的适配。

## 审计表

| 提交 | 上游标题 | 业务域与边界 | 与当前本地差异 | 决策 | 验证证据 |
|---|---|---|---|---|---|
| 912d42cb | fix(sync): correct sqlite tombstone bindings | MobileSync/CDS；协议/持久化以上游 | 有（package.json） | 最终树以上游为准；共享文件仅保留 presentation | npm run test:mobile-sync；cargo test（Rust CDS） |
| 6587f9cc | fix(sync): restore deletion and reconciliation invariants | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 516773a2 | fix(sync): simplify cds entity tombstones | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| ef60fc50 | fix(sync): reject missing sync tokens | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| d09b8541 | fix(cds): clear tombstones on resurrection | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| e6d0573c | refactor(cds): remove unused change feed | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| eb23b79b | refactor(sync): trim dead cds contract state | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| dc54b332 | fix(sync): bind identities into aggregate hashes | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| a4a2b013 | fix(sync): restore message-level LWW arbitration | MobileSync/CDS；协议/持久化以上游 | 有（modules/renderer/messageContextMenu.js） | 最终树以上游为准；共享文件仅保留 presentation | npm run test:mobile-sync；cargo test（Rust CDS） |
| d4e57609 | refactor(sync): remove entity update side channel | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| b4d7cd97 | fix(sync): align config hash clocks | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| c8c3e25b | fix(sync): retain tombstones and surface owner damage | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 82349e62 | merge: integrate upstream VChat updates | 合并节点；无独立边界 | 无 | 历史合并节点；不单独 cherry-pick | 无独立文件；不单独 cherry-pick |
| 7609701f | fix(sync): serve committed entities from CDS | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 552fc5ef | refactor(sync): drop attachment tombstone index | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 01bd7345 | fix(sync): align Wire 1.3 compound identities | MobileSync/CDS；协议/持久化以上游 | 有（.github/workflows/mobile_sync.yml, package.json） | 最终树以上游为准；共享文件仅保留 presentation | npm run test:mobile-sync；cargo test（Rust CDS） |
| a07b9d28 | refactor(sync): normalize legacy compound identities | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 285b73af | refactor(sync): hard-cut legacy compound index schema | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 62916093 | fix(sync): isolate legacy runtime identities | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 307291a3 | fix(sync): close watcher ownership gaps | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| d04692ff | fix(sync): close compound identity data plane | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| e304e4b7 | fix(sync): close legacy identity audit gaps | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 56a967ec | fix(sync): restore default topic lifecycle | MobileSync/CDS；协议/持久化以上游 | 有（modules/chatManager.js） | 最终树以上游为准；共享文件仅保留 presentation | npm run test:mobile-sync；cargo test（Rust CDS） |
| 4f7b54a7 | fix | 其他业务；按上游树接收 | 有（ScriptoriumModules/scriptorium-lineage-ui.js） | 最终树以上游为准；共享文件仅保留 presentation | 上游文件等价检查 |
| a0aae220 | fix | 其他业务；按上游树接收 | 有（ScriptoriumModules/scriptorium-deck-export.js, ScriptoriumModules/scriptorium-deck-renderer.js, tests/scriptorium-vpptx-electron.test.js） | 最终树以上游为准；共享文件仅保留 presentation | 上游文件等价检查 |
| dacfbe71 | fix | 其他业务；按上游树接收 | 有（ScriptoriumModules/scriptorium-navigation.js） | 最终树以上游为准；共享文件仅保留 presentation | 上游文件等价检查 |
| 0eba0ef2 | test(sync): align compound identity contracts | 其他业务；按上游树接收 | 无 | 直接吸收（最终文件与 origin/main 一致） | 上游文件等价检查 |
| 1c5ae3d9 | fix(sync): preserve message tombstones during ingest | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 4e725cf5 | fix(sync): recover physical topic projections | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 074da2cd | fix(sync): refresh CDS before owner manifests | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 76b6532b | fix(sync): preserve tombstones and localize attachments | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| ea9ffc07 | fix(sync): close C1 commit visibility | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 42250d42 | fix(sync): align C2 message commit semantics | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 87dfcd08 | fix(sync): close VChat C6 cleanup | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| aa8a55fb | fix(sync): remove redundant manifest hash alias | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 5acfef67 | refactor(sync): unify owner manifest | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 66aa61da | refactor(cds): collapse tombstone storage | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| f14098cd | fix(cds): accept schema version 2 handshake | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 192ec595 | refactor(sync): normalize legacy state tables | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| f4f9a96a | chore(sync): finish legacy state cleanup | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| a8ead26f | refactor(sync): move central avatar state into cds | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| c54f7cb3 | fix: 补全 applyUserMessageLayoutState 缺失的 import，修复保存全局设置时报 ReferenceError | 其他业务；按上游树接收 | 有（modules/renderer/mainChatSettingsPresentationOwner.js） | 最终树以上游为准；共享文件仅保留 presentation | 上游文件等价检查 |
| 12f7315a | refactor(sync): align desktop and cds wire 1.4 | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 5b0114d3 | fix(ci): 修复 chat_kernel_ui.yml 裸标量中冒号空格导致的 YAML 解析失败 | 其他业务；按上游树接收 | 无 | 直接吸收（最终文件与 origin/main 一致） | 上游文件等价检查 |
| f2c0e9e7 | fix(sync): close cds protocol 3 contract | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| c793a3c3 | Merge pull request #184 from Lutra23/fix/settings-apply-layout-import | 合并节点；无独立边界 | 无 | 历史合并节点；不单独 cherry-pick | 无独立文件；不单独 cherry-pick |
| c3df21bc | Merge pull request #186 from Lutra23/fix/ci-chat-kernel-ui-workflow-syntax | 合并节点；无独立边界 | 无 | 历史合并节点；不单独 cherry-pick | 无独立文件；不单独 cherry-pick |
| 69f1e9ca | fix(sync): unify public request validation | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| c81327e4 | fix(cds): persist synchronized hash roots | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| b94fc94c | refactor(sync): unify message hash ingestion | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| fc252987 | refactor(cds): remove unused blake3 search term | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 6c0eea5d | 补充测试集 | 其他业务；按上游树接收 | 有（tests/scoped-style-code-fence.test.mjs） | 最终树以上游为准；共享文件仅保留 presentation | 上游文件等价检查 |
| 89e02b77 | fix | 聊天核心；行为以上游，冻结协议 | 有（modules/messageRenderer.js, tests/scoped-style-code-fence.test.mjs） | 局部审计：保留上游行为，不恢复旧状态 | guard:chat-kernel-consumers；相关核心测试 |
| 60a23e84 | perf(sync): streamline index refresh and ingestion | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| ba186996 | perf(sync): streamline desktop ingestion pipeline | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| d046a6f9 | fix(cds): preserve ingest recovery invariants | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 4e4c1ded | test(sync): unify desktop decision matrices | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 7085536d | fix(sync): reconcile tombstones into physical history | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 30c2f3fc | fix(sync): harden transient failure recovery | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 52df169a | fix(sync): isolate damaged legacy owners | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| bb442bd2 | fix(chat): avoid reusing deleted default topics | 聊天核心；行为以上游，冻结协议 | 有（modules/chatManager.js） | 局部审计：保留上游行为，不恢复旧状态 | guard:chat-kernel-consumers；相关核心测试 |
| 578bb997 | Merge remote-tracking branch 'origin/main' into agent/vcpmobile-sync-error-contract-1-2 | 合并节点；无独立边界 | 无 | 历史合并节点；不单独 cherry-pick | 无独立文件；不单独 cherry-pick |
| 2e472f67 | fix | 其他业务；按上游树接收 | 有（VCPHumanToolBox/renderer.js） | 最终树以上游为准；共享文件仅保留 presentation | 上游文件等价检查 |
| 8d7f8e7e | refactor(sync): unify canonical key contract | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| a8e13592 | fix(cds): scope file import to Unix | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 006f2260 | fix(sync): restore recovered topic chronology | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 91c9a86b | fix(sync): validate history source evidence | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| e1405a4c | fix(sync): preserve desktop message fields | MobileSync/CDS；协议/持久化以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | npm run test:mobile-sync；cargo test（Rust CDS） |
| 574195af | fix划词助手 | 其他业务；按上游树接收 | 无 | 直接吸收（最终文件与 origin/main 一致） | 上游文件等价检查 |
| d1381c93 | Merge remote-tracking branch 'origin/main' into agent/vcpmobile-sync-error-contract-1-2 | 合并节点；无独立边界 | 无 | 历史合并节点；不单独 cherry-pick | 无独立文件；不单独 cherry-pick |
| 61d9511d | chore(cds): update Windows runtime for protocol 3 | 其他业务；按上游树接收 | 无 | 直接吸收（最终文件与 origin/main 一致） | 上游文件等价检查 |
| 33b8fe1b | Merge pull request #188 from MRiecy/agent/vcpmobile-sync-error-contract-1-2 | 合并节点；无独立边界 | 无 | 历史合并节点；不单独 cherry-pick | 无独立文件；不单独 cherry-pick |
| c412e732 | 替换网络语音引擎为mimo | TTS；供应商/播放链路以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | 设置 UI 回归；上游 TTS 测试待平台服务证据 |
| 5ed0a888 | 替换网络tts供应商为mimo/dmx | 语音输入/辅助窗口；IPC/生命周期以上游 | 有（main.html, modules/renderer/messageContextMenu.js, modules/renderer/middleClickHandler.js 等） | 最终树以上游为准；共享文件仅保留 presentation | node --test tests/voice-input-engine.test.js（macOS 缺运行时时跳过） |
| 414049a1 | 优化ui | 设置/UI；仅保留展示适配 | 有（main.html, modules/settingsManager.js, styles/setting/settings-agent-sections.css） | 局部适配：保留上游行为，叠加本地展示/构建增量 | npm run test:uiux；设置保存回归；artifact gate |
| 6364f03b | fix | TTS；供应商/播放链路以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | 设置 UI 回归；上游 TTS 测试待平台服务证据 |
| f92f4423 | 优化 | 语音输入/辅助窗口；IPC/生命周期以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | node --test tests/voice-input-engine.test.js（macOS 缺运行时时跳过） |
| 741fec3c | 支持clone模式 | TTS；供应商/播放链路以上游 | 有（.gitignore, AppData/mimotts/README.md, AppData/mimotts/aemeath.wav 等） | 最终树以上游为准；共享文件仅保留 presentation | 设置 UI 回归；上游 TTS 测试待平台服务证据 |
| b3ca932a | fix说明 | 设置/UI；仅保留展示适配 | 有（main.html） | 局部适配：保留上游行为，叠加本地展示/构建增量 | npm run test:uiux；设置保存回归；artifact gate |
| aed9e392 | 迁移系统到electron 44大幅提升稳定性 | Electron/依赖；运行时以上游 | 有（NativeSpalash/src/main.rs, README.md, StartVCPchat.exe 等） | 局部适配：保留上游行为，叠加本地展示/构建增量 | 构建/pack 检查；跨平台证据待对应平台 |
| 0ecd21dc | 迭代pretext依赖 | Electron/依赖；运行时以上游 | 有（modules/renderer/pretext.bundle.js, modules/renderer/pretext.esm.js, package-lock.json 等） | 局部适配：保留上游行为，叠加本地展示/构建增量 | 构建/pack 检查；跨平台证据待对应平台 |
| fe0535ef | 修复pretext迭代和electron迭代引发的兼容问题 | 其他业务；按上游树接收 | 有（ScriptoriumModules/scriptorium.js, ScriptoriumModules/vdoc-hybrid-compiler.js） | 最终树以上游为准；共享文件仅保留 presentation | 上游文件等价检查 |
| a2da94af | fix | 其他业务；按上游树接收 | 有（VCPDistributedServer/Plugin/PTYShellExecutor/PTYShellExecutor.impl.js） | 最终树以上游为准；共享文件仅保留 presentation | 上游文件等价检查 |
| 404b2e6c | fix mermaid竞态 | 聊天核心；行为以上游，冻结协议 | 有（modules/chat/contentTransforms.js） | 局部审计：保留上游行为，不恢复旧状态 | guard:chat-kernel-consumers；相关核心测试 |
| d815fa16 | 新增高级流式动画控制器 | 设置/UI；仅保留展示适配 | 有（main.html, modules/global-settings-manager.js, modules/renderer/mainChatSettingsPresentationOwner.js 等） | 局部适配：保留上游行为，叠加本地展示/构建增量 | npm run test:uiux；设置保存回归；artifact gate |
| 790940b3 | 加难度 | 其他业务；按上游树接收 | 有（test.md） | 最终树以上游为准；共享文件仅保留 presentation | 上游文件等价检查 |
| 688aeb11 | fix | 语音输入/辅助窗口；IPC/生命周期以上游 | 有（modules/settingsManager.js） | 最终树以上游为准；共享文件仅保留 presentation | node --test tests/voice-input-engine.test.js（macOS 缺运行时时跳过） |
| 91f5e86d | Merge pull request #189 from awei807-wei/baselink | 合并节点；无独立边界 | 无 | 历史合并节点；不单独 cherry-pick | 无独立文件；不单独 cherry-pick |
| af764ef3 | 大工程推进 | 语音输入/辅助窗口；IPC/生命周期以上游 | 有（main.html, modules/global-settings-manager.js, modules/renderer/mainChatSettingsPresentationOwner.js 等） | 最终树以上游为准；共享文件仅保留 presentation | node --test tests/voice-input-engine.test.js（macOS 缺运行时时跳过） |
| 03abbcb6 | 工程持续推进 | 语音输入/辅助窗口；IPC/生命周期以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | node --test tests/voice-input-engine.test.js（macOS 缺运行时时跳过） |
| f58a7b9d | 工程持续推进 | 语音输入/辅助窗口；IPC/生命周期以上游 | 有（main.html, modules/global-settings-manager.js, modules/renderer/mainChatSettingsPresentationOwner.js 等） | 最终树以上游为准；共享文件仅保留 presentation | node --test tests/voice-input-engine.test.js（macOS 缺运行时时跳过） |
| b9e2b573 | 持续迭代升级 | 语音输入/辅助窗口；IPC/生命周期以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | node --test tests/voice-input-engine.test.js（macOS 缺运行时时跳过） |
| 8fecce4b | 加速工程推进 | 语音输入/辅助窗口；IPC/生命周期以上游 | 有（modules/chat/singleChatRequestOrchestrator.js, modules/chatManager.js, modules/tavernRulesEngine.js 等） | 最终树以上游为准；共享文件仅保留 presentation | node --test tests/voice-input-engine.test.js（macOS 缺运行时时跳过） |
| accc88e5 | 狂暴工程迭代收尾 | 语音输入/辅助窗口；IPC/生命周期以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | node --test tests/voice-input-engine.test.js（macOS 缺运行时时跳过） |
| 3eae725a | 加固 | 语音输入/辅助窗口；IPC/生命周期以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | node --test tests/voice-input-engine.test.js（macOS 缺运行时时跳过） |
| 4df8f4fa | 加固 | 语音输入/辅助窗口；IPC/生命周期以上游 | 无 | 直接吸收（最终文件与 origin/main 一致） | node --test tests/voice-input-engine.test.js（macOS 缺运行时时跳过） |

## 当前总体结论

- 96 个提交均已纳入审计集合；其中无独立文件的合并节点均标记为不单独 cherry-pick。
- 业务整域文件相对 origin/main 已无差异；设置/UI 和本地设计系统差异集中在 presentation 层。
- 已运行的 MobileSync/CDS、UIUX、设置保存和聊天核心门禁见 upstream-priority-integration-audit.md。
- 语音运行时启动证据仍受 macOS 缺少 darwin-arm64 二进制限制；Windows 需在对应环境补跑。

## 2026-08-31 Select 分组适配补充

为保留上游 MiMo 音色的 preset/voicedesign/voiceclone 分组，Select presentation 现支持原生 `<optgroup>`：分组标题以 `role="presentation"` 投影，不能污染 `role="menuitem"` 数量或原生 option 索引；选中标记、禁用项、点击写回、Escape 关闭和 owner dispose 均继续作用于原生 `<select>`。新增 `tests/uiux-primitives.test.mjs` 专项回归，验证分组标题、索引稳定性和 teardown。该改动仅属 presentation，不改变 TTS 业务状态、IPC 或持久化键。
