# 内置 Nova

三套形象共用一个 Agent，通过桌宠「换装」选择，ID 分别为 `builtin:nova-tech`、`builtin:nova-maid`、`builtin:nova-chibi`。仅从应用目录读取。用户模型继续放在自己的 `Agents/<id>/deskpet/`，选择记录仍由现有 `deskpet/state.json` 管理。

每套包含 Cubism `.moc3`、`model3.json`、2048 贴图、物理配置、Idle/Blink/Nod/Shake 动作，以及七套基础参数表情，映射到系统十二个情绪。口型、呼吸、视线和互动使用现有桌宠运行时。Q 版另附十二情绪和状态立绘；这些艺术差分及复杂手势不等同于已绑定的模型动作。

美术来自本次 Nova 制作：科技服全身、修正颈部阴影的女仆全身、清理刘海和眼周残影的简洁 Q 版。源图、拆层 PSD 和动作差分由独立美术包保存，运行资源不包含编辑器工程。初版使用 PSD2Live 自动绑定，适合功能验证；后续可在 Cubism 编辑器里细化闭眼形状、嘴型与肢体动作。

本目录不含 `live2dcubismcore.min.js`。运行时沿用应用数据目录中已配置的 Core 5.x；缺少运行库或显卡不可用时回退到本套立绘。不要把第三方 Core 或示例模型混入本目录。
