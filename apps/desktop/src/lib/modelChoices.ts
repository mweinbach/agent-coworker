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
export type CatalogVisibilityOptions = {
  hiddenProviders?: readonly ProviderName[];
  hiddenModelsByProvider?: Partial<Record<ProviderName, readonly string[]>>;
};

function filterModelsForProvider(
  provider: ProviderName,
  models: readonly string[],
  options?: CatalogVisibilityOptions,
): readonly string[] {
  if (options?.hiddenProviders?.includes(provider)) {
    return [];
  }
  const hiddenModels = new Set((options?.hiddenModelsByProvider?.[provider] ?? []).map((entry) => entry.trim()).filter(Boolean));
  if (hiddenModels.size === 0) return models;
  return models.filter((model) => !hiddenModels.has(model));
}

export function modelChoicesFromCatalog(
  catalog: readonly ProviderCatalogEntry[],
  options?: CatalogVisibilityOptions,
): Record<ProviderName, readonly string[]> {
  if (catalog.length === 0) {
    return Object.fromEntries(
      PROVIDER_NAMES
        .filter((provider) => !UI_DISABLED_PROVIDERS.has(provider))
        .map((provider) => [provider, filterModelsForProvider(provider, MODEL_CHOICES[provider] ?? [], options)]),
    ) as Record<ProviderName, readonly string[]>;
  }
  const result = {} as Record<ProviderName, readonly string[]>;
  for (const entry of catalog) {
    if (UI_DISABLED_PROVIDERS.has(entry.id)) continue;
    const models = Array.isArray(entry.models) ? entry.models.map((m) => m.id) : (MODEL_CHOICES[entry.id] ?? []);
    result[entry.id] = filterModelsForProvider(entry.id, models, options);
  }
  return result;
}

export function availableProvidersFromCatalog(
  catalog: readonly ProviderCatalogEntry[],
  connected: readonly ProviderName[],
  preserveProvider?: ProviderName,
  options?: CatalogVisibilityOptions & {
    visibleModelsByProvider?: Partial<Record<ProviderName, readonly string[]>>;
  },
): ProviderName[] {
  const connectedSet = new Set(connected.filter((provider) => !UI_DISABLED_PROVIDERS.has(provider)));
  const hiddenProviders = new Set(options?.hiddenProviders ?? []);
  const catalogProviders = (
    catalog.length === 0
      ? PROVIDER_NAMES
      : catalog.map((entry) => entry.id)
  ).filter((provider) => !UI_DISABLED_PROVIDERS.has(provider) && !hiddenProviders.has(provider));
  const providers =
    connectedSet.size === 0
      ? [...catalogProviders]
      : catalogProviders.filter((provider) => connectedSet.has(provider));
  const filteredProviders = options?.visibleModelsByProvider
    ? providers.filter((provider) => (options.visibleModelsByProvider?.[provider]?.length ?? 0) > 0)
    : providers;
  if (
    preserveProvider &&
    PROVIDER_NAMES.includes(preserveProvider) &&
    !filteredProviders.includes(preserveProvider)
  ) {
    filteredProviders.push(preserveProvider);
  }
  return filteredProviders;
}

export function modelOptionsFromCatalog(
  catalog: readonly ProviderCatalogEntry[],
  provider: ProviderName,
  currentModel?: string | null,
  options?: CatalogVisibilityOptions,
): readonly string[] {
  const choices = modelChoicesFromCatalog(catalog, options);
  const base = choices[provider] ?? [];
  const normalized = typeof currentModel === "string" ? currentModel.trim() : "";
  if (!normalized) return base;
  if (base.includes(normalized)) return base;
  return [normalized, ...base];
}
