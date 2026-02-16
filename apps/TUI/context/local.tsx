import { createContext, useContext, type JSX, type Accessor } from "solid-js";
import { createStore } from "solid-js/store";
import { modelChoicesByProvider } from "../../../src/providers";
import { PROVIDER_NAMES } from "../../../src/types";
import type { ProviderName } from "../../../src/types";

export type ModelChoice = { provider: ProviderName; model: string };

type LocalState = {
  selectedProvider: string;
  selectedModel: string;
};

type LocalContextValue = {
  state: LocalState;
  setSelectedModel: (provider: string, model: string) => void;
  modelChoices: () => ModelChoice[];
  providerNames: () => readonly ProviderName[];
};

const LocalContext = createContext<LocalContextValue>();

export function LocalProvider(props: { children: JSX.Element }) {
  const [state, setState] = createStore<LocalState>({
    selectedProvider: "",
    selectedModel: "",
  });

  const allChoices = (() => {
    const byProvider = modelChoicesByProvider();
    return PROVIDER_NAMES.flatMap((p) =>
      (byProvider[p] ?? []).map((m) => ({ provider: p, model: m }))
    );
  })();

  const value: LocalContextValue = {
    state,
    setSelectedModel(provider: string, model: string) {
      setState("selectedProvider", provider);
      setState("selectedModel", model);
    },
    modelChoices: () => allChoices,
    providerNames: () => PROVIDER_NAMES,
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
