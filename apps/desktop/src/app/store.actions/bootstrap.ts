import { defaultModelForProvider } from "@cowork/providers/catalog";
import { z } from "zod";

import {
  checkForUpdates as runUpdateCheck,
  getUpdateState,
  quitAndInstallUpdate as runQuitAndInstallUpdate,
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
import type { ChildModelRoutingMode } from "../../lib/wsProtocol";

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
import { deriveConnectedProviders, normalizePersistedProviderState } from "../persistedProviderState";
import { deriveDefaultLmStudioUiEnabled, normalizePersistedProviderUiState } from "../providerUiState";
import { normalizeWorkspaceProviderOptions } from "../openaiCompatibleProviderOptions";
import {
  normalizeWorkspaceUserProfile,
  type PersistedOnboardingState,
  type PersistedProviderState,
  type ThreadRecord,
  type WorkspaceRecord,
} from "../types";
import {
  DEFAULT_ONBOARDING_STATE,
  shouldAutoOpenOnboarding,
  shouldBackfillOnboardingCompleted,
} from "./onboarding";

const optionalStringWithContentSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? value : undefined),
  z.string().optional()
);
const optionalStringSchema = z.preprocess(
  (value) => (typeof value === "string" ? value : undefined),
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
  defaultPreferredChildModel: optionalStringWithContentSchema,
  defaultChildModelRoutingMode: z.enum(["same-provider", "cross-provider-allowlist"]).optional(),
  defaultPreferredChildModelRef: optionalStringWithContentSchema,
  defaultAllowedChildModelRefs: z.array(z.string().trim().min(1)).optional(),
  defaultToolOutputOverflowChars: z.preprocess((value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }
    return undefined;
  }, z.number().int().nonnegative().nullable().optional()),
  providerOptions: z.unknown().optional(),
  userName: optionalStringSchema,
  userProfile: z.object({
    instructions: optionalStringSchema,
    work: optionalStringSchema,
    details: optionalStringSchema,
  }).passthrough().optional(),
  defaultEnableMcp: z.preprocess((value) => (typeof value === "boolean" ? value : true), z.boolean()),
  defaultBackupsEnabled: z.preprocess((value) => (typeof value === "boolean" ? value : true), z.boolean()),
  yolo: z.preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean()),
}).passthrough().transform((workspace): WorkspaceRecord => {
  const legacySubAgentModel = (() => {
    const asRecord = workspace as Record<string, unknown>;
    const legacy = typeof asRecord.defaultSubAgentModel === "string" ? asRecord.defaultSubAgentModel.trim() : "";
    return legacy.length > 0 ? legacy : undefined;
  })();
  const model = workspace.defaultModel ?? (defaultModelForProvider(workspace.defaultProvider) || "");
  const childModelRoutingMode = (workspace.defaultChildModelRoutingMode ?? "same-provider") as ChildModelRoutingMode;
  const legacyPreferredValue = workspace.defaultPreferredChildModel ?? legacySubAgentModel ?? model;
  const preferredChildModelRef =
    workspace.defaultPreferredChildModelRef
    ?? (legacyPreferredValue
      ? (legacyPreferredValue.includes(":") ? legacyPreferredValue : `${workspace.defaultProvider}:${legacyPreferredValue}`)
      : "");
  return {
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    createdAt: workspace.createdAt,
    lastOpenedAt: workspace.lastOpenedAt,
    defaultProvider: workspace.defaultProvider,
    defaultModel: model,
    defaultPreferredChildModel: legacyPreferredValue,
    defaultChildModelRoutingMode: childModelRoutingMode,
    defaultPreferredChildModelRef: preferredChildModelRef,
    defaultAllowedChildModelRefs: workspace.defaultAllowedChildModelRefs ?? [],
    defaultToolOutputOverflowChars: workspace.defaultToolOutputOverflowChars,
    providerOptions: normalizeWorkspaceProviderOptions(workspace.providerOptions),
    userName: workspace.userName,
    userProfile: workspace.userProfile ? normalizeWorkspaceUserProfile(workspace.userProfile) : undefined,
    defaultEnableMcp: workspace.defaultEnableMcp,
    defaultBackupsEnabled: workspace.defaultBackupsEnabled,
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
  perWorkspaceSettings: z.preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean()),
}).passthrough().transform((state) => {
  const providerState = normalizePersistedProviderState((state as { providerState?: unknown }).providerState);
  const providerUiState = normalizePersistedProviderUiState((state as { providerUiState?: unknown }).providerUiState, {
    defaultLmStudioEnabled: deriveDefaultLmStudioUiEnabled({
      providerState,
      workspaces: state.workspaces,
    }),
  });
  const onboarding = (state as { onboarding?: PersistedOnboardingState }).onboarding;
  const workspaceByRecency = [...state.workspaces].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  const selectedWorkspaceId = workspaceByRecency[0]?.id ?? null;
  const workspaceThreads = selectedWorkspaceId
    ? state.threads
        .filter((thread) => thread.workspaceId === selectedWorkspaceId)
        .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
    : [];
  const selectedThreadId =
    workspaceThreads.find((thread) => thread.status === "active")?.id ??
    workspaceThreads[0]?.id ??
    null;
  return {
    workspaces: state.workspaces,
    threads: state.threads,
    selectedWorkspaceId,
    selectedThreadId,
    developerMode: state.developerMode,
    showHiddenFiles: state.showHiddenFiles,
    perWorkspaceSettings: state.perWorkspaceSettings,
    providerState,
    providerUiState,
    onboarding,
  };
});

