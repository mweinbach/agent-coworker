import { saveState } from "../../lib/desktopCommands";
import { normalizePersistedProviderState } from "../persistedProviderState";
import type { AppStoreState } from "../store.helpers";
import type { PersistedState } from "../types";

const PERSIST_DEBOUNCE_MS = 300;

let _persistTimer: ReturnType<typeof setTimeout> | null = null;

function buildPersistedState(state: AppStoreState): PersistedState {
  const providerState = normalizePersistedProviderState({
    statusByName: state.providerStatusByName,
    statusLastUpdatedAt: state.providerStatusLastUpdatedAt,
  });

  return {
    version: 2,
    workspaces: state.workspaces,
    threads: state.threads,
    developerMode: state.developerMode,
    showHiddenFiles: state.showHiddenFiles,
    perWorkspaceSettings: state.perWorkspaceSettings,
    ...(providerState ? { providerState } : {}),
    onboarding: state.onboardingState,
  };
}

export function persist(get: () => AppStoreState) {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    const state = buildPersistedState(get());
    void saveState(state);
  }, PERSIST_DEBOUNCE_MS);
}

export async function persistNow(get: () => AppStoreState) {
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
  }
  const state = buildPersistedState(get());
  await saveState(state);
}
