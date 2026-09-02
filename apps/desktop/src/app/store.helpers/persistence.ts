import { saveState } from "../../lib/desktopCommands";
import { getDesktopWindowMode } from "../../lib/windowMode";
import {
  pruneComposerDrafts,
  resolveActiveComposerDraftKey,
  serializeComposerDrafts,
} from "../composerDrafts";
import { serializeCreationDrafts } from "../creationDrafts";
import { saveDesktopStateCache } from "../localStateCache";
import { normalizePersistedProviderState } from "../persistedProviderState";
import { normalizePersistedProviderUiState } from "../providerUiState";
import type { AppStoreState } from "../store.helpers";
import {
  type CachedDesktopUiState,
  normalizeCloudSyncSettings,
  normalizePrivacyTelemetrySettings,
  type PersistedState,
} from "../types";
import { RUNTIME } from "./runtimeState";

const PERSIST_DEBOUNCE_MS = 300;
const DESKTOP_CACHE_DEBOUNCE_MS = 120;
const MAX_DEFERRED_PERSIST_RETRIES = 3;

let _persistTimer: ReturnType<typeof setTimeout> | null = null;
let _desktopCacheTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingPersistGet: (() => AppStoreState) | null = null;
let _pendingDesktopCacheGet: (() => AppStoreState) | null = null;

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
  return state.threads
    .filter((thread) => thread.draft !== true && !thread.taskId)
    .map((thread) => ({
      ...thread,
      lastEventSeq: Math.max(
        0,
        Math.floor(
          Math.max(thread.lastEventSeq ?? 0, state.threadRuntimeById[thread.id]?.lastEventSeq ?? 0),
        ),
      ),
    }));
}

function buildPersistedState(state: AppStoreState): PersistedState {
  const providerState = normalizePersistedProviderState({
    statusByName: state.providerStatusByName,
    statusLastUpdatedAt: state.providerStatusLastUpdatedAt,
  });
  const providerUiState = normalizePersistedProviderUiState(state.providerUiState);
  const threads = buildPersistableThreads(state);
  const workspaces = state.workspaces.map((workspace) => ({
    ...workspace,
    wsProtocol: "jsonrpc" as const,
  }));
  const prunedDrafts = pruneComposerDrafts(state.composerDraftsByKey ?? {}, {
    validThreadIds: new Set(threads.map((thread) => thread.id)),
    validProjectWorkspaceIds: new Set(
      workspaces
        .filter((workspace) => workspace.workspaceKind !== "oneOffChat")
        .map((workspace) => workspace.id),
    ),
    activeKey: resolveActiveComposerDraftKey(state),
  }).drafts;
  const composerDrafts = serializeComposerDrafts(prunedDrafts);

  return {
    version: 2,
    workspaces,
    threads,
    developerMode: state.developerMode,
    showHiddenFiles: state.showHiddenFiles,
    perWorkspaceSettings: state.perWorkspaceSettings,
    desktopSettings: state.desktopSettings,
    privacyTelemetrySettings: normalizePrivacyTelemetrySettings(state.privacyTelemetrySettings),
    cloudSync: normalizeCloudSyncSettings(state.cloudSync),
    desktopFeatureFlagOverrides: state.desktopFeatureFlagOverrides,
    ...(providerState ? { providerState } : {}),
    providerUiState,
    onboarding: state.onboardingState,
    composerDrafts,
    creationDrafts: serializeCreationDrafts(state),
  };
}

function buildCachedDesktopUiState(
  state: AppStoreState,
  threads: PersistedState["threads"],
): CachedDesktopUiState {
  const persistedThreadIds = new Set(threads.map((thread) => thread.id));
  const selectedThreadId =
    state.selectedThreadId && persistedThreadIds.has(state.selectedThreadId)
      ? state.selectedThreadId
      : null;

  return {
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedThreadId,
    selectedTaskId: state.selectedTaskId,
    view: state.view,
    settingsPage: state.settingsPage,
    lastNonSettingsView: state.lastNonSettingsView,
    sidebarCollapsed: state.sidebarCollapsed,
    sidebarWidth: state.sidebarWidth,
    contextSidebarCollapsed: state.contextSidebarCollapsed,
    contextSidebarWidth: state.contextSidebarWidth,
    canvasSidebarWidth: state.canvasSidebarWidth,
    messageBarHeight: state.messageBarHeight,
    newChatLandingTarget: state.newChatLandingTarget,
  };
}

