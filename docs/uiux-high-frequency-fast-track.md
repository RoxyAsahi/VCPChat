# UIUX 高频组件快速接入计划

更新时间：2026-08-28

## 目的

在 DeepSeek Harness 等价工程仍处于迁移期时，优先把已经具备 generated artifact、生命周期和交互证据的高频组件接入真实 VCPChat Surface。组件库展示页只作为 Candidate Lab，不作为生产完成度证明。

## 当前策略

施工顺序固定为：

```text
已有 Candidate
→ 高频、非冻结 consumer
→ 保留 canonical business state / IPC / persisted key
→ 删除该切片直接竞争的旧 listener、projection、CSS
→ Electron journey + reload/reopen/teardown
→ 独立提交
```

本阶段优先级：

1. 主界面 Agent 设置中已有 Input、Toggle、Choice、Range、ColorPair、Select、Button、DisclosureRow 的真实字段。
2. Global Settings 中已有 generated 控件的剩余高频 action 和字段。
3. 侧栏、Account、Notification、Tray 中的普通 Button、Tooltip、Disclosure。
4. 只有在前述切片稳定后，才处理 ModelPicker legacy modal、复杂 Menu、DiffBlock 和其他 bespoke 控件。

## 明确暂缓

- 聊天气泡、消息/思维链/代码块/工具结果、Composer/input 内部布局和流式渲染；
- Plugin Loader、chat manifest、IPC、持久化和动态壁纸；
- 32px Dock/topbar/window controls、侧栏创建/搜索触发器；
- 模型刷新、hot/favorite、legacy modal、复杂编辑器和低频 DiffBlock；
- 没有合法 VCP production consumer 的 AgentPresetSeat/Row、PopupSelect、DisclosureRow parity capture。

## 组件页债务规则

组件展示页允许保留旧控件用于对照，但必须显式标记为 `legacy-showcase`。新代码只能引用 `production-consumer-active` 或经过证据门禁的 Candidate；不得因为展示页通过就把组件晋级 Stable。清理债务只限于当前接入切片直接竞争的旧选择器、监听器、projection、fallback 和无调用方 helper。

## 晋级条件

每个高频切片都要记录：Harness provenance、DOM/ARIA contract、token/geometry、键盘与焦点、owner/dispose、generated artifact、Electron 首次打开/重开/reload/失败路径证据。状态统一使用：

```text
production-consumer-active / visual-equivalence-pending
```

只有完成同语义 Harness/VCP DOM、computed-style、交互和截图证据，并删除直接竞争的 legacy presentation path，才可标记 `verified-candidate`；没有生产 consumer 的 Lab 控件永远不能据此晋级。

## 下一轮执行单元

从 Agent 设置中挑选一个已有 generated primitive 的高频字段组，完成真实 consumer 接线和对应旧债净删除；不扩大到新的字段集合。完成后运行 focused UIUX tests、artifact consistency、Electron journey、chat-kernel guard，并以独立提交交付。
