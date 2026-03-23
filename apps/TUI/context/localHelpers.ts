import { isUserFacingProviderEnabled, modelChoicesByProvider, userFacingProviders } from "../../../src/providers";
import type { ProviderName } from "../../../src/types";
import type { ProviderCatalogState } from "./syncTypes";

export type ModelChoice = { provider: string; model: string };
export type ProviderChoice = ReturnType<typeof userFacingProviders>[number];

function normalizeTrimmedString(value: string): string {
  return value.trim();
}

function connectedProviderSet(providerConnected: readonly string[]): Set<ProviderName> {
  return new Set(
    providerConnected
      .map((provider) => provider as ProviderName)
      .filter((provider): provider is ProviderName => isUserFacingProviderEnabled(provider))
  );
}

function catalogProvidersFromState(catalog: ProviderCatalogState): ProviderChoice[] {
  if (catalog.length === 0) return userFacingProviders();
  return catalog.map((entry) => entry.id).filter((provider) => isUserFacingProviderEnabled(provider));
}

export function availableProvidersFromCatalogState(
  catalog: ProviderCatalogState,
  providerConnected: readonly string[],
  preserveProvider: string,
): ProviderChoice[] {
  const connected = connectedProviderSet(providerConnected);
  const providers = catalogProvidersFromState(catalog);
  const base = connected.size === 0
    ? [...providers]
    : providers.filter((provider) => connected.has(provider));

  const normalizedPreserveProvider = normalizeTrimmedString(preserveProvider);
  if (
    normalizedPreserveProvider
    && isUserFacingProviderEnabled(normalizedPreserveProvider as ProviderName)
    && !base.includes(normalizedPreserveProvider as ProviderName)
  ) {
    base.push(normalizedPreserveProvider as ProviderName);
  }

  return base;
}

export function modelChoicesFromSyncState(
  catalog: ProviderCatalogState,
  providerConnected: readonly string[],
  preserveProvider: string,
  preserveModel: string,
): ModelChoice[] {
  const providers = availableProvidersFromCatalogState(catalog, providerConnected, preserveProvider);
  const fallback = modelChoicesByProvider();
  const normalizedPreserveModel = normalizeTrimmedString(preserveModel);
  const normalizedPreserveProvider = normalizeTrimmedString(preserveProvider) as ProviderName;

  if (catalog.length === 0) {
    const choices = providers.flatMap((provider) =>
      (fallback[provider] ?? []).map((model) => ({ provider, model }))
    );
    if (
      normalizedPreserveProvider
      && normalizedPreserveModel
      && isUserFacingProviderEnabled(normalizedPreserveProvider)
      && providers.includes(normalizedPreserveProvider)
      && !choices.some((entry) => entry.provider === normalizedPreserveProvider && entry.model === normalizedPreserveModel)
    ) {
      choices.push({ provider: normalizedPreserveProvider, model: normalizedPreserveModel });
    }
    return choices;
  }

  const choices = catalog.flatMap((entry) => {
    if (!providers.includes(entry.id)) return [];
    return (entry.models ?? []).map((model) => ({ provider: entry.id, model: model.id }));
  });

  if (
    normalizedPreserveProvider
    && normalizedPreserveModel
    && isUserFacingProviderEnabled(normalizedPreserveProvider)
    && providers.includes(normalizedPreserveProvider)
    && !choices.some((entry) => entry.provider === normalizedPreserveProvider && entry.model === normalizedPreserveModel)
  ) {
    choices.push({ provider: normalizedPreserveProvider, model: normalizedPreserveModel });
  }

  return choices;
}