function syncDesktopStateCacheState(state: AppStoreState): PersistedState {
  const persistedState = buildPersistedState(state);
  if (getDesktopWindowMode() !== "main") {
    return persistedState;
  }
  saveDesktopStateCache({
    version: 2,
    persistedState: {
      ...persistedState,
      composerDrafts: Object.fromEntries(
        Object.entries(persistedState.composerDrafts ?? {}).map(([key, draft]) => [
          key,
          { ...draft, attachments: [] },
        ]),
      ),
    },
    ui: buildCachedDesktopUiState(state, persistedState.threads),
    sessionSnapshots: Object.fromEntries(RUNTIME.sessionSnapshots.entries()),
  });
  return persistedState;
}

export function syncDesktopStateCache(get: () => AppStoreState) {
  if (_desktopCacheTimer) {
    clearTimeout(_desktopCacheTimer);
  }
  _pendingDesktopCacheGet = get;
  _desktopCacheTimer = setTimeout(() => {
    _desktopCacheTimer = null;
    syncDesktopStateCacheState(get());
    _pendingDesktopCacheGet = null;
  }, DESKTOP_CACHE_DEBOUNCE_MS);
}

export function syncDesktopStateCacheNow(get: () => AppStoreState) {
  if (_desktopCacheTimer) {
    clearTimeout(_desktopCacheTimer);
    _desktopCacheTimer = null;
  }
  const state = syncDesktopStateCacheState(get());
  _pendingDesktopCacheGet = null;
  return state;
}

/**
 * Serialized form of the last state successfully saved by the main process. Store updates
 * arrive continuously (control events, provider refreshes, thread deltas) and
 * most leave the persisted projection identical, so without this the debounce
 * re-armed and rewrote the whole state file several times a second while idle.
 * The local UI cache is still refreshed on every flush; only the write is
 * skipped.
 */
let _lastPersistedJson: string | null = null;
let _persistWriteTail: Promise<void> | null = null;
let _pendingPersistedState: PersistedState | null = null;

function enqueuePersistedState(state: PersistedState): Promise<void> {
  _pendingPersistedState = state;
  const serialized = JSON.stringify(state);
  const save = async () => {
    if (serialized !== _lastPersistedJson) {
      await saveState(state);
      _lastPersistedJson = serialized;
    }
    if (_pendingPersistedState === state) _pendingPersistedState = null;
  };
  const write = _persistWriteTail ? _persistWriteTail.catch(() => {}).then(save) : save();

  // A failed write must not poison either deduplication or later queued writes.
  // Retain the real result so close approval can observe failure, not just completion.
  _persistWriteTail = write;
  const clearTail = () => {
    if (_persistWriteTail === write) {
      _persistWriteTail = null;
    }
  };
  void write.then(clearTail, clearTail);
  return write;
}

function schedulePersist(get: () => AppStoreState, retryAttempt = 0) {
  if (_persistTimer) clearTimeout(_persistTimer);
  _pendingPersistGet = get;
  _persistTimer = setTimeout(
    () => {
      _persistTimer = null;
      const state = syncDesktopStateCacheNow(get);
      _pendingPersistGet = null;
      void enqueuePersistedState(state).catch(() => {
        // A newer scheduled or queued projection owns persistence now.
        if (_pendingPersistGet || _pendingPersistedState !== state) return;
        if (retryAttempt < MAX_DEFERRED_PERSIST_RETRIES) {
          schedulePersist(get, retryAttempt + 1);
          return;
        }

        console.error("Unable to save desktop state after multiple attempts.");
      });
    },
    PERSIST_DEBOUNCE_MS * 2 ** retryAttempt,
  );
}

export function persist(get: () => AppStoreState) {
  schedulePersist(get);
}

export async function persistNow(get: () => AppStoreState) {
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
  }
  const state = syncDesktopStateCacheNow(get);
  _pendingPersistGet = null;
  await enqueuePersistedState(state);
}

/** Drain only existing work; an idle/loading store must never become a new save. */
export async function flushPendingDesktopState(): Promise<void> {
  while (true) {
    if (_pendingPersistGet) {
      await persistNow(_pendingPersistGet);
      continue;
    }
    if (_pendingDesktopCacheGet) syncDesktopStateCacheNow(_pendingDesktopCacheGet);
    if (_persistWriteTail) {
      await _persistWriteTail;
      continue;
    }
    if (_pendingPersistedState) {
      await enqueuePersistedState(_pendingPersistedState);
      continue;
    }
    return;
  }
}

export const __internal = {
  buildPersistableThreads,
  resetPersistedStateCache: () => {
    _lastPersistedJson = null;
    if (_persistTimer) clearTimeout(_persistTimer);
    if (_desktopCacheTimer) clearTimeout(_desktopCacheTimer);
    _persistTimer = null;
    _desktopCacheTimer = null;
    _pendingPersistGet = null;
    _pendingDesktopCacheGet = null;
    _pendingPersistedState = null;
  },
};
