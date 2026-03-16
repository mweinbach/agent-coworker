import type { ProviderName, ServerEvent } from "./wsProtocol";
import { PROVIDER_NAMES } from "./wsProtocol";
import {
  isUserFacingProviderEnabled,
  userFacingAvailableModelsForProvider,
} from "@cowork/providers/catalog";

export const UI_DISABLED_PROVIDERS = new Set<ProviderName>(
  PROVIDER_NAMES.filter((provider) => !isUserFacingProviderEnabled(provider))
);

export const MODEL_CHOICES: Record<ProviderName, readonly string[]> = Object.fromEntries(
  PROVIDER_NAMES.map((provider) => [provider, userFacingAvailableModelsForProvider(provider)])
) as Record<ProviderName, readonly string[]>;

export function modelOptionsForProvider(provider: ProviderName, currentModel?: string | null): readonly string[] {
  const base = MODEL_CHOICES[provider] ?? [];
  const normalized = typeof currentModel === "string" ? currentModel.trim() : "";
  if (!normalized) return base;
  if (base.includes(normalized)) return base;
  return [normalized, ...base];
}

type ProviderCatalogEntry = Extract<ServerEvent, { type: "provider_catalog" }>["all"][number];

export function modelChoicesFromCatalog(
  catalog: readonly ProviderCatalogEntry[],
): Record<ProviderName, readonly string[]> {
  if (catalog.length === 0) return MODEL_CHOICES;
  const result = {} as Record<ProviderName, readonly string[]>;
  for (const entry of catalog) {
    if (UI_DISABLED_PROVIDERS.has(entry.id)) continue;
    const models = Array.isArray(entry.models) ? entry.models.map((m) => m.id) : (MODEL_CHOICES[entry.id] ?? []);
    result[entry.id] = models;
  }
  return result;
}

export function availableProvidersFromCatalog(
  catalog: readonly ProviderCatalogEntry[],
  connected: readonly ProviderName[],
): ProviderName[] {
  const connectedSet = new Set(connected.filter((provider) => !UI_DISABLED_PROVIDERS.has(provider)));
  const catalogProviders = (
    catalog.length === 0
      ? PROVIDER_NAMES
      : catalog.map((entry) => entry.id)
  ).filter((provider) => !UI_DISABLED_PROVIDERS.has(provider));
  if (connectedSet.size === 0) return [...catalogProviders];
  return catalogProviders.filter((provider) => connectedSet.has(provider));
}

export function modelOptionsFromCatalog(
  catalog: readonly ProviderCatalogEntry[],
  provider: ProviderName,
  currentModel?: string | null,
): readonly string[] {
  const choices = modelChoicesFromCatalog(catalog);
  const base = choices[provider] ?? [];
  const normalized = typeof currentModel === "string" ? currentModel.trim() : "";
  if (!normalized) return base;
  if (base.includes(normalized)) return base;
  return [normalized, ...base];
}
