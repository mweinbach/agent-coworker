import { createContext, createMemo, useContext, type JSX } from "solid-js";
import { createStore } from "solid-js/store";
import { useSyncState } from "./sync";
import {
  availableProvidersFromCatalogState,
  modelChoicesFromSyncState,
  type ModelChoice,
} from "./localHelpers";

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
