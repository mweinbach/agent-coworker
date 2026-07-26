# Adding a Supported Model

Load this file when adding or updating model metadata in the registry.

## Rules

- Add a dedicated config file under `config/models/<provider>/` and make that file the source of truth for the model.
- Include, at minimum: canonical `id`, `displayName`, `knowledgeCutoff`, `supportsImageInput`, `promptTemplate`, `providerOptionsDefaults`, and `isDefault` when applicable.
- Verify published model metadata against current vendor docs before landing it. If an exact cutoff or capability is not currently published, use an explicit conservative value like `Unknown` instead of guessing.
- Keep prompt/runtime behavior aligned with the registry entry. `supportsImageInput` must match both prompt instructions and runtime/tool payload handling.
- Update any related pricing/catalog tests and docs when model metadata changes.
- Do not add unsupported/custom model IDs as passthroughs. New models must be added to the registry explicitly before they are selectable.

## References

- Example entry: `config/models/google/gemini-3.5-flash.json`
- Existing provider dirs: `config/models/` (`anthropic`, `antigravity`, `baseten`, `bedrock`, `codex-cli`, `firepass`, `fireworks`, `google`, `minimax`, `nvidia`, …)
- Registry consumer: `src/models/registry.ts`, metadata types in `src/models/metadataTypes.ts`
- Provider integrations: `src/providers/`
- Adding a provider (not just a model) also triggers `repo-contracts.md` → New provider (audit provider-gated tool factories + `createTools` regression)
