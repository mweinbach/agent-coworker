import { create } from "zustand";

import { createAppActions } from "./store.actions";
import { DEFAULT_PROVIDER_UI_STATE } from "./providerUiState";
import { createDefaultUpdaterState, type AppStoreDataState, type AppStoreState } from "./store.helpers";

const initialState: AppStoreDataState = {
  ready: false,
  startupError: null,
  view: "chat",

  settingsPage: "providers",
  lastNonSettingsView: "chat",

  workspaces: [],
  threads: [],

  selectedWorkspaceId: null,
  selectedThreadId: null,

  workspaceRuntimeById: {},
  threadRuntimeById: {},

  latestTodosByThreadId: {},
  workspaceExplorerById: {},

  promptModal: null,
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
  updateState: createDefaultUpdaterState(),

  onboardingVisible: false,
  onboardingStep: "welcome" as const,
  onboardingState: { status: "pending" as const, completedAt: null, dismissedAt: null },

  sidebarCollapsed: false,
  contextSidebarCollapsed: false,
  contextSidebarWidth: 300,
  messageBarHeight: 120,
  sidebarWidth: 248,
};

export const useAppStore = create<AppStoreState>((set, get) => ({
  ...initialState,
  ...createAppActions((partial) => set(partial as any), get),
}));

export type { AppStoreState } from "./store.helpers";
