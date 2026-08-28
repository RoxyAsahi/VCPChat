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

Those local contracts still contribute to `provenanceGaps`: the count means
"not backed by a Harness source path", not "the declared file is stale". Keep
that distinction explicit when reading the report; do not manufacture a
Harness path for a native VCP contract just to lower the count.

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
checks the same pnpm/Vitest workspace topology used by the capture commands:
the Harness web package's Playwright resolver, the vendored Cordis workspace
source, the Vitest runner, scaffold, and target source. It does not mistake a
missing flat root `node_modules` alias for an unavailable workspace capture,
and never installs dependencies or mutates the source checkout.

Run `npm run scan:harness-ui-inventory` to rescan exported Harness client
components. The report separates portable primitives, composites, and frozen
domain surfaces, then lists source exports without a reference contract. It
also emits `surfacePatterns`, a package-level summary of source files, export
categories, contract coverage, and remaining gaps.

Run `node scripts/check-harness-fixture-coverage.mjs` to compare the registered
DOM contracts with visual cases in `fixture-matrix.json`. Its report separates
literal contract names from declared semantic-fixture aliases, VCP-local
contracts, source-only boundaries, and actionable Candidate fixture gaps.
An alias preserves its named Candidate/pixel boundary; it is not a parity
promotion. `--strict` is reserved for a gate that intentionally requires every
contract to have a case.

The source-only lifecycle gates can be replayed directly when their Harness
files are available:

- `node scripts/check-harness-job-list-action-source.mjs` checks ordering,
  open-only ticking, listener cleanup, and Escape focus restoration;
- `node scripts/check-harness-permission-row-source.mjs` checks loading,
  unavailable/read-only projection, menu selection, error alert, and the
  acknowledgement gate.
- `node scripts/check-harness-produced-files-source.mjs` checks measured chip
  fitting, overflow/open-folder capability gating, and ResizeObserver cleanup
  for the frozen turn-tail reference.

These checks are read-only evidence. They do not create VCP consumers, alter
business state, or promote Candidate Lab work.

Run `npm run check:harness-geometry-contracts` to compare every reference
geometry selector/property against its declared Harness stylesheet. It is
report-only and preserves mismatches as evidence gaps.

The command is intentionally report-first: Candidate Lab entries remain gaps and do not become production parity claims. Use `--strict` only when a release gate requires every provenance and interaction gap to be closed.
