# Live2D 模型目录（桌宠用）

整理日期：2026-10-08。机器可读版本见 [catalog.json](catalog.json)，里面带每个模型到 12 个情绪键的建议映射。

情绪键：`neutral calm happy excited shy affectionate curious surprised concerned sad tired angry`

渲染栈：Pixi 8 + untitled-pixi-live2d-engine，Cubism Core 锁在 5.x，只认 Cubism 3/4/5 格式（`.model3.json` + `.moc3`）。

## 结论

- **能合法放进仓库的只有 4 个社区模型**，都是 itch.io 上标了 CC 许可的练习模型。它们画风简单，表情很少，也没有动作文件，适合做兜底或测试，不适合做表情演示。
- **表情演示推荐用 Live2D 官方样例 Natori**。它有 6 个按名字命名的表情（Normal、Smile、Blushing、Sad、Angry、Surprised），另有 5 个变体，加上 8 个动作，12 个情绪键都能映射上。它是 Cubism 3.0 格式，任何 5.x Core 都能加载。次选是 Mao（Cubism 5.0，8 个表情加 6 个动作，带魔法特效）。
- 官方样例受《無償提供マテリアルの使用許諾契約》约束，**禁止再分发**（第 4.1.1 条），所以不进仓库，改为用脚本按需下载到本地被 git 忽略的 `local/` 目录。

```bash
node assets/live2d/fetch-official-samples.mjs            # 默认下载 Natori Mao Haru，约 11 MB
node assets/live2d/fetch-official-samples.mjs Natori     # 只下载一个
```

## 一、仓库内的模型（`models/`，共约 7.6 MB，未用 Git LFS）

