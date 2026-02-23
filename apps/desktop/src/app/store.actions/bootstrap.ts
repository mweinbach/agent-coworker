import { defaultModelForProvider } from "@cowork/providers/catalog";
import { z } from "zod";

import {
  deleteTranscript,
  listDirectory,
  loadState,
  pickWorkspaceDirectory,
  readTranscript,
  stopWorkspaceServer,
  openPath,
  revealPath,
  copyPath,
  createDirectory,
  renamePath,
  trashPath,
} from "../../lib/desktopCommands";
import type { ProviderName } from "../../lib/wsProtocol";

import {
  type AppStoreActions,
  type StoreGet,
  type StoreSet,
  RUNTIME,
  appendThreadTranscript,
  basename,
  buildContextPreamble,
  ensureControlSocket,
  ensureServerRunning,
  ensureThreadRuntime,
  ensureThreadSocket,
  ensureWorkspaceRuntime,
  isProviderName,
  makeId,
  mapTranscriptToFeed,
  normalizeProviderChoice,
  nowIso,
  persistNow,
  providerAuthMethodsFor,
  pushNotification,
  queuePendingThreadMessage,
  sendControl,
  sendThread,
  sendUserMessageToThread,
  normalizeThreadTitleSource,
  truncateTitle,
} from "../store.helpers";
import type { ThreadRecord, WorkspaceRecord } from "../types";

const optionalStringWithContentSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? value : undefined),
  z.string().optional()
);

const normalizedProviderSchema = z.preprocess(
  (value) => (isProviderName(value) ? value : "google"),
  z.custom<ProviderName>((value): value is ProviderName => isProviderName(value))
);

const normalizedThreadStatusSchema = z.preprocess(
  (value) => (value === "active" || value === "disconnected" ? value : "disconnected"),
  z.enum(["active", "disconnected"])
);

const normalizedSessionIdSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? value : null),
  z.string().nullable()
);

const normalizedLastEventSeqSchema = z.preprocess(
  (value) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0),
  z.number().int().nonnegative()
);

const persistedWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  createdAt: z.string(),
  lastOpenedAt: z.string(),
  defaultProvider: normalizedProviderSchema,
  defaultModel: optionalStringWithContentSchema,
  defaultSubAgentModel: optionalStringWithContentSchema,
  defaultEnableMcp: z.preprocess((value) => (typeof value === "boolean" ? value : true), z.boolean()),
  yolo: z.preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean()),
}).passthrough().transform((workspace): WorkspaceRecord => {
  const model = workspace.defaultModel ?? defaultModelForProvider(workspace.defaultProvider);
  return {
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    createdAt: workspace.createdAt,
    lastOpenedAt: workspace.lastOpenedAt,
    defaultProvider: workspace.defaultProvider,
    defaultModel: model,
    defaultSubAgentModel: workspace.defaultSubAgentModel ?? model,
    defaultEnableMcp: workspace.defaultEnableMcp,
    yolo: workspace.yolo,
  };
});

const persistedThreadSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  titleSource: z.unknown().optional(),
  createdAt: z.string(),
  lastMessageAt: z.string(),
  status: normalizedThreadStatusSchema,
  sessionId: normalizedSessionIdSchema,
  lastEventSeq: normalizedLastEventSeqSchema,
}).passthrough().transform((thread): ThreadRecord => ({
  id: thread.id,
  workspaceId: thread.workspaceId,
  title: thread.title,
  titleSource: normalizeThreadTitleSource(thread.titleSource, thread.title),
  createdAt: thread.createdAt,
  lastMessageAt: thread.lastMessageAt,
  status: thread.status,
  sessionId: thread.sessionId,
  lastEventSeq: thread.lastEventSeq,
}));

const persistedStateSchema = z.object({
  workspaces: z.preprocess((value) => value ?? [], z.array(persistedWorkspaceSchema)),
  threads: z.preprocess((value) => value ?? [], z.array(persistedThreadSchema)),
  developerMode: z.preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean()),
  showHiddenFiles: z.preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean()),
}).passthrough().transform((state) => {
  const selectedWorkspaceId = state.workspaces[0]?.id ?? null;
  const selectedThreadId =
    selectedWorkspaceId
      ? state.threads.find((thread) => thread.workspaceId === selectedWorkspaceId && thread.status === "active")?.id ?? null
      : null;
  return {
    workspaces: state.workspaces,
    threads: state.threads,
    selectedWorkspaceId,
    selectedThreadId,
    developerMode: state.developerMode,
    showHiddenFiles: state.showHiddenFiles,
  };
});

export function createBootstrapActions(set: StoreSet, get: StoreGet): Pick<AppStoreActions, "init" | "openSettings" | "closeSettings" | "setSettingsPage" | "setDeveloperMode" | "setShowHiddenFiles" | "toggleSidebar" | "toggleContextSidebar" | "setSidebarWidth" | "setContextSidebarWidth" | "setMessageBarHeight"> {
  return {
    init: async () => {
      set({ startupError: null });
      try {
        const state = persistedStateSchema.parse(await loadState());
        set({
          workspaces: state.workspaces,
          threads: state.threads,
          selectedWorkspaceId: state.selectedWorkspaceId,
          selectedThreadId: state.selectedThreadId,
          developerMode: state.developerMode,
          showHiddenFiles: state.showHiddenFiles,
          ready: true,
          startupError: null,
        });
        return;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error("Desktop init failed:", error);
        set((s) => ({
          workspaces: [],
          threads: [],
          selectedWorkspaceId: null,
          selectedThreadId: null,
          workspaceRuntimeById: {},
          threadRuntimeById: {},
          providerCatalog: [],
          providerDefaultModelByProvider: {},
          providerConnected: [],
          providerAuthMethodsByProvider: {},
          providerLastAuthChallenge: null,
          providerLastAuthResult: null,
          ready: true,
          startupError: detail,
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Startup recovery mode",
            detail,
          }),
        }));
        return;
      }
    },
  

    openSettings: (page) => {
      set((s) => ({
        view: "settings",
        settingsPage: page ?? s.settingsPage,
        lastNonSettingsView: s.view === "settings" ? s.lastNonSettingsView : s.view,
      }));
    },
  

    closeSettings: () => {
      set((s) => ({
        view: s.lastNonSettingsView === "settings" ? "chat" : s.lastNonSettingsView,
      }));
    },
  

    setSettingsPage: (page) => set({ settingsPage: page }),
  

    setDeveloperMode: (v) => {
      set({ developerMode: v });
      void persistNow(get);
    },

    setShowHiddenFiles: (v) => {
      set({ showHiddenFiles: v });
      void persistNow(get);
      const wsId = get().selectedWorkspaceId;
      if (wsId) {
        void get().refreshWorkspaceFiles(wsId);
      }
    },
  

    toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

    toggleContextSidebar: () => set((s) => ({ contextSidebarCollapsed: !s.contextSidebarCollapsed })),
  

    setSidebarWidth: (width: number) => set({ sidebarWidth: Math.max(180, Math.min(600, width)) }),

    setContextSidebarWidth: (width: number) => set({ contextSidebarWidth: Math.max(200, Math.min(600, width)) }),

    setMessageBarHeight: (height: number) => set({ messageBarHeight: Math.max(80, Math.min(500, height)) }),
  
  };
}
