# Nova eye-surface and gaze repair

This continuation addresses D4 in the tech and maid models. The prior iris-to-eyewhite clipping masks already existed and were correct: adding them again was a no-op. Their source white layers still contained old iris outlines and skin-colored rims, so the masks included pixels beyond the visible sclera.

The native white surfaces now keep the connected neutral sclera region, with a soft alpha boundary, and retain row shading while removing old colored/dark iris outlines. Layer dimensions, placement and mesh bindings are preserved; no mesh rebuild is requested. Original alpha coverage retained is 85.8–89.4% in tech and 89.6–95.7% in maid.

The two gaze warps resample original geometry at ±0.65 into the ±1 endpoint keys. Interior ±0.65 keys remain: ordinary movement is unchanged up to that range, and each axis stops traveling beyond it. This is an endpoint limit, not a uniform scaling of all gaze input. Parameter IDs/ranges, neutral geometry, physics and application code remain unchanged. The existing iris masks are retained.

## Evidence

Before/after scans use actual application handlers, renderer and privately installed Core 5.1. EyeBallForm is pinned to zero for the geometry comparisons. Camera magnification and WebGL resolution are increased only in the isolated QA process; shipped rendering is unchanged.

- Each outfit passes 30 runtime assertions with zero errors: 26 neutral/cardinal/corner/interior gaze, head-turn and blink poses, plus menu/mask/state checks.
- Actual iris centroid travel at four cardinal endpoints is approximately 65% of the prior travel for both eyes. Neutral eye vertices are exactly unchanged; tested ±0.35/±0.65 interior vertices differ by at most 1.2e-7 model units.
- Isolated GPU renders compare each eye's white-only surface with white plus iris. In 13 poses per outfit (26 eye/pose pairs), visible blue iris pixels do not occur where white alpha is below 16/255. Blue-pixel classification requires alpha above 32/255; this excludes faint antialiasing pixels and does not prove every possible interpolation or EyeBallForm combination.
- Seven closed-eye/speaking expression regressions pass another 14 assertions per outfit. Each also passes 17 back-hair/physics assertions, including 400 actual step/sine frames with finite, bounded vertices and moving HairBack output.
- The current desk-pet suite passes 152/152; chat contracts pass 66 contracts / 843 events. No IPC or renderer code changed.
- Reopening each saved native project and re-exporting produces identical moc3 and texture SHA256. Replaying the portable author script from the saved hair-repair baseline also produces identical moc3 and texture SHA256.

The integration branch advanced during authoring to `929143477` (stop button, tray state, missed replies, attachments, voice shortcut and edge tuck). That base was merged normally into this continuation without changing Nova assets. On this newer code, desk-pet tests pass 166/166, contracts pass 66/848, and a separate real-Electron compatibility run passes 45 assertions across all three outfits, closed-eye expressions and visible reply bubbles. The original pose/pixel measurements above remain recorded against the pre-sync renderer; the newer run verifies application compatibility, not a repeated pixel scan.

`eyes-before-after.png` contains observational eye crops from the actual page renders. Before/after `vertices.json.gz` files retain the full Core vertex arrays; adjacent result JSON records the SHA256 of uncompressed UTF-8 JSON. Pixel and archive reports define their thresholds and hashes.

This remains a draft. Mouth shapes (D5), maid noise/mouth frame (D6), tech skin/edge rectangles (D7), expression authoring (D8), maid chin shading, Q-model details and broader settings/features handoffs still require work. This repair does not claim a complete art or Live2D acceptance.

## Reproduction

Use the original archived tech/maid PSD and a saved hair-repair PSD2Live project from the prior continuation. Python needs psd-tools, Pillow, NumPy and OpenCV; the helper directory supplies p2l_mcp.py / p2l_v2.py and reads locally configured PSD2Live MCP credentials.

```text
python -I tools/nova/extract_eye_surfaces.py <original PSD> <tech|maid> <original-eye-PNG-directory>
python -I tools/nova/fix_eye_surfaces.py <helper-tools-directory> <original-eye-PNG-directory> <tech|maid> <cleaned-PNG-output-directory>
```

Open the matching hair-repair native project before the second command, then save to a new project and export. The author script validates the canvas and original gaze axes before editing, so it refuses to reapply over an already repaired project. Use original PNG inputs, not previously cleaned layers. Native `.psd2live` / `.cmo3` archives and original/cleaned eye layers are in the local continuation delivery. No Core or credentials are included. The daily application and real chat data were not touched.
