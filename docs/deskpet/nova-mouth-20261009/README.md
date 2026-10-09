# Nova tech mouth rounding, 2026-10-09

The tech mouth follows an angular source contour at MouthOpenY≥0.5. This native edit rounds the main aperture and the two lip ribbons, retaining their topology, texture and expression offsets. The crossed ribbon tips stay pinned; a smooth selection transition joins them to the rounded aperture. Only NovaTech.moc3 changes among runtime assets. The original mouth PNG remains 22×17 pixels, so this does not claim to finish mouth texture quality or the other art cleanup tasks.

Actual Core 5.1 verification on application base 2167ee23d:

- Original and final model each pass 107 assertions over 103 poses: 55 opening/form interpolation combinations and 48 head-turn/opening/form combinations. Non-mouth vertices are identical throughout. Closed fill is identical; maximum closed lip float difference is 9.42e-7 model units.
- All 19,982 sampled upper/lower aperture-border points, including corners and quarter/midpoints between vertices, lie inside the corresponding lip triangles. No new triangle winding changes occur above the documented numerical area tolerance (`max(1e-4 * largest baseline triangle area, 1e-13)`). This samples the stated poses; it is not a proof of every possible continuous parameter combination or pixel-alpha appearance.
- Closed-eye speech under seven expressions: 14 assertions. Hair poses plus 400-frame physical input: 17 assertions. Mixed gaze: 53 assertions/49 poses. Eye and back-hair vertex comparisons against the previous repair are included. Three outfits and actual reply bubbles pass 45 Electron assertions.
- Existing desk-pet suite: 180/180; contracts: 66 registered / 851 events. First high-concurrency run hit a remembered-size assertion and then timed out; the controls file passes independently, and the full suite passes at concurrency 2 with Electron finished. The initial failure log is retained. No application code was changed to address that timing-sensitive fixture.

The first unpinned round-aperture candidate passed native diagnostics and screenshot inspection but failed a stronger interpolated winding check. Its measurements, native edit recipe and compressed Core geometry remain in `mouth-accept-arc-initial` and `initial-expanded-acceptance-failure.json`. This is why pinning the crossed tips is part of the final edit. The retained diagnostics also report pre-existing folded/degenerate triangles; a native `safe` result alone is not an aesthetics or whole-model quality verdict.

Saved-project reopen, original author-script replay and the portable author script reproduce these final hashes:

- moc3: `289814bed3adc37a4c338f04e4a1231ef33b7dc11155bcfc3677f4e263d53bc0`
- unchanged texture: `8084144d050f8c7cbf2daff79ba2a03b471c6c5304a7713e9e8711a122cc1e0d`

Reproduce the native edit with `tools/nova/fix_mouth_arcs.py <PSD2Live-helper-directory> tools/nova/tech-mouth-arcs.json <output-directory>` using the isolated editor environment. Open the exact final tech gaze project first. The tool exports and checks baseline moc3 hash `598e8968…` before writing; it refuses an already-edited or different project. The refusal was tested with unchanged author history. It saves a new `.psd2live`, exports the model and checks the final moc3 hash. Credentials and Core are external and never included here.

`result.json` excludes raw point arrays; `geometry.json.gz` holds them with a SHA256 of the decompressed UTF-8 JSON. Comparison PNGs are observational enlargements of actual captures; they are not replacement model textures. Camera/capture placement can vary between frames, so mesh assertions use Core coordinates. Local editable `.psd2live` / `.cmo3` deliverables are in the separately saved Nova mouth-repair output folder.

Maid mouth-frame/chin residue, remaining eye/hair edge art, expression authoring, Q details and the broader settings/features handoff remain outstanding. The running daily app and real history were untouched. No GitHub CI result is claimed.

Large flat numeric arrays are deduplicated losslessly with an array table inside each gzip. The metadata records both encoded and decoded SHA256. Run tools/nova/read_mouth_evidence.py on a result.json to verify and reconstruct the original geometry; deduplication was checked byte-for-byte against the original compact UTF-8 JSON. This does not reduce the recorded pose or object coverage.
