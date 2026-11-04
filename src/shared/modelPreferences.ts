import { MODEL_REGISTRY_PROVIDER_NAMES } from "../generated/providerSpecs";
import type { ProviderName } from "../types";

/**
 * Every provider with a static model registry (all but local-discovery providers such as
 * LM Studio), mirroring `ProviderName::supports_model_preferences` in cowork-config.
 */
const MODEL_PREFERENCE_PROVIDER_NAMES = MODEL_REGISTRY_PROVIDER_NAMES;

export type ModelPreferenceProviderName = (typeof MODEL_PREFERENCE_PROVIDER_NAMES)[number];

export function resolveModelPreferenceProviderName(
  value: unknown,
): ModelPreferenceProviderName | null {
  if (typeof value !== "string") return null;
  return (MODEL_PREFERENCE_PROVIDER_NAMES as readonly string[]).includes(value)
    ? (value as ModelPreferenceProviderName)
    : null;
}

export function supportsModelPreferences(
  provider: ProviderName,
): provider is ModelPreferenceProviderName {
  return resolveModelPreferenceProviderName(provider) !== null;
}
