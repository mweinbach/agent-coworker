import { saveState } from "../../lib/desktopCommands";
import type { AppStoreState } from "../store.helpers";
import type { PersistedState } from "../types";

const PERSIST_DEBOUNCE_MS = 300;

let _persistTimer: ReturnType<typeof setTimeout> | null = null;

export function persist(get: () => AppStoreState) {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    const state: PersistedState = {
      version: 2,
      workspaces: get().workspaces,
      threads: get().threads,
      developerMode: get().developerMode,
      showHiddenFiles: get().showHiddenFiles,
    };
    void saveState(state);
  }, PERSIST_DEBOUNCE_MS);
}

export async function persistNow(get: () => AppStoreState) {
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
  }
  const state: PersistedState = {
    version: 2,
    workspaces: get().workspaces,
    threads: get().threads,
    developerMode: get().developerMode,
    showHiddenFiles: get().showHiddenFiles,
  };
  await saveState(state);
}
