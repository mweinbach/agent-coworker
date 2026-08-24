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
import { getEffectiveThreadLastEventSeq, RUNTIME } from "./runtimeState";

const PERSIST_DEBOUNCE_MS = 300;
const DESKTOP_CACHE_DEBOUNCE_MS = 120;
const MAX_DEFERRED_PERSIST_RETRIES = 3;

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
  return state.threads
    .filter((thread) => thread.draft !== true && !thread.taskId)
    .map((thread) => ({
      ...thread,
      lastEventSeq: getEffectiveThreadLastEventSeq(state, thread.id),
    }));
}

function buildPersistedState(
  state: AppStoreState,
  options: { includeDraftAttachmentData?: boolean } = {},
): PersistedState {
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
  if (options.includeDraftAttachmentData === false) {
    for (const draft of Object.values(composerDrafts)) {
      draft.attachments = [];
    }
  }

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

function buildCachedDesktopUiState(state: AppStoreState): CachedDesktopUiState {
  const persistedThreadIds = new Set(buildPersistableThreads(state).map((thread) => thread.id));
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
    persistedState: buildPersistedState(state, { includeDraftAttachmentData: false }),
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

function enqueuePersistedState(state: PersistedState): Promise<void> {
  const serialized = JSON.stringify(state);
  const save = async () => {
    if (serialized === _lastPersistedJson) return;
    await saveState(state);
    _lastPersistedJson = serialized;
  };
  const write = _persistWriteTail ? _persistWriteTail.then(save) : save();

  // A failed write must not poison either deduplication or later queued writes.
  const tail = write.catch(() => {});
  _persistWriteTail = tail;
  void tail.then(() => {
    if (_persistWriteTail === tail) {
      _persistWriteTail = null;
    }
  });
  return write;
}

function schedulePersist(get: () => AppStoreState, retryAttempt = 0) {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(
    () => {
      _persistTimer = null;
      const state = syncDesktopStateCacheNow(get);
      void enqueuePersistedState(state).catch(() => {
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
  await enqueuePersistedState(state);
}

export const __internal = {
  buildPersistableThreads,
  resetPersistedStateCache: () => {
    _lastPersistedJson = null;
  },
};
