# Codex App Server fixtures

Current product protocol fixtures are generated from the exact project dependency
`@openai/codex@0.146.0`:

- `codex-app-server/0.146.0/manifest.json`: release identity, npm integrity,
  stable/experimental inventories, and canonical tree hashes.
- `codex-app-server-v0.146.json`: the VChat capability policy consumed by the
  Runtime and tests.

Regenerate with `npm run sync:codex-schema` and verify with
`npm run check:codex-schema`. Update the generated fixture before changing
transport, projection, or GUI protocol assumptions.

`codex-app-server-v0.124.json` is archived comparison data. It is not a current
capability source and must not be imported by production code or tests.
