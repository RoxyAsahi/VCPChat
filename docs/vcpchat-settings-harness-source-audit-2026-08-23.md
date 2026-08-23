# VCPChat 全局设置 Harness 源码级审计（2026-08-23）

## 结论

当前版本已完成统一 SettingsRoot、旧 row/inline/CSS ownership 清理，并通过 source-equivalence 与 Electron 交互门禁。Select 保留 native `select` 作为业务源，presentation DOM 已采用 Harness Menu 的 list/viewport/itemWrap/itemLabel/check 契约；仍需继续补足逐属性源码快照比对。

本轮已完成一个边界明确的施工步骤：运行时将全局设置 modal 组装为唯一的 Harness shell 树，旧业务表单仍保留为数据/事件源，但不再承担 shell 的 live presentation owner。

## Harness 参考契约

| Primitive | Harness 源码 | 关键契约 |
| --- | --- | --- |
| SettingsRoot | `packages/client/ui-settings-general/src/client/SettingsRoot.tsx:61-95` | `overlay/mask/panel`，panel 直系 `nav + content`，content 直系 `header + options` |
| SettingsRoot CSS | `SettingsRoot.module.css:73-216` | panel `800px`、`min(800px, calc(100vh - 48px))`；nav `188px`；header `54px`；options `padding: 0 24px 24px` |
| GeneralSection | `GeneralSection.tsx:14-19` | section 只渲染 feature-owned item slot |
| GeneralSection CSS | `GeneralSection.module.css:4-11` | 只由最后一项收口 hairline，不绘制贯穿式 legacy rail |
| AppearanceRow | `AppearanceRow.tsx:45-61`、`AppearanceRow.module.css:4-57` | row 自持 `padding: 16px 0`、`gap: 8px`、单条 `1px` hairline |
| Menu | `ui-primitives/src/Menu.module.css:6-27,95-116` | menu `r12/pad4/shadow`；item `min-height:40/r10/pad8 10/14/22` |
| Input | `ui-primitives/src/Input.module.css:1-34` | wrap `32px/r8/1px border`；input `14/22` |

## 当前 VCPChat 差异证据

- [main.html](/Users/asahi/Documents/Codex/VCPChat-newarchitecture/main.html:987) 的统一 Surface 已移除旧 `global-settings-layout` 与 legacy row/subsection class；原 inline style 已迁移为受控 `data-vcp-style` 规则。
- [settings-bridge.js](/Users/asahi/Documents/Codex/VCPChat-newarchitecture/modules/ui-system/settings-bridge.js:155) 的 `mountCanonicalSettingsRows` 已改为同 tag canonical row 物理替换旧 row，业务 child controls 原节点移动保留；后续继续拆分 title/helper/control slot。
- [settings-bridge.js](/Users/asahi/Documents/Codex/VCPChat-newarchitecture/modules/ui-system/settings-bridge.js:300) 的 Select 保留 native source，但 projection 已采用 Harness `Menu` 的 `menu → viewport → itemWrap → menuitem → itemLabel/check` 语义与结构；portal identity、动态 option hydrate、detached projection 和 exact-one-visible projection 均由 bridge owner 管理。
- [settings.css](/Users/asahi/Documents/Codex/VCPChat-newarchitecture/styles/ui-system/settings.css:809) 仍有 Web Awesome Select proxy 规则；统一 Surface 不应再让 `wa-select.vcp-ui-select-proxy` 参与全局设置视觉。
- `settings.css` 的 source-equivalence gate 当前报告 legacy rows=0、inlineStyles=0、cssSelectors=0；统一 Surface 不再由旧 wrapper 提供布局 ownership。
- `styles/settings.css` 已移除旧 `settings-global-modal.css` 的加载入口；该旧文件不再进入统一设置 Surface 的 cascade。
- `settings.css` 中旧 `global-settings-nav/content/title`、`settings-nav-list`、`vcp-ui-list*` 与 `vcp-ui-settings-shell` dead selector 已删除；source gate 现已覆盖这些名称。
- Electron gate 现在输出 `screenshots/settings-computed-geometry.json`，覆盖 panel/nav/nav-cell/header/options/general-row/select/menu-item/choice 的 computed geometry，并对可见 Select trigger、Menu r12、Menu item 40px 做断言。
- Electron gate 同时输出 `screenshots/settings-dom-tree.json`；当前 live tree 的 panel/nav/content/header/options 只保留 `vcp-harness-*` primitive，source scaffold marker（`vcp-settings-source-*`）在 mount 时全部移除。
- bridge teardown 已改为只释放 controllers、observers、timers、portal 和 autosave owner，不再恢复旧 settings layout、旧 class 或旧 navigation DOM。
- bridge 不再为全局设置建立 tab/tabpanel 语义或 Classic/Next presentation branch；历史 schema 兼容不参与 Surface ownership。
- 文本输入现在由 `.vcp-harness-input-wrap` 物理承载，wrapper 对齐 Harness `Input.module.css` 的 `32px/r8/focus-within` 契约，native input/textarea 节点及其 `id/name` 保持不变。

## 本轮 bounded 施工

`settings-bridge.js:500` 现在在 live modal 中直接构造：

