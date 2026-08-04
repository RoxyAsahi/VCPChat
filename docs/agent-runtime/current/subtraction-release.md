# Agent 技术债减法版本

Status: **implemented/working-tree**

本版本不增加 Agent 能力，只收敛产品链路和兼容责任：

```text
Agent Workbench
  -> Codex Host Coordinator
     -> Codex App Server 0.146.0
     -> Projection SQLite schema 12
     -> rust/toolbox-bridge/vcp-toolbox-bridge
```

## 已删除路线

- `archive/agent-runtime/` 中的 Pi/Rust JavaScript Runtime。
- 旧 Rust Agent daemon、Core、Host、CLI、Grok、Shadow Index 和外部 TUI workspace 引用。
- 根 package 中的 `archive:rust:*`、`archive:pi:*` 命令及其独占脚本。
- Rust Agent workflow、Topic takeover/daemon/live probe 和孤儿 Markdown stream Renderer。
- Topic IPC、preload alias、Runtime compatibility adapter 和 Topic-named Workbench UI 文件。

Git 历史是源码恢复的唯一渠道。`docs/agent-runtime/history/` 仅用于审计，不是产品说明或可执行入口。

## 现役 Rust 边界

唯一产品 Rust workspace 是 `rust/toolbox-bridge/`，只包含：

- `vcp-agent-protocol`
- `vcp-agent-vcp`
- `vcp-toolbox-bridge`

构建、Runtime fallback、测试和 Electron packaging 通过 `modules/codex-runtime/toolboxBridgePaths.js` 共享路径权威，不允许各自推导产物位置。

## Projection v12

schema 6-11 在打开时先生成版本备份，再在单个事务中规范化到 schema 12。所有持久 Block 使用 content schema 2 和 `block:{sessionId}:{itemId}:{ordinal}` identity。非法 JSON、identity 冲突或重复 canonical ID 会使迁移整体回滚。

Renderer 只接受 `normalized.schemaVersion === 2` 的 snapshot。历史 `snapshot.history`、reasoning `content.text`、旧 tool identity 和合成 block ID reader 已删除。增量 `patch.schemaVersion = 1` 保持不变；非法 snapshot/patch 必须 fail-closed 并请求完整 Projection reload。

## 治理

`check:codex-governance` 同时执行产品 import reachability、测试合同 allowlist、已删除路线、最小 Rust workspace、current 文档链接和 receipt revision 检查。required file 没有真实消费者时视为错误，不能再由门禁保护孤儿代码。

本状态不等于 `hermetic verified` 或 `product`。只有迁移、Cargo、Node、Electron smoke/recovery 和人工验收对应同一已提交 revision 时才可提升状态。
