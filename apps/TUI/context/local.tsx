import { createContext, createMemo, useContext, type JSX } from "solid-js";
import { createStore } from "solid-js/store";
import { isUserFacingProviderEnabled, modelChoicesByProvider, userFacingProviders } from "../../../src/providers";
import type { ProviderName } from "../../../src/types";
import { useSyncState } from "./sync";
import type { ProviderCatalogState } from "./syncTypes";

export type ModelChoice = { provider: string; model: string };
export type ProviderChoice = ReturnType<typeof userFacingProviders>[number];

type LocalState = {
  selectedProvider: string;
  selectedModel: string;
};

type LocalContextValue = {
  state: LocalState;
  setSelectedModel: (provider: string, model: string) => void;
  modelChoices: () => ModelChoice[];
  providerNames: () => readonly string[];
};

const LocalContext = createContext<LocalContextValue>();

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

export function LocalProvider(props: { children: JSX.Element }) {
  const syncState = useSyncState();
  const [state, setState] = createStore<LocalState>({
    selectedProvider: "",
    selectedModel: "",
  });

  const modelChoices = createMemo(() => modelChoicesFromSyncState(
    syncState.providerCatalog,
    syncState.providerConnected,
    syncState.provider,
    syncState.model,
  ));

  const providerNames = createMemo(() => {
    return availableProvidersFromCatalogState(syncState.providerCatalog, syncState.providerConnected, syncState.provider);
  });

  const value: LocalContextValue = {
    state,
    setSelectedModel(provider: string, model: string) {
      setState("selectedProvider", provider);
      setState("selectedModel", model);
    },
    modelChoices: () => modelChoices(),
    providerNames: () => providerNames(),
  };

  return (
    <LocalContext.Provider value={value}>
      {props.children}
    </LocalContext.Provider>
  );
}

export function useLocal(): LocalContextValue {
  const ctx = useContext(LocalContext);
  if (!ctx) throw new Error("useLocal must be used within LocalProvider");
  return ctx;
}
