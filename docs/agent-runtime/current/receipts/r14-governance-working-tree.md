# R14 governance receipt

Status: **implemented / working-tree**

Date: 2026-08-04

Functional revisions:

- `b275deec` Store slice reducers and route table.
- `c4334ee6` Agent config descriptors.
- `f53a36b0` Workbench Host Adapter.
- `7f91d97d` legacy Topic compatibility removal.
- `30328b9f` Runtime capability contexts.
- `2ae2bdb4` R14 governance gates.

Passing evidence:

```text
npm run lint:agent
npm run check:codex-governance
npm run check:agent-runtime
npm run test:agent-workbench-store
npm run test:agent-workbench
npm run test:agent-config-descriptors
npm run test:agent-config-apply
npm run test:agent-settings-ux
npm run test:agent-settings-interaction
npm run test:runtime-service-contexts
npm run test:agent-workbench-host-adapter
npm run test:codex-runtime-manager
```

`npm run test:codex-native` passed its Runtime/service/projection subtests, then the chained Electron smoke ended with a Puppeteer `Runtime.callFunctionOn` timeout after 226.5 seconds. This receipt therefore does not claim Electron or product verification.

Deferred from R14:

- cohesive medium file consolidation;
- lowering the global Agent complexity ceiling below 30 after remaining Settings/projection conversion hotspots are extracted;
- successful Electron smoke/recovery rerun and manual multi-resolution validation.

Codex remains pinned to 0.146.0. Projection SQLite schema, VCPToolBox, ToolBox settings, Rust bridge and main-chat Renderer were not changed.