export function createBootstrapActions(set: StoreSet, get: StoreGet): Pick<AppStoreActions, "init" | "openSettings" | "closeSettings" | "setSettingsPage" | "setDeveloperMode" | "setShowHiddenFiles" | "setPerWorkspaceSettings" | "setUpdateState" | "checkForUpdates" | "quitAndInstallUpdate" | "toggleSidebar" | "toggleContextSidebar" | "setSidebarWidth" | "setContextSidebarWidth" | "setMessageBarHeight"> {
  return {
    init: async () => {
      set({ startupError: null });
      try {
        const state = persistedStateSchema.parse(await loadState());
        let updateState = get().updateState;
        try {
          updateState = await getUpdateState();
        } catch (error) {
          console.warn("Desktop updater state load failed:", error);
        }
        const connectedProviders = deriveConnectedProviders(state.providerState as PersistedProviderState | undefined);
        const onboardingOpts = {
          onboarding: state.onboarding,
          workspaceCount: state.workspaces.length,
          threadCount: state.threads.length,
          hasConnectedProvider: connectedProviders.length > 0,
        };

        // Backfill: if existing user but onboarding metadata was never set, mark completed.
        let resolvedOnboarding = state.onboarding ?? DEFAULT_ONBOARDING_STATE;
        if (shouldBackfillOnboardingCompleted(onboardingOpts)) {
          resolvedOnboarding = { status: "completed", completedAt: nowIso(), dismissedAt: null };
        }

        const autoOpen = shouldAutoOpenOnboarding(onboardingOpts);

        set({
          workspaces: state.workspaces,
          threads: state.threads,
          selectedWorkspaceId: state.selectedWorkspaceId,
          selectedThreadId: state.selectedThreadId,
          providerStatusByName: state.providerState?.statusByName ?? {},
          providerStatusLastUpdatedAt: state.providerState?.statusLastUpdatedAt ?? null,
          providerConnected: connectedProviders,
          providerUiState: state.providerUiState,
          developerMode: state.developerMode,
          showHiddenFiles: state.showHiddenFiles,
          perWorkspaceSettings: state.perWorkspaceSettings,
          updateState,
          ready: true,
          startupError: null,
          onboardingState: resolvedOnboarding,
          onboardingVisible: autoOpen,
          onboardingStep: "welcome",
        });

        // Persist backfilled onboarding status if we changed it.
        if (resolvedOnboarding.status !== (state.onboarding?.status ?? "pending")) {
          void persistNow(get);
        }

        if (state.selectedThreadId) {
          await get().selectThread(state.selectedThreadId);
        } else if (state.selectedWorkspaceId) {
          await get().selectWorkspace(state.selectedWorkspaceId);
        }
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
          providerUiState: normalizePersistedProviderUiState(undefined),
          ready: true,
          startupError: detail,
          onboardingVisible: false,
          onboardingStep: "welcome" as const,
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

    setPerWorkspaceSettings: (enabled) => {
      set({ perWorkspaceSettings: enabled });
      if (!enabled) {
        const state = get();
        const source = state.workspaces.find((w) => w.id === state.selectedWorkspaceId) ?? state.workspaces[0];
        if (source && state.workspaces.length > 1) {
          const settingsFields: (keyof typeof source)[] = [
            "defaultProvider",
            "defaultModel",
            "defaultPreferredChildModel",
            "defaultChildModelRoutingMode",
            "defaultPreferredChildModelRef",
            "defaultAllowedChildModelRefs",
            "defaultToolOutputOverflowChars",
            "providerOptions",
            "userName",
            "userProfile",
            "defaultEnableMcp",
            "defaultBackupsEnabled",
            "yolo",
          ];
          const patch: Record<string, unknown> = {};
          for (const key of settingsFields) {
            patch[key] = source[key];
          }
          set((s) => ({
            workspaces: s.workspaces.map((w) => (w.id === source.id ? w : { ...w, ...patch })),
          }));

          // Push updated defaults to active threads in other workspaces
          const affectedWorkspaceIds = state.workspaces
            .filter((w) => w.id !== source.id)
            .map((w) => w.id);
          for (const wsId of affectedWorkspaceIds) {
            const threadIds = get()
              .threads.filter((t) => t.workspaceId === wsId)
              .map((t) => t.id);
            for (const threadId of threadIds) {
              void get().applyWorkspaceDefaultsToThread(threadId, "explicit");
            }
          }
        }
      }
      void persistNow(get);
    },

    setUpdateState: (updateState) => set({ updateState }),

    checkForUpdates: async () => {
      await runUpdateCheck();
    },

    quitAndInstallUpdate: async () => {
      await runQuitAndInstallUpdate();
    },
  

    toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

    toggleContextSidebar: () => set((s) => ({ contextSidebarCollapsed: !s.contextSidebarCollapsed })),
  

    setSidebarWidth: (width: number) => set({ sidebarWidth: Math.max(160, Math.min(440, width)) }),

    setContextSidebarWidth: (width: number) => set({ contextSidebarWidth: Math.max(200, Math.min(600, width)) }),

    setMessageBarHeight: (height: number) => set({ messageBarHeight: Math.max(80, Math.min(500, height)) }),
  
  };
}
