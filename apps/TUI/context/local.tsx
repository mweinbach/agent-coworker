import { createContext, createMemo, useContext, type JSX, type Accessor } from "solid-js";
import { createStore } from "solid-js/store";
import { isUserFacingProviderEnabled, modelChoicesByProvider, userFacingProviders } from "../../../src/providers";
import type { ProviderName } from "../../../src/types";
import { useSyncState } from "./sync";

export type ModelChoice = { provider: string; model: string };

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

export function LocalProvider(props: { children: JSX.Element }) {
  const syncState = useSyncState();
  const [state, setState] = createStore<LocalState>({
    selectedProvider: "",
    selectedModel: "",
  });

  const fallbackChoices = (() => {
    const byProvider = modelChoicesByProvider();
    return userFacingProviders().flatMap((p) =>
      (byProvider[p] ?? []).map((m) => ({ provider: p, model: m }))
    );
  })();

  const modelChoices = createMemo(() => {
    if (syncState.providerCatalog.length === 0) return fallbackChoices;
    const connected = new Set(
      syncState.providerConnected.filter((provider): provider is ProviderName => isUserFacingProviderEnabled(provider as ProviderName))
    );
    return syncState.providerCatalog
      .filter((entry) => isUserFacingProviderEnabled(entry.id) && (connected.size === 0 || connected.has(entry.id)))
      .flatMap((entry) => (entry.models ?? []).map((model) => ({ provider: entry.id, model: model.id })));
  });

  const providerNames = createMemo(() => {
    if (syncState.providerCatalog.length === 0) return userFacingProviders() as readonly string[];
    const connected = new Set(
      syncState.providerConnected.filter((provider): provider is ProviderName => isUserFacingProviderEnabled(provider as ProviderName))
    );
    return syncState.providerCatalog
      .map((entry) => entry.id)
      .filter((provider) => isUserFacingProviderEnabled(provider) && (connected.size === 0 || connected.has(provider)));
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
