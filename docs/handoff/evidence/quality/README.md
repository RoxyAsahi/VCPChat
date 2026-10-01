# 当前修复验证证据

integration 是最终功能链回归；layers 是每层语法/契约/样式/变更测试；layer-full-gates 是每层完整 check:ui-system。runtime 是隔离的真实 Electron Widget 与 Windows packed 终端/原生 PTY 验收，不代表全面整应用验收。所有测试使用隔离状态、测试文本、临时仓库；没有真实模型请求。

full-ui-gate.log 含多个 TAP 集合，JSON 的 tests/pass 仅取最后一个 TAP 集合；status=0 对应完整命令。不可将单个最后集合误报为完整门禁总测试数。

附带的旧审查反例在 ../ 中，仅证明原快照问题，当前结果以本目录为准。
