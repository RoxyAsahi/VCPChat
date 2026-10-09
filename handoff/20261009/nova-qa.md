# 交接：Nova Live2D 截图验收（2026-10-09 03:50Z）

验收记录：`/mnt/project-files/deskpet/nova-qa/defects.md`（共 3 轮，每条缺陷都写了服装、参数、截图和严重度）。截图在 `nova-qa/r1/`、`r2/`、`r3/`。

## 现状
- Q 版（chibi）：draft PR #63，`claude/nova-chibi-v2` @ cb31a8b4。已验收通过，可以合进 #34。剩下的都是低：N5（MouthOpenY 0.1～0.25 两张嘴半透明叠在一起，EyeOpen≈0.35 时眼白残留）、N6（内侧头发里有很淡的发丝碎片，领结下方一条淡接缝）、D9（眼珠不跟视线）、D10（身体转角小）、D11（鞋缝）。
- 科技服 / 女仆：还没修，等 Nova 线程出第二个 PR。待修：
  - D1 高：闭眼变成 V 字并露出蓝色虹膜；女仆的眼皮贴片画在刘海上面。`r1/defects/D1-*.png`
  - D3 高：AngleZ ±8～15 时后发整片翘起，女仆露出灰紫色补画区。`r1/defects/D3-anglez-hair.png`
  - D4 中：EyeBallY ±1 时虹膜越出眼白。`D4-*.png`
  - D5 中：科技服张嘴是硬边六边形贴片。`D5-tech-mouth.png`
  - D6 中：女仆眼睛和刘海边缘有锯齿白边，张嘴时有残影框。`D6-*.png`
  - D7 中：科技服下巴有浅色描边，睫毛下带着一块肤色矩形。`D7-tech-face-edge.png`
  - D8 中：表情分不出来；缺 ParamEyeLSmile/RSmile、ParamCheek、ParamBrowLAngle/RAngle 这几个参数。
  - D10 低：身体几乎不动。
- 应用代码 A1 中：deskpet.js 在物理算完之后才叠加闲时、拖动和情绪参数，所以拖动和歪头带不动头发物理。已转给协调线程，还没人认领。

## 新 PR 来了以后要复验的
1. D1、D3～D8 逐条看，同时扫 7 套表情 × 闭眼 / 张嘴 / 转头的组合，确认没有引入新问题，尤其是表情下的口型和眨眼（Q 版在这上面出过 N1、N2）。
2. 物理：阶跃输入和正弦输入下不能爆炸或抖动。
3. 桌宠窗口实拍：闲置、视线、10 种情绪、说话。

## 怎么跑（云端容器）
- harness 和说明：`/mnt/project-files/deskpet/nova-qa/harness/README.md`
- Cubism Core 5.1：`/mnt/project-files/deskpet/vendor/live2dcubismcore.min.js`。只能私下测试，绝不能提交。
- 离屏扫描：把 `qa.html` 放到仓库根目录，Core 放在 `vendor-qa-core/`，在仓库根目录起 `npx http-server -p 8711`，然后跑 `EXTRA=1 node sweep.mjs <out> tech maid chibi`、`node dyn.mjs <out>`，用 `sheet.py`、`eyes.py` 拼图。
- 桌宠实拍：先 `npm ci --ignore-scripts`；Electron 44 的 zip 用 curl 下到 `node_modules/electron/dist`；起 `Xvfb :99`；然后跑 `runall.sh`（内部依次是 qa-fixture.cjs、settings-page 的 ctl.mjs、qa-pet.mjs）。
- 注意：要在物理之前改参数，得用 `internal.getIdSafe(id)`，并包一层 `updateNaturalMovements`。

## 本机 Codex 接手
本机能跑真 Electron 和 Core。checkout 新的 PR 分支后，打开 Nova 桌宠，三套服装分别看眨眼、歪头、说话、10 种情绪，对照 defects.md 截图记录结果。不要改模型资产，那归 Nova 线程。
