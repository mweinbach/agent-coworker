import { create } from "zustand";
import { onTranscriptDeliveryFailure } from "../lib/desktopCommands";
import { createEmptyCreationDrafts } from "./creationDrafts";
import { loadDesktopStateCacheRaw } from "./localStateCache";
import { DEFAULT_PROVIDER_UI_STATE } from "./providerUiState";
import { createAppActions } from "./store.actions";
import { buildCachedDesktopStateSeed } from "./store.actions/bootstrap";
import {
  type AppStoreDataState,
  type AppStoreState,
  createDefaultUpdaterState,
  pushNotification,
} from "./store.helpers";
import {
  DEFAULT_RESEARCH_SETTINGS,
  type Notification,
  normalizeCloudSyncSettings,
  normalizeDesktopSettings,
  normalizePrivacyTelemetrySettings,
} from "./types";

const initialCreationDrafts = createEmptyCreationDrafts();
const initialState: AppStoreDataState = {
  ready: false,
  bootstrapPhase: "idle",
  startupError: null,
  view: "chat",

  settingsPage: "models",
  lastNonSettingsView: "chat",

  workspaces: [],
  threads: [],

  selectedWorkspaceId: null,
  selectedThreadId: null,
  selectedTaskId: null,
  newTaskWorkspaceId: null,
  newTaskWorkspaceRequestId: 0,
  taskSummariesByWorkspaceId: {},
  tasksById: {},
  taskListLoadingByWorkspaceId: {},
  taskLifecycleRequestByTaskId: {},
  taskError: null,

  workspaceRuntimeById: {},
  threadRuntimeById: {},

  latestTodosByThreadId: {},
  workspaceExplorerById: {},
  workspaceExplorerRefreshById: {},

  interactionsByThread: {},
  lmStudioStartModal: null,
  filePreview: null,
  canvasActiveTab: "preview",
  canvasShowFormattingBar: true,
  isCanvasMaximized: false,
  notifications: [],
  operationsByKey: {},

  providerStatusByName: {},
  providerStatusLastUpdatedAt: null,
  providerStatusRefreshing: false,
  codexAppServerStatus: null,
  codexAppServerChecking: false,
  codexAppServerUpdating: false,
  providerCatalog: [],
  providerDefaultModelByProvider: {},
  providerConnected: [],
  providerAuthMethodsByProvider: {},
  providerLastAuthChallenge: null,
  providerLastAuthResult: null,
  providerUiState: DEFAULT_PROVIDER_UI_STATE,

  composerDraftsByKey: {},
  composerDraftRevisionFloorByKey: {},
  composerAttachmentIngestionCountByKey: {},
  newChatLandingTarget: null,
  ...initialCreationDrafts,
  injectContext: false,
  developerMode: false,
  showHiddenFiles: false,
  perWorkspaceSettings: false,
  desktopSettings: normalizeDesktopSettings(),
  privacyTelemetrySettings: normalizePrivacyTelemetrySettings(),
  cloudSync: normalizeCloudSyncSettings(),
  desktopFeatureFlags: {
    menuBar: true,
    remoteAccess: false,
    workspacePicker: true,
    workspaceLifecycle: true,

    openAiNativeConnectors: false,
    canvas: false,
    tasks: false,
  },
  desktopFeatureFlagOverrides: {},
  updateState: createDefaultUpdaterState(),

  onboardingVisible: false,
  onboardingStep: "welcome" as const,
  onboardingState: { status: "pending" as const, completedAt: null, dismissedAt: null },

  researchTransportWorkspaceId: null,
  researchById: {},
  researchOrder: [],
  selectedResearchId: null,
  researchListLoading: false,
  researchListError: null,
  researchDraftSettings: DEFAULT_RESEARCH_SETTINGS,
  researchSubscribedIds: [],
  researchExportPendingIds: [],

  sidebarCollapsed: false,
  contextSidebarCollapsed: false,
  contextSidebarWidth: 300,
  canvasSidebarWidth: 500,
  messageBarHeight: 96,
  sidebarWidth: 248,
};

const cachedStateSeed = buildCachedDesktopStateSeed(loadDesktopStateCacheRaw());

export const useAppStore = create<AppStoreState>((set, get) => ({
  ...initialState,
  ...cachedStateSeed,
  ...createAppActions((partial) => set(partial as Parameters<typeof set>[0]), get),
}));

export function publishForegroundNotification(
  notification: Pick<Notification, "kind" | "title" | "detail">,
): void {
  useAppStore.setState((state) => ({
    notifications: pushNotification(state.notifications, {
      ...notification,
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      audience: "foreground",
    }),
  }));
}

onTranscriptDeliveryFailure((failure) => {
  const notificationId = `transcript-delivery-${failure.recoveryId ?? failure.batchId ?? failure.reason}`;
  useAppStore.setState((state) => ({
    notifications: pushNotification(
      state.notifications.filter((notification) => notification.id !== notificationId),
      {
        id: notificationId,
        ts: new Date().toISOString(),
        kind: "error",
        title: "Transcript sync needs attention",
        detail: failure.message,
        audience: "background",
      },
    ),
  }));
});

if (typeof process !== "undefined" && process.env.NODE_ENV === "test") {
  type AppStoreSubscribe = typeof useAppStore.subscribe;
  type AppStoreListener = Parameters<AppStoreSubscribe>[0];
  type TestableAppStore = typeof useAppStore & {
    clearAllListeners?: () => void;
  };

  const originalSubscribe: AppStoreSubscribe = useAppStore.subscribe;
  const unsubscribes = new Set<() => void>();

  useAppStore.subscribe = ((listener: AppStoreListener) => {
    const wrappedListener: AppStoreListener = (state, prevState) => {
      try {
        listener(state, prevState);
      } catch (err) {
        if (
          err instanceof ReferenceError &&
          (err.message.includes("window") ||
            err.message.includes("document") ||
            err.message.includes("requestAnimationFrame") ||
            err.message.includes("cancelAnimationFrame"))
        ) {
          return;
        }
        throw err;
      }
    };
    const unsubscribe = originalSubscribe(wrappedListener);
    const wrappedUnsubscribe = () => {
      unsubscribes.delete(wrappedUnsubscribe);
      unsubscribe();
    };
    unsubscribes.add(wrappedUnsubscribe);
    return wrappedUnsubscribe;
  }) as AppStoreSubscribe;

  (useAppStore as TestableAppStore).clearAllListeners = () => {
    for (const unsubscribe of unsubscribes) {
      try {
        unsubscribe();
      } catch {
        // Listener teardown is best effort in isolated jsdom tests.
      }
    }
    unsubscribes.clear();
  };
}

export type { AppStoreState } from "./store.helpers";
