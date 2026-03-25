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
import type { ChildModelRoutingMode } from "../../lib/wsProtocol";
import { safeParseServerEvent, type ProviderName } from "../../lib/wsProtocol";

import {
  type AppStoreDataState,
  type AppStoreActions,
  type StoreGet,
  type StoreSet,
  RUNTIME,
  appendThreadTranscript,
  basename,
  buildContextPreamble,
  ensureControlSocket,
  ensureServerRunning,
  defaultThreadRuntime,
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
  sendThread,
  sendUserMessageToThread,
  normalizeThreadTitleSource,
  syncDesktopStateCache,
  syncDesktopStateCacheNow,
  truncateTitle,
} from "../store.helpers";
import { deriveConnectedProviders, normalizePersistedProviderState } from "../persistedProviderState";
import { deriveDefaultLmStudioUiEnabled, normalizePersistedProviderUiState } from "../providerUiState";
import { normalizeWorkspaceProviderOptions } from "../openaiCompatibleProviderOptions";
import {
  type CachedSessionSnapshot,
  normalizeWorkspaceUserProfile,
  type CachedDesktopUiState,
  type PersistedOnboardingState,
  type PersistedProviderState,
  type SettingsPageId,
  type ThreadRecord,
  type ViewId,
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
const normalizedViewSchema = z.preprocess(
  (value) => (value === "chat" || value === "skills" || value === "settings" ? value : "chat"),
  z.enum(["chat", "skills", "settings"])
);
const normalizedSettingsPageSchema = z.preprocess(
  (value) => (
    value === "providers"
    || value === "usage"
    || value === "workspaces"
    || value === "remoteAccess"
    || value === "backup"
    || value === "mcp"
    || value === "memory"
    || value === "updates"
    || value === "developer"
      ? value
      : "providers"
  ),
  z.enum(["providers", "usage", "workspaces", "remoteAccess", "backup", "mcp", "memory", "updates", "developer"])
);
const normalizedNullableSelectionSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? value : null),
  z.string().nullable()
);
const normalizedUiWidthSchema = (min: number, max: number, fallback: number) => z.preprocess(
  (value) => (
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(min, Math.min(max, Math.floor(value)))
      : fallback
  ),
  z.number().int()
);

const persistedWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  createdAt: z.string(),
  lastOpenedAt: z.string(),
  wsProtocol: z.preprocess(() => "jsonrpc", z.literal("jsonrpc")),
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
    wsProtocol: "jsonrpc",
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
  messageCount: normalizedLastEventSeqSchema,
  lastEventSeq: normalizedLastEventSeqSchema,
  legacyTranscriptId: normalizedSessionIdSchema.optional(),
  draft: z.preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean()).optional(),
}).passthrough().transform((thread): ThreadRecord => {
  const id = thread.sessionId ?? thread.id;
  return {
    id,
    workspaceId: thread.workspaceId,
    title: thread.title,
    titleSource: normalizeThreadTitleSource(thread.titleSource, thread.title),
    createdAt: thread.createdAt,
    lastMessageAt: thread.lastMessageAt,
    status: thread.status,
    sessionId: thread.sessionId,
    messageCount: thread.messageCount,
    lastEventSeq: thread.lastEventSeq,
    legacyTranscriptId:
      thread.legacyTranscriptId
      ?? (thread.id !== id ? thread.id : null),
    draft: thread.draft ?? false,
  };
});

