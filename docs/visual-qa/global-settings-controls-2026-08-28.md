# Global Settings 高频控件 Visual QA（2026-08-28）

真实 Electron Visual Forensics fixture：
`scripts/visual-qa-next-global-settings-controls.mjs`。

## 结果

| 主题 | Viewport | 结果 |
| --- | --- | --- |
| light | 800×600、1280×800、1680×1000 | pass |
| dark | 800×600、1280×800、1680×1000 | pass |

每个 viewport 均验证：

- Settings modal/content 无水平溢出；
- Input、Select、Range、Toggle、Choice 真实 generated primitive 均可见；
- Select portal 在 viewport 内、位于 overlay 之上且命中测试通过；
- Select hover/focus 状态存在；
- Input focus 时 inner border/box-shadow/outline 不被旧 cascade 覆盖；
- Range 改值后输出更新且 wrapper geometry 稳定；
- Toggle/Choice 改变 canonical native state；
- 滚动后 content geometry 保持有效；
- close → reopen 成功，未出现重复 modal/root。

产物位于 `reports/visual-forensics-qa/global-settings-controls/` 的主题目录中。
该报告证明的是当前真实 Surface 的渲染与交互稳定性，不提升控件为 Harness
`verified-candidate` 或 Stable；同语义 Harness DOM/CSS/pixel 对照、artifact-only
Electron 与 Windows 证据仍是独立晋级条件。
