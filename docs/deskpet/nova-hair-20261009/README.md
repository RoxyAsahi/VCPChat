# Nova back-hair follow repair

This continuation addresses the rigid back-hair motion in tech and maid (D3), on top of the blink repair in PR #69. Long hair previously inherited the full head Z rotation and swung away from the shoulders.

The back-hair physics warp now has an authored AngleZ axis at -30, -15, -8, 0, 8, 15 and 30, crossed with all three existing HairBack sway keys. An opposite arc keeps the top root region pinned while bending the lower hair toward the body. The original physics group and head hierarchy remain intact. The neutral vertex positions are identical to the prior version.

Maid's purple/blue reconstruction remnants in its three native back-hair layers were color-corrected using the archived handoff's fill-color approach. Layer alpha, dimensions, placement and mesh generation were preserved. The moc3 before and after that color correction has the same SHA256; it changes texture only. Fine artwork edge noise and faint interior outline traces remain outside this repair's full acceptance.

## Evidence

Actual application menu/handlers, renderer and privately installed Core 5.1 were used. Before/after JSON records actual Core vertices, not just parameter assignments.

- Across head Z ±8, ±15 and ±30, mean drift of the lower quarter of back-hair vertices is reduced by approximately 55% for tech and 71–74% for maid. `*-metrics.json` defines the sampling and reports both values.
- Mean change of the top fifth of vertices is below 0.0016 model units even at ±30; neutral maximum change is zero.
- Thirteen neutral, head-angle and sway combinations pass per outfit. A 400-frame physical step/sine check has finite vertices, bounded geometry and a moving HairBack output; max coordinate magnitude is 0.738 (tech) and 1.002 (maid).
- Each outfit passes 17 runtime assertions with zero renderer errors. Seven expression/blink/speech regressions pass another 14 assertions per outfit, including invisible closed iris/eyewhite surfaces.
- The general desk-pet suite and contract checks are recorded in the continuation handoff. No IPC changes were made.

These checks do not prove all interpolation or art quality. D4 gaze masks, D5 mouth shape, D6/D7 edge cleanup, D8 expression authoring and maid chin shading still require work. This remains a draft.

## Reproduction and recovery

With the saved blink project open in PSD2Live, run `python -I tools/nova/fix_hair_follow.py <helper-tools-directory>`, then save/export. The helper directory supplies `p2l_mcp.py` and `p2l_v2.py` and reads the local service's private credentials. The helper expects the original HairBack-only axes and refuses to reapply over an already edited warp.

For native maid color correction, use `clean_maid_backhair.py <helper-tools-directory> <extracted-hair-PNG-directory>` with the three original back-hair PNG layers. Original and corrected layers plus editable `.psd2live` / `.cmo3` archives are stored in the local continuation output folder. No Core or credentials are shipped in this PR. Daily application/data remain untouched.
