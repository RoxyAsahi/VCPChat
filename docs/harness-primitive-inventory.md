# DeepSeek Harness UI 控件复刻清单

> 状态：动态 inventory，2026-08-27 首次建立。
> 真源：`/Users/asahi/Documents/Codex/deepseek-harness/packages/client/`。
> VCP fixture host：主窗口内置 `UI 组件库 → Harness Candidate Lab`。
> 规则：实验室中的实现一律为 `Candidate`；只有真实业务 consumer、legacy presentation 删除和 Electron 证据闭合后才能晋级 `Stable`。

## 成熟度模型

| 等级 | 含义 | 必需证据 |
| --- | --- | --- |
| inventoried | 已定位 Harness source 与生产调用面 | source path、consumer path、分类、状态列表 |
| candidate | 已在组件实验室复刻 | Light DOM/ARIA、tokens/geometry、interaction states、owner/dispose、generated artifact、固定 viewport fixture |
| verified-candidate | Harness/VCP 双页面等价链通过 | DOM structural、computed style/geometry、same-engine pixel、keyboard/focus |
| stable | 已接管 VCP 真实 Surface | canonical business state、Electron journey、legacy deletion、reload/stress、平台证据 |

`Candidate` 可以没有 VCP 生产 consumer，但不得导出为稳定公共业务 API。展示页不能作为生产 consumer 计数。

## Portable primitives

| 控件 | Harness source / production use | VCP 状态 | 批次 |
| --- | --- | --- | --- |
| Button | `ui-primitives/src/Button.tsx`；Settings、Workspace、Question/Approval、Conversation shell | candidate-lab-active | B1 |
| Input | `ui-primitives/src/Input.tsx`；当前仅 atom test/export | candidate-lab-active，source-only truth | B1 |
| Menu | `ui-primitives/src/Menu.tsx`；Agent Preset、Language、Permission、Input Trigger、Workspace | candidate-interaction-active；同语义 label/separator/danger/submenu pixel diff pending | B1 |
| Modal | `ui-primitives/src/Modal.tsx`；Settings、Model editor、Directory/Workspace | candidate-interaction-active；同语义 Harness pixel diff 与 VCP production adoption pending | B1 |
| Tooltip / HoverCard | matching `ui-primitives/src/*.tsx`；Message actions、Goal、Sidebar、Workspace | candidate-interaction-active；同语义 Harness pixel diff 与 VCP production adoption pending | B1 |
| DisclosureRow | `ui-primitives/src/DisclosureRow.tsx`；Reasoning、Context、Tool、Workflow | inventoried | B1 |
| StateDot | `ui-primitives/src/StateDot.tsx`；Chat、Tool、Skill、Job、Subagent、Workspace | inventoried | B1 |
| Toast | `ui-primitives/src/Toast.tsx`；Composer、Model selection | inventoried | B1 |
| RiskConfirmation | `ui-primitives/src/RiskConfirmation.tsx`；Permission、Command selection | inventoried | B1 |
| JsonTree | `ui-primitives/src/JsonTree.tsx`；Trajectory | inventoried | B2 |
| Terminal/Read/Diff/Search/Web Block | matching `ui-primitives/src/*Block.tsx`；Tool details/rows | inventoried | B2 |
| MarkdownText / MessageText / CodeBlock / JsonBlock | `ui-primitives/src/markdown/`；Chat、Tool、Deliverables、Trajectory | inventoried；VCP production integration frozen | B4 |
| BrandWordmark / FishLogo / icons | `ui-primitives/src/` and `src/icons/`；app-wide assets | inventoried | B1 |
| ConnectionBanner / OnboardingSurface / Pill | matching source；当前未确认 production consumer | inventoried-source-only | B3 |

## Interaction patterns and composites

| Pattern | Harness source | Lab states | 批次 |
| --- | --- | --- | --- |
| Agent Preset picker | `ui-agent-preset/src/client/AgentPresetSeat.tsx`, `PresetMenu.tsx`, `AgentPresetRow.tsx` | closed/open/selected/hover/focus/busy-disabled/error | B2 |
| Command / mention popup | `ui-input-trigger/src/client/`, `ui-commands/.../PopupSelectView.tsx` | query/empty/highlight/keyboard/commit/dismiss | B2 |
| Model / permission picker | `ui-model-selection/`, `ui-permission-presets/` | loading/selected/risk/error/dismiss | B2 |
| Settings fields/cards | `ui-settings-plugins/src/client/` | description/invalid/disabled/secret/loading | B2 |
| Model editor | `ui-settings-models/src/client/` | provider/key/list/empty/error/dialog | B3 |
| Directory flow | `ui-directory-picker-native/`, `ui-directory-picker-browse/` | loading/tree/selection/error/cancel | B2 |
| Attachment flow | `ui-attachment/src/` | rail/drop/image/lightbox/error | B3 |
| Tool-call presentation | `ui-tool/src/client/tool/` | queued/running/success/failure/collapsed | B3 |
| Question / plan review | `ui-user-questions/src/client/` | unanswered/selected/review/submitting/error | B3 |
| Workflow run | `ui-workflow-run/src/client/WorkflowRunPanel.tsx` | member states/disclosure/progress/failure | B3 |

## Surface references

AppFrame、Sidebar、Workspace、Settings、Theme、Locale、Goal、Jobs、Skill、Subagent、Deliverables 和 Trajectory 都进入后续 inventory。Conversation/chat nodes、composer internals、markdown/tool-result 可以在实验室复刻，但 VCP 的生产接入继续受聊天与流式冻结边界约束。

## 执行批次

1. **B0 Lab substrate**：generated artifact mount、Candidate registry、fixture route、状态矩阵与截图入口。
2. **B1 Portable controls**：Button、Input、Menu、Modal、Tooltip/HoverCard、Disclosure、StateDot、Toast、RiskConfirmation、icons。
3. **B2 Interaction composites**：Agent Preset、Command/Permission/Model picker、Settings fields、Directory flow。
4. **B3 Structural patterns**：Settings cards、Workspace、Sidebar、Shell、Attachment、Tool details。
5. **B4 Frozen-domain references**：Conversation、markdown/tool-result、workflow/subagent/trajectory。允许实验室复刻，禁止借此改写 VCP chat kernel 或协议。

每个控件必须先登记 Harness source provenance 和 states，再写实现；不得为了填满页面而创建无法追溯的近似控件。
