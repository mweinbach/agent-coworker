import { create } from "zustand";

import { createAppActions } from "./store.actions";
import { buildCachedDesktopStateSeed } from "./store.actions/bootstrap";
import { loadDesktopStateCacheRaw } from "./localStateCache";
import { DEFAULT_PROVIDER_UI_STATE } from "./providerUiState";
import { createDefaultUpdaterState, type AppStoreDataState, type AppStoreState } from "./store.helpers";

const initialState: AppStoreDataState = {
  ready: false,
  bootstrapPending: false,
  startupError: null,
  view: "chat",

  settingsPage: "providers",
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
  notifications: [],

  providerStatusByName: {},
  providerStatusLastUpdatedAt: null,
  providerStatusRefreshing: false,
  providerCatalog: [],
  providerDefaultModelByProvider: {},
  providerConnected: [],
  providerAuthMethodsByProvider: {},
  providerLastAuthChallenge: null,
  providerLastAuthResult: null,
  providerUiState: DEFAULT_PROVIDER_UI_STATE,

  composerText: "",
  injectContext: false,
  developerMode: false,
  showHiddenFiles: false,
  perWorkspaceSettings: false,
  desktopFeatureFlags: {
    remoteAccess: false,
    workspacePicker: true,
    workspaceLifecycle: true,
  },
  desktopFeatureFlagOverrides: {},
  updateState: createDefaultUpdaterState(),

  onboardingVisible: false,
  onboardingStep: "welcome" as const,
  onboardingState: { status: "pending" as const, completedAt: null, dismissedAt: null },

  sidebarCollapsed: false,
  contextSidebarCollapsed: false,
  contextSidebarWidth: 300,
  messageBarHeight: 96,
  sidebarWidth: 248,
};

const cachedStateSeed = buildCachedDesktopStateSeed(loadDesktopStateCacheRaw());

export const useAppStore = create<AppStoreState>((set, get) => ({
  ...initialState,
  ...cachedStateSeed,
  ...createAppActions((partial) => set(partial as any), get),
}));

export type { AppStoreState } from "./store.helpers";
