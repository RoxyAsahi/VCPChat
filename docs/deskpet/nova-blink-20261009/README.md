# Nova blink repair, 2026-10-09

This is the first continuation of the local Nova handoff. It addresses eye coverage in the tech and maid outfits (D1). The tech source was rebuilt at 1024×1536 using the archived HD PSD; the maid source uses the archived PSD. Q version assets are unchanged.

At EyeOpen=0, the lash retains its curved form sampled at 0.3. Both iris and eyewhite opacity are zero through 0.3 and return to full opacity at 0.5. Iris keys retain all three EyeBallForm values. Front hair/headwear draw order keeps generated eye patches behind the fringe.

Validation uses actual application handlers, outfit menus, the shipped renderer and the privately installed Core 5.1. Before/after screenshots and JSON results are in this directory. For each outfit, all seven expressions were rendered while both eyes were closed and the mouth was open. All four iris/eyewhite drawables had zero opacity. Each outfit passed 14 runtime assertions, with zero rendering errors. Parameters-only checks do not prove artwork quality; the close-up shows the remaining edge artifacts.

Local desk pet tests passed 152/152. Cubism Core and editing archives are excluded from this application commit. Recoverable `.psd2live` and `.cmo3` projects are saved in the local continuation output folder.

Reproduction: with PSD2Live running and its helper directory available, run `python -I tools/nova/fix_blink.py <helper-tools-directory>` on the imported tech or maid project, then save and export with the helper `p2l_save_export.py`. The helper directory supplies `p2l_mcp.py` and `p2l_v2.py`; credentials remain private to the local service.

## Remaining work

This does not close the full handoff. D3 back hair coupling, D4 gaze bounds, D5 mouth shape, D6/D7 edge noise, D8 expressive parameters and the maid chin shadow still need authoring and visual acceptance. Chibi transition/strand issues and the pet interaction/settings work also remain. Do not merge this as a declaration that all three models have passed full acceptance.

The daily application and real chat data were not changed. The original editor was left running; authoring uses a separate process and data directory.
