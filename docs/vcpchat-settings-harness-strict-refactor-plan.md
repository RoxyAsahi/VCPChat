# VCPChat 设置页 Harness 严格重构计划

## 目标

本轮目标不是继续给旧表单叠加 CSS，而是让全局设置 Surface 在结构、primitive ownership、状态生命周期和验收证据上与 DeepSeek Harness 同构。

范围仅限唯一的全局设置 Surface；不迁移 Notes、翻译、日志等嵌入业务页面，也不引入 React/Vue。

## 严格差异基线

当前实现仍存在以下待解决差异：

1. Select 的业务 source 仍是 native `select`（为保留 IPC/form 语义），但 presentation 已收敛为 Harness Menu 同构 DOM/ARIA；后续只需继续扩展跨平台操作证据，不再保留第二套视觉 owner。
2. GeneralRow 已完成旧 row 物理替换并有 row-copy slot，但 AppearanceRow 的字段类型拆分仍未完成。
3. bridge 的旧节点/class 快照恢复路径已删除；teardown 只释放 owner，不再复活 retired DOM。
4. 设置 trigger 的字体 token、Menu portal 生命周期和 Harness 源码数值需要逐属性自动比对。
5. 旧 `settings-global-modal.css` 已确认无消费者并物理删除；dead stylesheet gate 已加入。

## 分阶段施工

### 当前审查结论（2026-08-23）

Terra 风格对抗审查确认：旧实现清理门禁此前遗漏了 legacy row 包裹、tablist 语义、外层旧 stylesheet、Input/Select 字体契约、Appearance 固定三列和 portal 生命周期差异。本轮已完成物理 row 替换、移除 tab/tabpanel 语义、删除旧 global modal stylesheet、live source scaffold marker 清理，并把这些差异加入本计划的强制验收项。

### Phase A：源码差异冻结

- 逐文件读取 Harness `SettingsRoot`, `GeneralSection`, `AppearanceRow`, `Menu`, `Input`。
- 生成 DOM、CSS、状态、生命周期差异矩阵。
- 扫描 VCPChat 所有 global-settings production call site，确认唯一业务 source of truth。
- 将矩阵写入审计文档；未有证据的项不得标记完成。

### Phase B：Row slot 化

- 将每个设置字段转换为唯一 `vcp-harness-general-row`。
- row 直接装配 `title`, `helper`, `control`，不再把旧 presentation row 当作布局容器。
- 保留原 input/select/textarea 的 `id/name` 和事件监听。
- AppearanceRow 保留单条 hairline，普通 GeneralRow 无贯穿线。
- DisclosureRow 使用明确的 `data-setting-primitive="disclosure"` 和统一展开内容 owner。

当前进度：模板 row 已由同 tag canonical row 替换，旧 row 节点不再进入 live tree；业务控件节点和属性保留，`row-copy` 已承载 title/helper。下一步继续按字段类型细分 GeneralRow/AppearanceRow。

### Phase C：Select/Menu 重构

- 以 Harness Menu 的 `list → viewport → itemWrap → item → itemLabel/check` 为唯一 presentation DOM。
- native select 只作为业务序列化 source，不再承担第二套视觉生命周期。
- portal 的 open/close、outside、Escape、scroll、resize、reposition 由单一 Surface owner 持有。
- 动态 option 更新必须原子替换当前 Menu instance，旧 instance/portal/listener 必须消失。
- 完成 disabled、hover、focus、selected、keyboard navigation 和 12-step operation sequence。

### Phase D：旧实现物理删除

- 删除 global settings bridge 的旧 class 快照恢复和兼容 presentation 分支。
- 删除仅供旧 global settings 使用的 CSS selector、stylesheet 和旧 DOM bootstrap。
- 删除 Classic/Next 选择逻辑对全局设置 Surface 的影响；保留历史 settings schema 兼容归一化，不保留 presentation branch。
- dead-code gate 必须覆盖 CSS、HTML class、bridge symbol、stylesheet import 和运行时 listener owner。

当前进度：旧 `settings-global-modal.css` 已删除，`styles/settings.css` import 与 design-boundary 引用已移除；source nav/content class 在 live mount 时也会移除，DOM snapshot 已记录；teardown 不再恢复旧 DOM。

### Phase E：证据与验收

- DOM tree snapshot：逐层验证 Root/panel/nav/content/header/options/section/row/control。
- computed geometry JSON：逐项验证字体、行高、padding、gap、border、radius、surface、shadow、height、width。
- CSS source equivalence：从 Harness 源码读取契约，禁止手写宽松阈值掩盖差异。
- Electron：light/dark、窄窗口、分类切换、Select 12-step、动态 options、autosave success/failure/retry、close flush、reload restore。
- lifecycle：重复打开/关闭、Escape、外部点击、renderer reload 后无 detached menu、listener、observer、timer。

## 完成标准

只有同时满足以下条件才可以标记完成：

- canonical DOM 不再包裹旧 presentation row；
- Select/Menu/Disclosure 均只有一个 owner 和一套 presentation DOM；
- global settings 旧 stylesheet 无生产消费者并已删除或被 gate 证明不可加载；
- dead-code gate 清零旧 selector、旧 branch、旧 owner 和旧 import；
- DOM、CSS、computed geometry、生命周期和真实 Electron 证据全部通过；
- persisted keys、IPC、自动保存和业务事件语义保持不变。

## 2026-08-23 继续施工记录（projection lifecycle round）

本轮关闭了审查中发现的动态控件回归：

- Select/Choice 的 option projection 现在由实例暴露 `rebuildOptions()`，先清空旧 item/listener，再从 native select 原子重建；native select 仍是唯一业务 source。
- options 数量跨越 `Choice (2–4)` 与 `Select (>4)` 阈值时，bridge 会先 teardown 旧 wrapper、portal 和 listener，再重新分类，避免 stale instance。
- Choice 补齐 roving tabindex、ArrowLeft/Right、ArrowUp/Down、Home、End，并跳过 disabled option。
- 全局 DisclosureRow 收敛为 bridge 唯一 toggle/keyboard owner，补齐 `aria-controls` / `aria-expanded`，删除 event-listeners 中的重复 toggle。
- 文本输入补齐真实 `.vcp-harness-input-wrap`，wrapper 持有 Harness Input 的 border/radius/focus geometry，业务 input/textarea 原节点不复制。
- Appearance preset/density/font grids 改为 Harness 风格的 `auto-fit/minmax(180px, 1fr)`，不再固定三列。
- 测试新增动态 options、重分类、stale wrapper 清理和 Choice roving 键盘断言。

本轮验证：`test-settings-wa.mjs` 8/8 持久化分类 + 动态 projection 通过；Electron Settings Harness gate 8/8 通过（窗口 resize 因 CDP 能力缺失显式 skipped）；source-equivalence、unified-surface、UI System gates 通过。
