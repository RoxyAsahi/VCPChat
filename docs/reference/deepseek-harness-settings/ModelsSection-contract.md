Source: `packages/client/ui-settings-models/src/client/ModelsSection.tsx` and
`ModelsSection.module.css`.

The models page is an editor, not a repeated generic form card:

- provider rows own their draft and apply action;
- API key is write-only and never read back into the UI state;
- custom fields are behind a disclosure;
- enum fields use the shared `input/selectInput` primitive;
- model rows use a quiet add/remove action;
- errors are local to the editor and recover through retry/apply;
- the provider id remains the stable persisted key.

VCPChat should use this as the contract for model/summary settings rather than
creating another settings-specific store or card hierarchy.
