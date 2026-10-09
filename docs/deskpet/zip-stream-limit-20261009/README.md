# Bounded model ZIP extraction

Previously each entry was fully inflated by JSZip async(nodebuffer) before checking the accumulated 300 MiB limit. A compressed file could allocate its entire output even when import eventually failed. JSZip 3.10 pako can also emit a large amount synchronously from a single compressed input block, so using its nodeStream alone does not address this.

The importer still uses JSZip for archive parsing, names and selection. A guarded adapter reads the loaded JSZip 3.10 compressed-entry format. Declared output sizes are checked before extraction; STORE and DEFLATE entries then pass through a Node pipeline with an actual-byte meter before disk writes. Node zlib provides bounded output chunks and backpressure. Overflow destroys the pipeline and removes the partial outfit; mismatched entry sizes also fail. Unsupported future JSZip internal layouts fail closed rather than falling back to whole-entry accumulation. No dependency was added. The compressed archive itself remains loaded in memory, subject to the existing input-size limit; this is an extraction-allocation fix, not a total process memory ceiling.

Validation on the final local tree:
- 225 desktop pet tests passed, including honest oversized content, forged size metadata, exact aggregate limit, STORE, DEFLATE and partial-folder cleanup.
- Chat contracts passed: 66 registered contracts, 862 generated events. Regeneration produced no semantic graph change.
- Separate-process memory probe: a 98,078-byte archive with 96 MiB actual output and forged 32-byte size, using a 1 MiB limit. Old code raised peak RSS by 113,516 KiB before reporting size mismatch; fixed code raised it by 4,748 KiB and reported the configured size limit. Samples are environmental measurements.
- Real Electron settings IPC with isolated AppData: a 391,604-byte archive with 384 MiB output and forged size was rejected at the production 300 MiB limit and left no partial outfit. A normal DEFLATE PNG outfit imported and was selected. Fresh profile scale was 1, actual renderer DPR was 1.5, the image decoded and was placed, and a chosen scale of 1.5 persisted after the state-write queue completed. Seven assertions passed. The supplied screenshot was reviewed after image decode; the first premature capture was discarded.

No live chat data, Core, third-party model or credentials were used or committed. This does not prove mixed-monitor hit testing, OS capture exclusion, real file-dialog operation or all voice workflows. Those remain separate handoff items.
