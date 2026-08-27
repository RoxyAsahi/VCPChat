# Harness parity evidence tool

`npm run check:harness-parity-evidence` creates `reports/harness-parity-evidence.json` from the local DeepSeek Harness reference pack.

The report records, for every primitive contract:

- source and stylesheet provenance, including whether the declared Harness files exist;
- per-contract `provenancePass` plus aggregate `provenanceComplete` and
  `provenanceGaps` counts;
- the minimum DOM/ARIA and geometry contract shape;
- interaction states from `fixture-matrix.json`;
- explicit evidence gaps and the next candidate whose evidence is still pending.

Contracts marked `sourceKind: vcp-local-contract` are intentional VCP-specific
boundaries rather than missing Harness provenance; Harness-derived consumers
must instead list concrete paths under `provenance.sources`.

`npm run diff:harness-vcp-model-picker` consumes the VCP Candidate capture and
the geometry contract. It remains `pending-harness-capture` until a same-engine
Harness browser report is supplied, and records Candidate contract mismatches
without turning a one-sided check into a parity pass.

`npm run diff:harness-vcp-model-picker-pixels` compares the two PNG captures
with the repository pixel policy and reports missing screenshots, dimension
mismatches, ratios, and mean channel delta.

Before comparing pixels it also checks semantic-fixture alignment from the
paired JSON captures: model/effort option counts, option role, group count, and
search visibility. A mismatch is reported as
`pending-semantic-fixture-alignment`; cropping or resizing images must not turn
different interaction fixtures into a visual-parity pass.

The expected capture shape is pinned in
`model-picker.capture.schema.json`, including the fixed viewport, ARIA links,
computed-style selectors, interaction states, and optional PNG ROI.

Run `npm run check:harness-capture-prerequisites` before browser capture. It
reports missing Harness package aliases or scaffold files without installing
dependencies or mutating the source checkout.

Run `npm run scan:harness-ui-inventory` to rescan exported Harness client
components. The report separates portable primitives, composites, and frozen
domain surfaces, then lists source exports without a reference contract. It
also emits `surfacePatterns`, a package-level summary of source files, export
categories, contract coverage, and remaining gaps.

The source-only lifecycle gates can be replayed directly when their Harness
files are available:

- `node scripts/check-harness-job-list-action-source.mjs` checks ordering,
  open-only ticking, listener cleanup, and Escape focus restoration;
- `node scripts/check-harness-permission-row-source.mjs` checks loading,
  unavailable/read-only projection, menu selection, error alert, and the
  acknowledgement gate.

These checks are read-only evidence. They do not create VCP consumers, alter
business state, or promote Candidate Lab work.

Run `npm run check:harness-geometry-contracts` to compare every reference
geometry selector/property against its declared Harness stylesheet. It is
report-only and preserves mismatches as evidence gaps.

The command is intentionally report-first: Candidate Lab entries remain gaps and do not become production parity claims. Use `--strict` only when a release gate requires every provenance and interaction gap to be closed.
