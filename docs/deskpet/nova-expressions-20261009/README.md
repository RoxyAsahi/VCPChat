# Nova expression integration

Validated against Claude integration branch 77d0e8576 after merging its renderer split. The repository assets were loaded through the actual main IPC, preload and Live2D backend with an independently supplied Core 5.x and isolated AppData. All three outfits remained selectable.

- Desktop pet tests: 222 passed, 0 failed.
- Actual Electron render: 320 assertions passed, no errors; twelve emotions × three poses for each outfit. Poses cover normal, closed-eye talking and head turn.
- Tech and maid: twelve distinct expression parameter signatures each (66 pair comparisons each); minimum maximum-coordinate difference 0.30. Pixel comparisons also distinguish happy/sad, angry/shy, happy/excited and neutral/calm.
- Both models have 25 parameters including independent smile, brow-angle and cheek controls; the integrated model uses ArtMeshCheek for blush. Neutral clears all five new parameters. Closed-eye talking hides both irises and eye whites; geometry is finite.

Run tools/nova/verify_expressions.cjs with Electron and your own NOVA_CUBISM_CORE_PATH, then check_expression_results.py with Python/Pillow. Only the served QA response is instrumented; production renderer code is unchanged by this change. Authoring scripts passed CLI/syntax checks; the original equivalent authoring workflows were rendered separately over 174 poses per model. The packaged authoring CLI has not been replayed end-to-end.

Integrated PR #94 at 66a4659c8, preserving its MOC, CDI, single-page textures, and native smile/brow/cheek binding; retained twelve separate emotion expressions from this branch. Final integration was rerun against the main renderer split: 222 tests and 320 render assertions passed. Archived native sources match tech step10 and maid step7; tech step11 differs in MOC and is archived separately, not installed. Prior independent authoring scripts reproduce the earlier two-page implementation and should not be replayed onto the current work-v3 native projects. Known limits: remaining artwork cleanup and Q model transition/gesture work are not complete. No Core, credentials or chat data are included here. There is no claimed GitHub CI result.