```text
globalSettingsModal (vcp-harness-settings-root)
└── global-settings-modal-content (vcp-harness-settings-panel)
    ├── global-settings-nav (vcp-harness-settings-nav)
    │   ├── vcp-harness-settings-nav-title
    │   └── vcp-harness-settings-nav-list
    │       └── native button[data-vcp-canonical-nav="true"] × N
    └── global-settings-content (vcp-harness-settings-content)
        ├── vcp-harness-settings-header
        │   └── vcp-harness-settings-actions (autosave status + close)
        └── vcp-harness-settings-options
            └── #globalSettingsForm (业务源)
```

旧 `global-settings-layout`、旧 `<ul>` 和旧 footer 只在 teardown 时用于恢复，不再拥有 live shell 几何。旧 `mountLegacySearch`、`VCPUI.create('List')` 及 settings search 注入已从 bridge 移除。导航由 canonical native button 自己处理 click、Arrow/Home/End；上游 `setupGlobalSettingsNavigation` 已排除 `data-vcp-canonical-nav=true`，避免双事件 owner。

live mount 期间还会移除 `global-settings-modal-content`、`global-settings-nav`、`global-settings-content` 和 `global-settings-title` 这些 legacy presentation class，避免旧 CSS 级联重新取得 ownership；teardown 时按原始 class/DOM 快照恢复。

## 最小迁移顺序

1. **测试契约迁移**：将旧 search/List/classic-next 断言改为 canonical root/panel/nav/header/options、native button、无 search/List 实例。
2. **Row slot 化**：按 GeneralRow/AppearanceRow/DisclosureRow 将旧 row 的 title/helper/control 投影到 canonical slots；旧 wrapper 保留为无布局业务锚点。
3. **CSS ownership gate**：静态扫描统一 Surface 下所有 legacy selector 的布局属性，逐组删除而非继续追加末尾覆盖。
4. **Select/Menu 同构**：将当前 projection 的 menu item、check、portal、position、teardown 与 Harness `Menu` 对照逐项收敛；增加 12 项操作序列和 detached-node 检查。
5. **字段语言清理**：删除重复 subsection heading/helper/placeholder，统一 `14/22` 标题、`12/18` 说明与每行密度。
6. **Electron 证据**：light/dark、700×500、hover/focus/selected/disabled、nav keyboard、Select 操作、autosave failure/retry/reload restore；OS resize 能力缺失时显式标记 skipped。

## 完成门槛

- live DOM 直系结构与上述 SettingsRoot 树一致；
- 一个 persisted key 只有一个 canonical row 和 authoritative control；
- 普通 GeneralRow 无贯穿线，AppearanceRow 只保留单条 hairline；
- 无旧 search/List presentation owner、无 classic/next presentation 分叉；
- legacy wrapper computed style 不拥有布局属性；
- Select/Menu 通过 exact-one projection、portal、12-step 操作和 teardown 检查；
- 静态契约、CSS ownership、UI System 和真实 Electron 证据均通过后，才可宣称“源码级对齐与旧实现清理完成”。

静态门禁命令：

```bash
node scripts/check-settings-source-equivalence.mjs
```

该门禁当前已通过；剩余工作是将 Select 的 portal lifecycle 与 computed geometry 证据扩展到完整操作矩阵。

## 2026-08-23 模板 presentation 清理证据

统一设置模板中的 `settings-form-group` / `form-group-inline` 已迁移为
`vcp-settings-row` / `vcp-settings-control-row`，subsection 标题改为
`data-vcp-settings-section*` markers。原有 116 个 inline `style` 已投影为
`data-vcp-style` canonical selectors；动态 `display` 仍可由业务脚本以内联状态覆盖。

当前 source-equivalence 输出为：

```json
{"legacy":{"rows":0,"inlineStyles":0,"cssSelectors":0},"legacyClean":true}
```

Electron 设置交互（含 IPC 保存/重载、浅色/深色截图）及 UI System/stylelint 门禁均通过。

## 2026-08-23 projection lifecycle 复核

对抗审查指出的动态 option 风险已实际修复并加入回归：

1. `settings-bridge.js` 的每个 Select/Choice instance 都有 `rebuildOptions()`；重建会释放旧 option click listener，并保留 native select 的 selected value。
2. option 数量从短枚举变成长枚举时，`mountHarnessSelects()` 先识别分类变化并调用统一 teardown，再建立新的 Harness Menu projection；旧 Choice wrapper 与 portal 不会残留。
3. Choice 的 roving tabindex 只允许当前项为 `tabindex=0`，方向键、Home/End 跳过 disabled 项并同步业务 select。
4. 外观 preset、density、font 网格采用 `auto-fit/minmax(180px,1fr)`，窄宽度自然换行，取消固定三列造成的错位。
5. 全局表单中的 DisclosureRow 由 settings bridge 绑定唯一 click/keyboard owner，并同步 `role=button`、`aria-controls`、`aria-expanded`；旧 event-listeners 重复 toggle 已移除。

新增证据：`scripts/test-settings-wa.mjs` 动态 options/reclassification/keyboard 断言通过；Electron gate 重新通过 8/8。当前仍明确的证据限制只有 Electron CDP 不支持 `Browser.getWindowForTarget`，因此 OS window resize 记录为 skipped，不伪称已覆盖。
