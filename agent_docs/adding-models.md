# Adding a Supported Model or Provider

Load this file when adding or updating model metadata in the registry, or when adding a provider.

## Rules

- Add a dedicated config file under `config/models/<provider>/` and make that file the source of truth for the model.
- Include, at minimum: canonical `id`, `displayName`, `knowledgeCutoff`, `supportsImageInput`, `promptTemplate`, `providerOptionsDefaults`, and `isDefault` when applicable.
- Import every new model file into `RAW_MODEL_REGISTRY_ENTRIES` in `src/models/registry.ts` (the shared client catalog); `test/models.registry.test.ts` fails when a `config/models` file is not imported. The Rust server reads the directory directly.
- Verify published model metadata against current vendor docs before landing it. If an exact cutoff or capability is not currently published, use an explicit conservative value like `Unknown` instead of guessing.
- Keep prompt/runtime behavior aligned with the registry entry. `supportsImageInput` must match both prompt instructions and runtime/tool payload handling.
- Changing a provider's default model means moving `isDefault: true` and updating that provider's `defaultModel` in `config/providers.json` together; `bun run docs:check` fails when they disagree.
- Update any related pricing/catalog tests and docs when model metadata changes.
- Do not add unsupported/custom model IDs as passthroughs. New models must be added to the registry explicitly before they are selectable.

## Adding a provider

`config/providers.json` is the single source of truth for static provider metadata: id, display name, wire `transport`, `userFacing`, `discovery` (`api` | `static` | `local`), `apiKeyEnvVars`, `inferenceBaseUrl` / `discoveryBaseUrl`, `defaultModel` / `titleModel`, and static `authMethods`. Array order is the canonical provider order everywhere. Rust loads it in `crates/cowork-config/src/provider_specs.rs`; TypeScript consumes the generated `src/generated/providerSpecs.ts` (`PROVIDER_NAMES`, `PROVIDER_SPECS`, `MODEL_REGISTRY_PROVIDER_NAMES`), which feeds `src/types.ts`, `src/providers/catalog.ts`, `src/shared/providerAuthMethods.ts`, `src/shared/customModels.ts`, `src/shared/modelPreferences.ts`, `src/models/registry.ts`, and the desktop's `apps/desktop/src/lib/providerDisplayNames.ts`.

### OpenAI-compatible (Chat Completions) provider

1. Add an entry to `config/providers.json` with `"transport": "chat-completions"` at the position you want in provider order.
2. Add the `ProviderName` variant to `crates/cowork-config/src/providers.rs` in the same position, and append it to `ProviderName::ALL` (ids, serde, and display names come from the JSON; the `provider_specs` tests fail when the enum and JSON disagree).
3. Add `config/models/<provider>/*.json` with exactly one `isDefault: true` model matching `defaultModel` (and a `titleModel` that exists there), and import the files in `src/models/registry.ts`.
4. Optional: the endpoint and API-key env vars come from the JSON entry and every behavioral flag defaults to plain OpenAI Chat Completions; override wire-format quirks (max-tokens field, thinking format, developer role, schema budgets) in `ProviderQuirks::for_provider` in `crates/cowork-providers/src/chat_completions/quirks.rs`, and narrow `/models` discovery results in `should_include_openai_compat_model` (`crates/cowork-providers/src/catalog.rs`) when the endpoint lists non-chat models.
5. Add the id to every provider `enum` in `crates/cowork-protocol/src/ws_jsonrpc_schema.json`, then run `bun run docs:generate-jsonrpc`.
6. Run `bun run providers:generate` to rewrite `src/generated/providerSpecs.ts`.
7. Audit provider-gated branches in `crates/cowork-tools/src/catalog.rs` (`create_builtin_tools`).
8. Verify: `cargo test -p cowork-config -p cowork-providers`, `bun run docs:check` (fails on a stale generated module, schema enum drift, or a `defaultModel` / `isDefault` mismatch), `bun run typecheck`, and `bun run test -- test/models.registry.test.ts`.

### New wire protocol

Everything above, plus:

1. Add the protocol to `ProviderWireProtocol` in `crates/cowork-config/src/provider_specs.rs` and use its kebab-case name as the JSON `transport`.
2. Implement `ProviderTransport` (`crates/cowork-providers/src/transport.rs`) in a new module under `crates/cowork-providers/src/`, using `crates/cowork-providers/src/anthropic_messages.rs` or `crates/cowork-providers/src/google_interactions.rs` as the model, and export it from `crates/cowork-providers/src/lib.rs`.
3. Return it from `select_provider_transport` in `crates/cowork-server/src/turn_runner.rs` (and the matching branch in `crates/cowork-harness/src/skill_improvement.rs`).
4. If the protocol carries provider-specific replay state (signatures, encrypted reasoning, native tool blocks), teach `crates/cowork-inference/src/legacy_messages.rs` to migrate legacy stored messages into it.

## References

- [Astra migration constraints](astra.md#api-migration-requirements) — Responses-only tools, reasoning, sampling, caching, and transport requirements for `gpt-6-astra`; documentation alone does not register the model
- Example entry: `config/models/google/gemini-3.5-flash.json`
- Existing provider dirs: `config/models/` (`anthropic`, `baseten`, `bedrock`, `codex-cli`, `firepass`, `fireworks`, `google`, `minimax`, `nvidia`, `openai`, `opencode-go`, `opencode-zen`, `together`)
- Registry consumers: `crates/cowork-inference/src/registry.rs` (server model registry and pricing) and `src/models/registry.ts` (shared client catalog consumer)
- Provider generator and checks: `packages/harness/src/generate_provider_specs.ts` (`bun run providers:generate`, `bun run providers:check`; also run by `bun run docs:check`)
