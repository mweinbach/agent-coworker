import { create } from "zustand";
import { loadDesktopStateCacheRaw } from "./localStateCache";
import { DEFAULT_PROVIDER_UI_STATE } from "./providerUiState";
import { createAppActions } from "./store.actions";
import { buildCachedDesktopStateSeed } from "./store.actions/bootstrap";
import {
  type AppStoreDataState,
  type AppStoreState,
  createDefaultUpdaterState,
} from "./store.helpers";
import { DEFAULT_RESEARCH_SETTINGS, normalizeDesktopSettings } from "./types";

const initialState: AppStoreDataState = {
  ready: false,
  bootstrapPending: false,
  startupError: null,
  view: "chat",

  settingsPage: "models",
  lastNonSettingsView: "chat",

  workspaces: [],
  threads: [],

  selectedWorkspaceId: null,
  selectedThreadId: null,
  pluginManagementWorkspaceId: null,
  pluginManagementMode: "auto",

  workspaceRuntimeById: {},
  threadRuntimeById: {},

  latestTodosByThreadId: {},
  workspaceExplorerById: {},
  workspaceExplorerRefreshById: {},

  promptModal: null,
  filePreview: null,
  canvasActiveTab: "preview",
  canvasShowFormattingBar: true,
  notifications: [],

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

  composerText: "",
  newChatLandingTarget: null,
  injectContext: false,
  developerMode: false,
  showHiddenFiles: false,
  perWorkspaceSettings: false,
  desktopSettings: normalizeDesktopSettings(),
  desktopFeatureFlags: {
    menuBar: true,
    remoteAccess: false,
    workspacePicker: true,
    workspaceLifecycle: true,
    a2ui: false,
    openAiNativeConnectors: false,
    canvas: false,
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
