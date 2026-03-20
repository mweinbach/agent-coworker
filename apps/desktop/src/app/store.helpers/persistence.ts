import { saveState } from "../../lib/desktopCommands";
import { saveDesktopStateCache } from "../localStateCache";
import { normalizePersistedProviderUiState } from "../providerUiState";
import { normalizePersistedProviderState } from "../persistedProviderState";
import type { AppStoreState } from "../store.helpers";
import type { CachedDesktopUiState, PersistedState } from "../types";

const PERSIST_DEBOUNCE_MS = 300;
const DESKTOP_CACHE_DEBOUNCE_MS = 120;

let _persistTimer: ReturnType<typeof setTimeout> | null = null;
let _desktopCacheTimer: ReturnType<typeof setTimeout> | null = null;

function buildPersistedState(state: AppStoreState): PersistedState {
  const providerState = normalizePersistedProviderState({
    statusByName: state.providerStatusByName,
    statusLastUpdatedAt: state.providerStatusLastUpdatedAt,
  });
  const providerUiState = normalizePersistedProviderUiState(state.providerUiState);

  return {
    version: 2,
    workspaces: state.workspaces,
    threads: state.threads,
    developerMode: state.developerMode,
    showHiddenFiles: state.showHiddenFiles,
    perWorkspaceSettings: state.perWorkspaceSettings,
    ...(providerState ? { providerState } : {}),
    providerUiState,
    onboarding: state.onboardingState,
  };
}

function buildCachedDesktopUiState(state: AppStoreState): CachedDesktopUiState {
  return {
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedThreadId: state.selectedThreadId,
    view: state.view,
    settingsPage: state.settingsPage,
    lastNonSettingsView: state.lastNonSettingsView,
    sidebarCollapsed: state.sidebarCollapsed,
    sidebarWidth: state.sidebarWidth,
    contextSidebarCollapsed: state.contextSidebarCollapsed,
    contextSidebarWidth: state.contextSidebarWidth,
    messageBarHeight: state.messageBarHeight,
  };
}

function syncDesktopStateCacheState(state: AppStoreState): PersistedState {
  const persistedState = buildPersistedState(state);
  saveDesktopStateCache({
    version: 1,
    persistedState,
    ui: buildCachedDesktopUiState(state),
  });
  return persistedState;
}

export function syncDesktopStateCache(get: () => AppStoreState) {
  if (_desktopCacheTimer) {
    clearTimeout(_desktopCacheTimer);
  }
  _desktopCacheTimer = setTimeout(() => {
    _desktopCacheTimer = null;
    syncDesktopStateCacheState(get());
  }, DESKTOP_CACHE_DEBOUNCE_MS);
}

export function syncDesktopStateCacheNow(get: () => AppStoreState) {
  if (_desktopCacheTimer) {
    clearTimeout(_desktopCacheTimer);
    _desktopCacheTimer = null;
  }
  return syncDesktopStateCacheState(get());
}

export function persist(get: () => AppStoreState) {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    const state = syncDesktopStateCacheNow(get);
    void saveState(state);
  }, PERSIST_DEBOUNCE_MS);
}

export async function persistNow(get: () => AppStoreState) {
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
  }
  const state = syncDesktopStateCacheNow(get);
  await saveState(state);
}
