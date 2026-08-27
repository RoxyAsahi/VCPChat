# Harness parity evidence tool

`npm run check:harness-parity-evidence` creates `reports/harness-parity-evidence.json` from the local DeepSeek Harness reference pack.

The report records, for every primitive contract:

- source and stylesheet provenance, including whether the declared Harness files exist;
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

The expected capture shape is pinned in
`model-picker.capture.schema.json`, including the fixed viewport, ARIA links,
computed-style selectors, interaction states, and optional PNG ROI.

The command is intentionally report-first: Candidate Lab entries remain gaps and do not become production parity claims. Use `--strict` only when a release gate requires every provenance and interaction gap to be closed.
