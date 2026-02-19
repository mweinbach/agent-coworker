import { create } from "zustand";

import { createAppActions } from "./store.actions";
import type { AppStoreDataState, AppStoreState } from "./store.helpers";

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
  workspaceFilesById: {},

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

  composerText: "",
  injectContext: false,
  developerMode: false,

  sidebarCollapsed: false,
  contextSidebarCollapsed: false,
  sidebarWidth: 280,
};

export const useAppStore = create<AppStoreState>((set, get) => ({
  ...initialState,
  ...createAppActions((partial) => set(partial as any), get),
}));

export type { AppStoreState } from "./store.helpers";
