# Agent Skills

Status: `implemented/working-tree`

## Goal

The Agent tool dialog exposes Codex Skills beside tool policy and actual tool Schema:

```text
[工具开关] [技能] [实际 Schema]
```

The implementation follows the installed-catalog plus per-Agent enablement shape used by Cherry Studio, but uses the pinned Codex App Server `0.146.0` protocol rather than Claude Agent SDK APIs.

## Authority

- Codex App Server owns Skill discovery and parsing through `skills/list`.
- VChat owns Agent Profile and Session Skill policy.
- Main owns absolute Skill paths and the bounded `SKILL.md` preview registry.
- Renderer receives stable Skill IDs, names, descriptions, scope labels and bounded preview content. It never receives absolute Skill paths.
- Profile policy is copied into a new Session snapshot. Updating a Profile does not change existing Sessions.
- Session policy changes are host-only settings and take effect from the next Turn.

## Invocation

Codex `0.146.0` recommends sending both a `$skill-name` text marker and a native Skill input item:

```text
{ type: "skill", name, path }
```

VChat detects explicit `$skill-name` markers in Main. The marker must resolve to exactly one Skill discovered for the Session workspace, the Skill must be enabled by Codex, and its stable ID must be enabled by the Session Skill policy. Main then appends the native Skill input item to `turn/start` or `turn/steer`.

The path is never persisted in the Profile, Session config, transcript or Renderer state.

## Why Global Codex Toggles Are Not Used

`skills/config/write` updates the user's Codex Skill configuration by path. It is not a Thread-scoped whitelist. Applying it while Session A and Session B run concurrently would let one Session change the other Session's available Skills.

VChat therefore uses `skills/list` for discovery and keeps per-Agent/per-Session selection in its existing configuration contracts. Global installation, marketplace search and uninstall are outside this first release.

## UI

- Agent default and current Session scopes use the existing segmented control.
- Search filters by name, display name and description.
- Refresh runs `skills/list(forceReload=true)`.
- Rows show canonical `$name`, description, source scope and an enable switch.
- Selecting a row reads a bounded Main-owned preview of `SKILL.md`.
- A Skill disabled by Codex is visible but cannot be enabled from the Session policy page.

## Verification

- `npm run test:agent-skills`
- `npm run test:agent-settings-ux`
- `npm run test:agent-settings-interaction`
- `npm run test:agent-config-apply`
- `npm run test:agent-workbench-clients`
- `npm run check:ui-system`
- `npm run check:agent-runtime`

Live Electron and real Skill invocation receipts are still required before changing this document to `live`.
