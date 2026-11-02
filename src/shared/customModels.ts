import { MODEL_REGISTRY_PROVIDER_NAMES } from "../generated/providerSpecs";
import type { ProviderName } from "../types";

type ModelRegistryProviderName = (typeof MODEL_REGISTRY_PROVIDER_NAMES)[number];

/**
 * Static-registry providers that accept user-defined model ids. Codex (ChatGPT subscription)
 * only serves its own catalog. Mirrors `ProviderName::supports_custom_model_ids` in cowork-config.
 */
export type CustomModelProviderName = Exclude<ModelRegistryProviderName, "codex-cli">;

const CUSTOM_MODEL_PROVIDER_NAMES: readonly CustomModelProviderName[] =
  MODEL_REGISTRY_PROVIDER_NAMES.filter(
    (provider): provider is CustomModelProviderName => provider !== "codex-cli",
  );

export function resolveCustomModelProviderName(value: unknown): CustomModelProviderName | null {
  if (typeof value !== "string") return null;
  return (CUSTOM_MODEL_PROVIDER_NAMES as readonly string[]).includes(value)
    ? (value as CustomModelProviderName)
    : null;
}

export function supportsCustomModelIds(
  provider: ProviderName,
): provider is CustomModelProviderName {
  return resolveCustomModelProviderName(provider) !== null;
}
