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

`node scripts/check-harness-fixture-evidence.mjs` validates the replayed
Harness-production and VCP generated-artifact AgentPreset Select menu pair:
same semantic fixture id, DOM/geometry inputs, and ROI pixel report. A passing
result is only the open/selected/hover menu ROI at its fixed viewport; it does
not prove a closed trigger, busy trigger, production adoption, or any other
Candidate surface.

`node scripts/check-harness-paired-evidence-boundaries.mjs` consolidates the
paired Select ROI pass, VCP-only Candidate captures, source/consumer blockers,
and the active shared ModelPicker boundary. Its `paired-evidence-scoped` status
is deliberately non-promoting: `pass` remains false until every authorized
paired state and production boundary is closed.

Each listed Candidate capture is now checked against its matching reference
contract and its indispensable interaction/teardown fields. A missing or
truncated report makes the ledger `paired-evidence-incomplete`; passing that
schema only proves the isolated Candidate baseline, never a Harness/VCP pair.
StateDot's four-state, phase, resize, and disposal capture participates in the
same guard; it cannot be silently dropped from the Candidate inventory.

`node scripts/check-harness-candidate-source-provenance.mjs` is a source-drift
guard for Tooltip and HoverCard. It records the current Harness source/style
SHA-256 values and verifies critical source anchors (portal, trigger, copy and
dispose semantics) against the reference contract and replayable Candidate
capture. A pass is provenance evidence only, not a visual or consumer parity
promotion.

StateDot is covered by the same source-drift guard, including its aria-hidden
four-state branch, crisp-edge SVG matrix, eight phase delays, halo/core CSS,
and replayable Candidate fixture.

`check-harness-real-source-diff-boundaries.mjs` consolidates the Tooltip,
HoverCard, and StateDot real-source diff reports. It records semantic fixture
matches separately from parity passes and intentionally keeps its own `pass`
false while structural, geometry, computed-style, pixel, or consumer evidence
remains open.
The ledger includes measured strict ROI results for Tooltip, HoverCard, and
StateDot. A measured result may be non-comparable or non-passing; measurement
does not promote a Candidate to production parity.

Tooltip also has a strict fixed-ROI PNG comparator. It records SHA-256 and
byte equality for the real-source and Candidate tooltip screenshots. Its result
is deliberately separate from structural parity: an exact pixel pass cannot
erase the `main` versus `body` ownership mismatch.

The same decoder can target HoverCard with `VCP_PIXEL_COMPONENT=hover-card`.
Its current 245x245 versus 244x244 ROI mismatch is reported as
`comparable=false`, `exactPixelPass=false`; zero compared pixels is never
treated as a pass when dimensions do not match.

`capture-harness-tooltip-source-fixture.mjs` executes the real Harness
`Tooltip.tsx` through a temporary Vite module in Chromium. Its paired diff with
the VCP Candidate deliberately reports a structural mismatch: Harness keeps
the bubble in the anchor parent's React fragment while VCP appends it to
`body`. The matching semantic role/side and computed-style fields do not erase
that mismatch; pixel comparison remains pending.

The HoverCard source fixture executes its real Harness component with the same
delayed/copy/pointer-grace/disabled/unmount semantic fixture. Its DOM/ARIA and
captured style fields match the Candidate, while anchor-root geometry does not
(`Harness` source root is sized by its inline anchor; the Candidate fixture
exposes a distinct wrapper basis). The report records the strict ROI result
without inferring visual equivalence from matching card box styles.

StateDot now has the same real-source capture lane. Its four states, ARIA,
10px geometry, semantic colors, eight ongoing animation phases, structural SVG
signature, resize, and disposal are compared; the report records the observed
`block` (Harness fixture) versus `inline-block` (Candidate) display difference
and retains the per-state strict pixel result.

StateDot also has a per-state strict decoded-RGB ROI comparator. It records
whether each of `done`, `warning`, `ongoing`, and `error` is dimensionally
comparable and pixel-identical; the current baseline remains a non-passing
visual result when any state differs.

The Pill source fixture now runs the real Harness `Pill.tsx` with native static,
interactive, active, hover, click, and unmount states in the same fixed white
fixture host as the Candidate. Its interaction/lifecycle checks align with the
Candidate, while native-tag and display-style differences remain explicit. A
strict decoded-RGB fixture comparison is now recorded separately; it cannot
erase those DOM/style boundaries or the lack of a production consumer.

Toast now has a fixed same-engine source/Candidate capture for the body portal,
`role=alert`, hidden icon, anchor-center placement, resize remeasurement, and
unmount/dispose boundary. Its computed-style fields and strict decoded-RGB ROI
currently match exactly; that component-scoped result does not promote the
Candidate Lab primitive to production because no VCP Toast consumer is wired.

RiskConfirmation now has a real Harness source capture through its actual
RiskConfirmation, Modal, Button, icon, and CSS-module dependency closure. It
records unacknowledged, acknowledged, disabled, autofocus, dialog ARIA, and
unmount states. This is source-side evidence only: a matching VCP Candidate
capture, computed-style/structural diff, strict pixel comparison, and any
production consumer remain open.

ConnectionBanner now has a real-source capture for hidden, reconnecting, label
update, and unmount. The fixed-layout computed styles align with the Candidate,
while its Candidate-only `role=status` and `aria-live=polite` addition is kept
as an explicit DOM/ARIA non-pass. Its 800×26 strict ROI result is comparable
but non-passing; no connection transport consumer is wired.

OnboardingSurface now has a real-source mounted/unmounted capture with portal,
inert, mask, and stage contracts. Its 800×600 full-surface strict RGB result is
comparable but non-passing; Candidate reopen remains an experimental controller
state, and no first-run production consumer is connected.

Menu now has a real-source same-engine capture for its dense portal, selected,
disabled, danger, and footer rows, focus-opened submenu, outside/Escape close,
and unmount boundary. The paired diff confirms the shared menu role, full row
projection, separator, footer, and interaction sequence. It separately records
Candidate trigger ARIA as a structural delta. A strict decoded RGB ROI result is
now measured but non-comparable: the same-semantic Harness card is 218×287 and
the Candidate card is 218×290. No crop or resize may convert that mismatch into
a pixel pass; a VCP production consumer remains required evidence.

The Tooltip Candidate capture replays the source-contract state matrix in a
standalone Electron Chromium page: delayed hover, immediate focus, bottom-to-top
flip, disabled mid-open suppression, and owner disposal. It records a VCP-only
baseline, not a Harness/VCP comparison; a same-semantic Harness browser capture,
computed-style/DOM diff, pixel diff, and any production consumer remain missing.
The replay also reloads the isolated page after disposal and requires a clean
two-anchor/no-tooltip baseline, so it does not substitute a live browser page
for close/flush evidence.

The HoverCard Candidate replay adds the composite's pointer-grace and copy
contract: delayed portal open, crossing the anchor/card gap without closing,
grace expiry, copy feedback/status, disabled suppression, owner disposal, and
post-dispose reload. Its real-source Harness interaction/lifecycle capture is
now paired, while computed-style/DOM structural closure and any production
consumer remain open.

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
promotion. When no actionable Candidate fixture remains, the report uses
`coverage-scoped-complete` while retaining `pass: false` for its VCP-local and
source-only boundaries; it is never a global parity claim. `--strict` is
reserved for a gate that intentionally requires every contract to have a case.

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