const persistedUiSchema = z.object({
  selectedWorkspaceId: normalizedNullableSelectionSchema.optional(),
  selectedThreadId: normalizedNullableSelectionSchema.optional(),
  view: normalizedViewSchema.optional(),
  settingsPage: normalizedSettingsPageSchema.optional(),
  lastNonSettingsView: normalizedViewSchema.optional(),
  sidebarCollapsed: z.preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean()).optional(),
  sidebarWidth: normalizedUiWidthSchema(160, 440, 248).optional(),
  contextSidebarCollapsed: z.preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean()).optional(),
  contextSidebarWidth: normalizedUiWidthSchema(200, 600, 300).optional(),
  messageBarHeight: normalizedUiWidthSchema(80, 500, 120).optional(),
}).passthrough().transform((ui): CachedDesktopUiState => ({
  selectedWorkspaceId: ui.selectedWorkspaceId ?? null,
  selectedThreadId: ui.selectedThreadId ?? null,
  view: ui.view ?? "chat",
  settingsPage: ui.settingsPage ?? "providers",
  lastNonSettingsView: ui.lastNonSettingsView ?? "chat",
  sidebarCollapsed: ui.sidebarCollapsed ?? false,
  sidebarWidth: ui.sidebarWidth ?? 248,
  contextSidebarCollapsed: ui.contextSidebarCollapsed ?? false,
  contextSidebarWidth: ui.contextSidebarWidth ?? 300,
  messageBarHeight: ui.messageBarHeight ?? 120,
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
  return {
    workspaces: state.workspaces,
    threads: state.threads,
    developerMode: state.developerMode,
    showHiddenFiles: state.showHiddenFiles,
    perWorkspaceSettings: state.perWorkspaceSettings,
    providerState,
    providerUiState,
    onboarding,
  };
});

type HydratedPersistedDesktopState = z.infer<typeof persistedStateSchema>;

export function hydratePersistedDesktopState(value: unknown): HydratedPersistedDesktopState {
  return persistedStateSchema.parse(value);
}

function buildResolvedDesktopUiState(
  workspaces: WorkspaceRecord[],
  threads: ThreadRecord[],
  ui?: CachedDesktopUiState | null,
) {
  const normalizedUi = persistedUiSchema.parse(ui ?? {});
  const workspaceByRecency = [...workspaces].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  const fallbackSelectedWorkspaceId = workspaceByRecency[0]?.id ?? null;
  const selectedWorkspaceId =
    normalizedUi.selectedWorkspaceId && workspaces.some((workspace) => workspace.id === normalizedUi.selectedWorkspaceId)
      ? normalizedUi.selectedWorkspaceId
      : fallbackSelectedWorkspaceId;
  const workspaceThreads = selectedWorkspaceId
    ? threads
        .filter((thread) => thread.workspaceId === selectedWorkspaceId)
        .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
    : [];
  const fallbackSelectedThreadId =
    workspaceThreads.find((thread) => thread.status === "active")?.id ??
    workspaceThreads[0]?.id ??
    null;
  const migratedSelectedThreadId = normalizedUi.selectedThreadId
    ? workspaceThreads.find((thread) => thread.id === normalizedUi.selectedThreadId)?.id
      ?? workspaceThreads.find((thread) => thread.legacyTranscriptId === normalizedUi.selectedThreadId)?.id
      ?? null
    : null;
  const selectedThreadId =
    migratedSelectedThreadId
      ? migratedSelectedThreadId
      : fallbackSelectedThreadId;
  const fallbackLastNonSettingsView = normalizedUi.view === "settings" ? "chat" : normalizedUi.view ?? "chat";
  const lastNonSettingsView =
    normalizedUi.lastNonSettingsView && normalizedUi.lastNonSettingsView !== "settings"
      ? normalizedUi.lastNonSettingsView
      : fallbackLastNonSettingsView;

  return {
    selectedWorkspaceId,
    selectedThreadId,
    view: normalizedUi.view ?? "chat",
    settingsPage: normalizedUi.settingsPage ?? "providers",
    lastNonSettingsView,
    sidebarCollapsed: normalizedUi.sidebarCollapsed ?? false,
    sidebarWidth: normalizedUi.sidebarWidth ?? 248,
    contextSidebarCollapsed: normalizedUi.contextSidebarCollapsed ?? false,
    contextSidebarWidth: normalizedUi.contextSidebarWidth ?? 300,
    messageBarHeight: normalizedUi.messageBarHeight ?? 120,
  };
}

function extractCachedDesktopState(value: unknown): {
  persistedState: unknown;
  ui: unknown;
  sessionSnapshots?: unknown;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if ("persistedState" in record) {
    return {
      persistedState: record.persistedState,
      ui: record.ui,
      sessionSnapshots: record.sessionSnapshots,
    };
  }

  return {
    persistedState: value,
    ui: record.ui,
    sessionSnapshots: record.sessionSnapshots,
  };
}

function normalizeCachedSessionSnapshot(sessionId: string, value: unknown): CachedSessionSnapshot | null {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const snapshot = (value as { snapshot?: unknown }).snapshot;
  const parsed = safeParseServerEvent({
    type: "session_snapshot",
    sessionId: "__desktop_cache__",
    targetSessionId: sessionId,
    snapshot,
  });
  if (!parsed || parsed.type !== "session_snapshot" || parsed.snapshot.sessionId !== sessionId) {
    return null;
  }

  return {
    fingerprint: {
      updatedAt: parsed.snapshot.updatedAt,
      messageCount: parsed.snapshot.messageCount,
      lastEventSeq: parsed.snapshot.lastEventSeq,
    },
    snapshot: parsed.snapshot,
  };
}

function runAfterInitialPaint(task: () => void): void {
  if (typeof window === "undefined") {
    setTimeout(task, 0);
    return;
  }

  const schedule = typeof window.requestAnimationFrame === "function"
    ? window.requestAnimationFrame.bind(window)
    : (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0);

  schedule(() => {
    setTimeout(task, 0);
  });
}

export function buildCachedDesktopStateSeed(value: unknown): Partial<AppStoreDataState> | null {
  try {
    const cached = extractCachedDesktopState(value);
    if (!cached) {
      return null;
    }

    const state = hydratePersistedDesktopState(cached.persistedState);
    RUNTIME.sessionSnapshots.clear();
    if (cached.sessionSnapshots && typeof cached.sessionSnapshots === "object" && !Array.isArray(cached.sessionSnapshots)) {
      for (const [sessionId, entry] of Object.entries(cached.sessionSnapshots as Record<string, unknown>)) {
        const normalized = normalizeCachedSessionSnapshot(sessionId, entry);
        if (!normalized) continue;
        RUNTIME.sessionSnapshots.set(sessionId, normalized);
      }
    }
    const ui = buildResolvedDesktopUiState(state.workspaces, state.threads, cached.ui as CachedDesktopUiState | undefined);
    const connectedProviders = deriveConnectedProviders(state.providerState as PersistedProviderState | undefined);
    return {
      ready: true,
      bootstrapPending: true,
      startupError: null,
      workspaces: state.workspaces,
      threads: state.threads,
      selectedWorkspaceId: ui.selectedWorkspaceId,
      selectedThreadId: ui.selectedThreadId,
      providerStatusByName: state.providerState?.statusByName ?? {},
      providerStatusLastUpdatedAt: state.providerState?.statusLastUpdatedAt ?? null,
      providerConnected: connectedProviders,
      providerUiState: state.providerUiState,
      developerMode: state.developerMode,
      showHiddenFiles: state.showHiddenFiles,
      perWorkspaceSettings: state.perWorkspaceSettings,
      onboardingState: state.onboarding ?? DEFAULT_ONBOARDING_STATE,
      onboardingVisible: false,
      onboardingStep: "welcome",
      threadRuntimeById: ui.selectedThreadId && ui.view === "chat"
        ? {
            [ui.selectedThreadId]: {
              ...defaultThreadRuntime(),
              hydrating: true,
            },
          }
        : {},
      view: ui.view,
      settingsPage: ui.settingsPage,
      lastNonSettingsView: ui.lastNonSettingsView,
      sidebarCollapsed: ui.sidebarCollapsed,
      sidebarWidth: ui.sidebarWidth,
      contextSidebarCollapsed: ui.contextSidebarCollapsed,
      contextSidebarWidth: ui.contextSidebarWidth,
      messageBarHeight: ui.messageBarHeight,
    };
  } catch {
    return null;
  }
}

export function createBootstrapActions(set: StoreSet, get: StoreGet): Pick<AppStoreActions, "init" | "openSettings" | "closeSettings" | "setSettingsPage" | "setDeveloperMode" | "setShowHiddenFiles" | "setPerWorkspaceSettings" | "setUpdateState" | "checkForUpdates" | "quitAndInstallUpdate" | "toggleSidebar" | "toggleContextSidebar" | "setSidebarWidth" | "setContextSidebarWidth" | "setMessageBarHeight"> {
  return {
    init: async () => {
      set({ startupError: null, bootstrapPending: true });
      try {
        const state = hydratePersistedDesktopState(await loadState());
        const ui = buildResolvedDesktopUiState(state.workspaces, state.threads, {
          selectedWorkspaceId: get().selectedWorkspaceId,
          selectedThreadId: get().selectedThreadId,
          view: get().view,
          settingsPage: get().settingsPage,
          lastNonSettingsView: get().lastNonSettingsView,
          sidebarCollapsed: get().sidebarCollapsed,
          sidebarWidth: get().sidebarWidth,
          contextSidebarCollapsed: get().contextSidebarCollapsed,
          contextSidebarWidth: get().contextSidebarWidth,
          messageBarHeight: get().messageBarHeight,
        });
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
          selectedWorkspaceId: ui.selectedWorkspaceId,
          selectedThreadId: ui.selectedThreadId,
          providerStatusByName: state.providerState?.statusByName ?? {},
          providerStatusLastUpdatedAt: state.providerState?.statusLastUpdatedAt ?? null,
          providerConnected: connectedProviders,
          providerUiState: state.providerUiState,
          developerMode: state.developerMode,
          showHiddenFiles: state.showHiddenFiles,
          perWorkspaceSettings: state.perWorkspaceSettings,
          updateState,
          ready: true,
          bootstrapPending: false,
          startupError: null,
          onboardingState: resolvedOnboarding,
          onboardingVisible: autoOpen,
          onboardingStep: "welcome",
          view: ui.view,
          settingsPage: ui.settingsPage,
          lastNonSettingsView: ui.lastNonSettingsView,
          sidebarCollapsed: ui.sidebarCollapsed,
          sidebarWidth: ui.sidebarWidth,
          contextSidebarCollapsed: ui.contextSidebarCollapsed,
          contextSidebarWidth: ui.contextSidebarWidth,
          messageBarHeight: ui.messageBarHeight,
        });

        // Persist backfilled onboarding status if we changed it.
        if (resolvedOnboarding.status !== (state.onboarding?.status ?? "pending")) {
          void persistNow(get);
        } else {
          syncDesktopStateCacheNow(get);
        }

        if (ui.selectedThreadId && ui.view === "chat") {
          set((s) => ({
            threadRuntimeById: {
              ...s.threadRuntimeById,
              [ui.selectedThreadId]: {
                ...defaultThreadRuntime(),
                ...s.threadRuntimeById[ui.selectedThreadId],
                hydrating: true,
              },
            },
          }));
          runAfterInitialPaint(() => {
            const current = get();
            if (current.selectedThreadId !== ui.selectedThreadId || current.view !== "chat") {
              return;
            }
            void current.selectThread(ui.selectedThreadId);
          });
        } else if (ui.selectedWorkspaceId && ui.view === "chat") {
          runAfterInitialPaint(() => {
            const current = get();
            if (current.selectedWorkspaceId !== ui.selectedWorkspaceId || current.view !== "chat") {
              return;
            }
            void current.selectWorkspace(ui.selectedWorkspaceId);
          });
        } else if (ui.selectedWorkspaceId && ui.view === "skills") {
          runAfterInitialPaint(() => {
            const current = get();
            if (current.selectedWorkspaceId !== ui.selectedWorkspaceId || current.view !== "skills") {
              return;
            }
            ensureWorkspaceRuntime(get, set, ui.selectedWorkspaceId);
            void ensureServerRunning(get, set, ui.selectedWorkspaceId).then(() => {
              ensureControlSocket(get, set, ui.selectedWorkspaceId);
            });
          });
        }
        return;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error("Desktop init failed:", error);
        if (get().ready) {
          set((s) => ({
            bootstrapPending: false,
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
          bootstrapPending: false,
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
      syncDesktopStateCache(get);
    },
  

    closeSettings: () => {
      set((s) => ({
        view: s.lastNonSettingsView === "settings" ? "chat" : s.lastNonSettingsView,
      }));
      syncDesktopStateCache(get);
    },
  

    setSettingsPage: (page) => {
      set({ settingsPage: page });
      syncDesktopStateCache(get);
    },
  

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
  

    toggleSidebar: () => {
      set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }));
      syncDesktopStateCache(get);
    },

    toggleContextSidebar: () => {
      set((s) => ({ contextSidebarCollapsed: !s.contextSidebarCollapsed }));
      syncDesktopStateCache(get);
    },
  

    setSidebarWidth: (width: number) => {
      set({ sidebarWidth: Math.max(160, Math.min(440, width)) });
      syncDesktopStateCache(get);
    },

    setContextSidebarWidth: (width: number) => {
      set({ contextSidebarWidth: Math.max(200, Math.min(600, width)) });
      syncDesktopStateCache(get);
    },

    setMessageBarHeight: (height: number) => {
      set({ messageBarHeight: Math.max(80, Math.min(500, height)) });
      syncDesktopStateCache(get);
    },
  
  };
}
