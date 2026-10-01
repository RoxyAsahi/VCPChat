> 历史审查证据：本目录记录修复前的反例。当前修复验收见 ../REPAIR-REPORT.md、../VERIFICATION.json 和 ../evidence/quality/。这些脚本不是当前通过门禁的回归测试。

# 隔离反例复现

在完整功能链的仓库根目录、有正常依赖安装时运行：

```powershell
node docs/handoff/review-probes/adversarial-probes.mjs .
node docs/handoff/review-probes/additional-probes.mjs .
```

使用测试字符串、JSDOM、模拟 API 和新建 work/probe-* 目录，不读取真实聊天配置或发起真实模型请求。程序输出说明当前行为，不将“反例依旧成立”编码成成功验收。修复后应将断言转为对应回归测试。diff 探针仅运行每侧 3000 行；20000 行只计算理论矩阵大小，不分配该矩阵。结果在 work/adversarial-results.json、work/additional-results.json。

本次结果和原始 52 文件测试汇总附在此目录。IPC 反例仅说明主进程入口没有 sender 检查，不证明远程页面取得了 preload。真机 widget 权限利用没有完成。