| 目录 | 模型 / 作者 | 许可 | Cubism | 表情 | 动作 | 说明 |
|---|---|---|---|---|---|---|
| `models/ezri-littlecat/` | Little Cat / [Ezri](https://ezrii.itch.io/live2d-little-cat-model) | [CC BY-ND 4.0](https://creativecommons.org/licenses/by-nd/4.0/) | 3.3 | 无 | 无 | 小猫，带物理和口型，附黑猫、三花、白猫三套贴图。文件原样保留未改动（ND 条款）。必须署名 Ezri 并附页面链接，不得转售。 |
| `models/grot-empress/` | Empress Of Light / [Grot10](https://gratgrot10berg.itch.io/model-live2d-base-v-2) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 3.3 | 8 个（Blush、HeartEyes 和 6 个服装开关） | 无 | 像素风，无物理，无口型。Blush 可映射 shy，HeartEyes 可映射 affectionate 和 excited。 |
| `models/grot-illu/` | Illu / [Grot10](https://gratgrot10berg.itch.io/model-live2d-base-v-1) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 4.0 | 无 | 无 | 像素风，只有眨眼和口型。 |
| `models/garnet/` | Garnet / [Salmon Snake Games](https://salmon-snake.itch.io/garnet-live2d-a-free-model) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | 只有 `.cmo3` 工程文件 | 无 | 无 | 唯一完全无限制的模型，但不能直接运行，要先在 Cubism Editor（免费版即可）里导出 moc3。因为是 CC0，可以给它补上 12 个情绪表情后再导出，作为将来的默认形象底子。 |

每个目录里的 `SOURCE.txt` 记录了来源页面、作者、许可和下载日期，并原文抄录了页面上的使用说明。

许可注意事项：

- Grot10 的两个模型页面标的是 CC BY 4.0，但说明里另有一句「请不要把模型当作你的个人形象使用，学习用途（包括直播）都可以」。CC BY 本身不限制用途，这句话应理解为作者的请求。在桌宠里作为可选模型使用问题不大，但不建议作为 VCPChat 的默认形象。
- Ezri 的小猫页面标的是 CC BY-ND（禁止演绎），说明里却写着「可以修改模型和贴图」。仓库里按更严格的 ND 处理，文件一律不改。
- 署名要求：在桌宠的模型选择界面或关于页写明作者，并附上表中的链接。

## 二、只列链接的模型（Live2D 官方样例，禁止再分发）

许可：[Live2D Free Material License](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html)，另需遵守 Live2D Cubism 样例数据使用条款。

- 一般用户和小规模事业者（最近一年营收不满 1000 万日元，且不受营收 1000 万日元以上的公司实质控制）可以商用或非商用。
- 中大型企业只能用于内部或监修用途。
- 任何人都不得再分发素材文件（第 4.1.1 条），也不得把权利转让或再许可给他人（第 4.1.5 条）。
- 公开作品中需要署名。
- 合作角色（如 Tsumiki Harugasa）只能非商用。初音未来和 Unity-chan 不在免费使用范围内。

下表的模型都在 [Live2D/CubismWebSamples](https://github.com/Live2D/CubismWebSamples/tree/develop/Samples/Resources) 里，可以用上面的脚本下载。

| 模型 | Cubism（moc3 版本） | 大小 | 表情 | 动作 | 建议情绪映射 |
|---|---|---|---|---|---|
| **Natori**（推荐演示） | 3.0（v1） | 3.3 MB | 11：Normal Smile Blushing Sad Angry Surprised exp_01–05 | Idle 3，TapBody 5 | neutral/calm→Normal，happy→Smile，excited→exp_02（露齿笑），shy/affectionate→Blushing，curious→exp_01，surprised→Surprised，concerned→exp_03，sad→Sad，tired→exp_05（闭眼），angry→Angry |
| **Mao** | 5.0（v5） | 4.1 MB | 8：exp_01–08 | Idle 2，TapBody 6（含 3 个魔法特效） | neutral→exp_01，calm/happy→exp_02（眯眼笑），excited→exp_04（星星眼），shy/affectionate→exp_06（脸红），curious/surprised→exp_07，concerned/sad→exp_05，angry→exp_08，tired 无对应 |
| **Haru** | 3.0（v1） | 3.7 MB | 8：F01–F08 | Idle 2，TapBody 4 | neutral/calm→F01，happy→F05，excited→F02，shy/affectionate→F07（害羞），curious/surprised→F06，concerned/tired→F08，sad→F04，angry→F03 |
| Ren | 5.3（v6） | 2.5 MB | 5：exp_01–05 | Idle 1，TapBody 2 | happy→exp_02，tired→exp_03，sad→exp_04，concerned→exp_05。moc3 v6 可能需要比锁定的 5.x 更新的 Core，未实测。 |
| Hiyori | 4.0（v3） | 4.8 MB | 无 | Idle 9，TapBody 1 | 只能靠动作，原型目前用的就是它 |
| Mark | 4.0（v3） | 0.7 MB | 无 | Idle 6 | 无 |
| Rice | 4.0（v3） | 3.1 MB | 无 | Idle 1，TapBody 3 | 无 |
| Wanko | 3.0（v1） | 0.8 MB | 无 | Idle 3，TapBody 2 | 无（小狗） |

官网还有 20 个左右的样例需要从 [样例页](https://www.live2d.com/en/learn/sample/) 手动下载，例如 Kei（motion-sync 口型）、Zundamon（Cubism 5.0，50 多个表情和动作，另需遵守东北ずん子・ずんだもん项目的角色使用规范）、Miara、Epsilon、Hibiki、Chitose、Izumi、Tororo & Hijiki 等。其中 Shizuku、Epsilon、Haru 旧版等是 Cubism 2 格式（`.model.json` + `.moc`），**当前渲染栈加载不了**。要支持 Cubism 2，得额外引入专有的 `live2d.min.js` 运行时，不建议这么做。

## 三、查过但不能用的

- itch.io 上大多数免费模型写明禁止再分发：Goth Mofu、MeowMeow、Kevin、Free Slime、Lucie、Sporty Zombie Cleo、Gemini Tay 等。另有一些页面没写任何许可，例如 Horsewife、Slimegirl、Puppet Gal、Stickbug、Mädel、Eliza，也按禁止处理。
- Booth 和 nizima 的免费模型（如とらいむ工房 A-3 型、うさねこメモリー 系列）普遍禁止二次配布。
- GitHub 上的 live2d-models 合集（Eikanya 等）基本是从游戏里提取的模型，版权不清，一律不收。

## 和 VCPChat 发布的关系

在 Live2D 回复「Expandable Application」条款的问题之前，桌宠按可选模块处理，VCPChat 本体不随包分发任何 Live2D 文件。这个目录和 `models/` 只是素材库，不进上游 PR。
