import { saveState } from "../../lib/desktopCommands";
import { saveDesktopStateCache } from "../localStateCache";
import { normalizePersistedProviderUiState } from "../providerUiState";
import { normalizePersistedProviderState } from "../persistedProviderState";
import type { AppStoreState } from "../store.helpers";
import type { CachedDesktopUiState, PersistedState } from "../types";
import { RUNTIME } from "./runtimeState";

const PERSIST_DEBOUNCE_MS = 300;
const DESKTOP_CACHE_DEBOUNCE_MS = 120;

let _persistTimer: ReturnType<typeof setTimeout> | null = null;
let _desktopCacheTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Filters out draft threads from persistence.
 *
 * Draft threads (thread.draft === true) are ephemeral UI-only threads that
 * exist until the first message is sent. They are NOT persisted to disk,
 * so if the app crashes or closes before the first message, the draft is lost.
 * This is intentional to avoid accumulating empty threads.
 *
 * Note: Draft threads can still be selected in the UI. The draft flag only
 * affects persistence, not runtime behavior.
 */
function buildPersistableThreads(state: AppStoreState) {
  return state.threads.filter((thread) => thread.draft !== true);
}

function buildPersistedState(state: AppStoreState): PersistedState {
  const providerState = normalizePersistedProviderState({
    statusByName: state.providerStatusByName,
    statusLastUpdatedAt: state.providerStatusLastUpdatedAt,
  });
  const providerUiState = normalizePersistedProviderUiState(state.providerUiState);
  const threads = buildPersistableThreads(state);

  return {
    version: 2,
    workspaces: state.workspaces,
    threads,
    developerMode: state.developerMode,
    showHiddenFiles: state.showHiddenFiles,
    perWorkspaceSettings: state.perWorkspaceSettings,
    ...(providerState ? { providerState } : {}),
    providerUiState,
    onboarding: state.onboardingState,
  };
}

function buildCachedDesktopUiState(state: AppStoreState): CachedDesktopUiState {
  const persistedThreadIds = new Set(buildPersistableThreads(state).map((thread) => thread.id));
  const selectedThreadId =
    state.selectedThreadId && persistedThreadIds.has(state.selectedThreadId)
      ? state.selectedThreadId
      : null;

  return {
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedThreadId,
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
    version: 2,
    persistedState,
    ui: buildCachedDesktopUiState(state),
    sessionSnapshots: Object.fromEntries(RUNTIME.sessionSnapshots.entries()),
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
