# Nova eye-surface and gaze repair

This continuation addresses D4 in the tech and maid models. The prior iris-to-eyewhite clipping masks already existed and were correct: adding them again was a no-op. Their source white layers still contained old iris outlines and skin-colored rims, so the masks included pixels beyond the visible sclera.

The native white surfaces now keep the connected neutral sclera region, with a soft alpha boundary, and retain row shading while removing old colored/dark iris outlines. Layer dimensions, placement and mesh bindings are preserved; no mesh rebuild is requested. Original alpha coverage retained is 85.8–89.4% in tech and 89.6–95.7% in maid.

The two gaze warps now have a complete 5×5 grid at -1, -0.65, 0, 0.65 and 1. All outer grid combinations copy the original geometry at their independently clamped coordinates. Interior ±0.65 keys remain: ordinary movement is unchanged up to that range, and each axis stops traveling beyond it. This is an endpoint limit, not a uniform scaling of all gaze input. Parameter IDs/ranges, neutral geometry, physics and application code remain unchanged. The existing iris masks are retained.

## Evidence

Before/after scans use actual application handlers, renderer and privately installed Core 5.1. EyeBallForm is pinned to zero for the geometry comparisons. Camera magnification and WebGL resolution are increased only in the isolated QA process; shipped rendering is unchanged.

- Each outfit passes 30 runtime assertions with zero errors: 26 neutral/cardinal/corner/interior gaze, head-turn and blink poses, plus menu/mask/state checks.
- Actual iris centroid travel at four cardinal endpoints is approximately 65% of the prior travel for both eyes. Neutral eye vertices are exactly unchanged; tested ±0.35/±0.65 interior vertices differ by at most 1.2e-7 model units.
- Isolated GPU renders compare each eye's white-only surface with white plus iris, then check actual visible color in the full model from the same frame. In 13 poses per outfit (26 eye/pose pairs), isolated blue pixels are within nonzero white alpha, and visibly blue pixels in the full model are within white alpha ≥16/255. Isolated blue classification requires alpha above 32/255, B−R>20 and G−R>10. The report retains one partly covered tech edge sample: white alpha 14, isolated combined alpha 64, full-model RGBA [224,229,231,255]. It is covered by the soft mask and appears gray in the actual model; a strict isolated-alpha16 comparison incorrectly classified it as spill. This does not prove every possible interpolation or EyeBallForm combination.
- Seven closed-eye/speaking expression regressions pass another 14 assertions per outfit. Each also passes 17 back-hair/physics assertions, including 400 actual step/sine frames with finite, bounded vertices and moving HairBack output.
- The current desk-pet suite passes 152/152; chat contracts pass 66 contracts / 843 events. No IPC or renderer code changed.
- Reopening each saved native project and re-exporting produces identical moc3 and texture SHA256. Replaying the portable author script from the saved hair-repair baseline also produces identical moc3 and texture SHA256.

The integration branch advanced during authoring to `929143477` (stop button, tray state, missed replies, attachments, voice shortcut and edge tuck). That base was merged normally into this continuation without changing Nova assets. On this newer code, desk-pet tests pass 166/166, contracts pass 66/848, and a separate real-Electron compatibility run passes 45 assertions across all three outfits, closed-eye expressions and visible reply bubbles. Final post-repair pose, pixel, blink, physics and application runs were refreshed on this code. The original before-pose scan remains against the pre-sync renderer; the mixed-grid baseline explicitly maps the original hair-repair moc3/textures into the newer renderer without changing working-tree assets.

## Mixed-direction correction

The initial authoring version repaired cardinal and corner endpoints but omitted outer/interior cross keys. A 7×7 actual-Core scan exposed excess mixed-direction travel of up to 0.0011815 model units in tech and 0.0019035 in maid. `gaze-initial-mixed-clamp.json` preserves the failure; endpoint assertions alone were insufficient.

The final complete cross grid passes 49 mixed-direction poses per outfit. All 24 exterior pose/reference comparisons per outfit have exactly zero vertex difference from their independently clamped coordinates. The 25 interior combinations per outfit match the original model within 1.2e-7 units. The baseline's neutral/cardinal vertices are also checked against the original Core scan to confirm the read-only protocol mapping loaded the intended original geometry. Compact full vertex evidence and comparison definitions are included. Saved native archives and the author-script replay were regenerated for this final version.

`eyes-before-after.png` contains observational eye crops from the actual page renders. Before/after `vertices.json.gz` files retain the full Core vertex arrays; adjacent result JSON records the SHA256 of uncompressed UTF-8 JSON. Pixel and archive reports define their thresholds and hashes.

This remains a draft. Mouth shapes (D5), maid noise/mouth frame (D6), tech skin/edge rectangles (D7), expression authoring (D8), maid chin shading, Q-model details and broader settings/features handoffs still require work. This repair does not claim a complete art or Live2D acceptance.

## Reproduction

Use the original archived tech/maid PSD and a saved hair-repair PSD2Live project from the prior continuation. Python needs psd-tools, Pillow, NumPy and OpenCV; the helper directory supplies p2l_mcp.py / p2l_v2.py and reads locally configured PSD2Live MCP credentials.

```text
python -I tools/nova/extract_eye_surfaces.py <original PSD> <tech|maid> <original-eye-PNG-directory>
python -I tools/nova/fix_eye_surfaces.py <helper-tools-directory> <original-eye-PNG-directory> <tech|maid> <cleaned-PNG-output-directory>
```

Open the matching hair-repair native project before the second command, then save to a new project and export. The author script validates the canvas and original gaze axes before editing, so it refuses to reapply over an already repaired project. Use original PNG inputs, not previously cleaned layers. Native `.psd2live` / `.cmo3` archives and original/cleaned eye layers are in the local continuation delivery. No Core or credentials are included. The daily application and real chat data were not touched.
