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

- [Astra migration constraints](astra.md#api-migration-requirements) — Responses-only tools, reasoning, sampling, caching, and transport requirements for `gpt-6-astra`; documentation alone does not register the model
- Example entry: `config/models/google/gemini-3.5-flash.json`
- Existing provider dirs: `config/models/` (`anthropic`, `baseten`, `bedrock`, `codex-cli`, `firepass`, `fireworks`, `google`, `minimax`, `nvidia`, `openai`, `opencode-go`, `opencode-zen`, `together`)
- Registry consumers: `crates/cowork-inference/src/registry.rs` (server model registry and pricing) and `src/models/registry.ts` (shared client catalog consumer)
- Provider integrations: `crates/cowork-providers/src/` (wire transports and auth) and `src/providers/catalog.ts` (client provider metadata)
- Adding a provider (not just a model) also triggers `agent_docs/repo-contracts.md` → New provider (audit provider-gated tool branches in `crates/cowork-tools/src/catalog.rs` `create_builtin_tools`, transports in `crates/cowork-providers/src/`, and client catalog entries in `src/providers/catalog.ts`)
