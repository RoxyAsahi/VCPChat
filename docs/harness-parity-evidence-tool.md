# Harness parity evidence tool

`npm run check:harness-parity-evidence` creates `reports/harness-parity-evidence.json` from the local DeepSeek Harness reference pack.

The report records, for every primitive contract:

- source and stylesheet provenance, including whether the declared Harness files exist;
- the minimum DOM/ARIA and geometry contract shape;
- interaction states from `fixture-matrix.json`;
- explicit evidence gaps and the next candidate whose evidence is still pending.

The command is intentionally report-first: Candidate Lab entries remain gaps and do not become production parity claims. Use `--strict` only when a release gate requires every provenance and interaction gap to be closed.
