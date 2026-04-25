import { defaultModelForProvider } from "@cowork/providers/catalog";
import { z } from "zod";
import {
  type DesktopFeatureFlags,
  FEATURE_FLAG_DEFINITIONS,
  normalizeDesktopFeatureFlagOverrides,
} from "../../../../../src/shared/featureFlags";
import {
  getDesktopFeatureFlags,
  getUpdateState,
  isPackagedDesktopApp,
  loadState,
  quitAndInstallUpdate as runQuitAndInstallUpdate,
  checkForUpdates as runUpdateCheck,
  stopMobileRelay,
} from "../../lib/desktopCommands";
import { normalizeQuickChatShortcutAccelerator } from "../../lib/quickChatShortcut";
import type { ChildModelRoutingMode } from "../../lib/wsProtocol";
import { type ProviderName, safeParseSessionEvent } from "../../lib/wsProtocol";
import { normalizeWorkspaceProviderOptions } from "../openaiCompatibleProviderOptions";
import {
  deriveConnectedProviders,
  normalizePersistedProviderState,
} from "../persistedProviderState";
import {
  resolvePluginCatalogWorkspaceSelection,
  resolvePluginManagementWorkspaceId,
} from "../pluginManagement";
import {
  deriveDefaultLmStudioUiEnabled,
  normalizePersistedProviderUiState,
} from "../providerUiState";
import {
  type AppStoreActions,
  type AppStoreDataState,
  defaultThreadRuntime,
  ensureControlSocket,
  ensureServerRunning,
  ensureWorkspaceRuntime,
  isProviderName,
  makeId,
  normalizeThreadTitleSource,
  nowIso,
  persistNow,
  pushNotification,
  RUNTIME,
  requestJsonRpcControlEvent,
  type StoreGet,
  type StoreSet,
  syncDesktopStateCache,
  syncDesktopStateCacheNow,
} from "../store.helpers";
import {
  type CachedDesktopUiState,
  type CachedSessionSnapshot,
  normalizeDesktopSettings,
  normalizeWorkspaceUserProfile,
  type PersistedOnboardingState,
  type PersistedProviderState,
  type SettingsPageId,
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
  z.string().optional(),
);
const optionalStringSchema = z.preprocess(
  (value) => (typeof value === "string" ? value : undefined),
  z.string().optional(),
);

const normalizedProviderSchema = z.preprocess(
  (value) => (isProviderName(value) ? value : "google"),
  z.custom<ProviderName>((value): value is ProviderName => isProviderName(value)),
);

const normalizedThreadStatusSchema = z.preprocess(
  (value) => (value === "active" || value === "disconnected" ? value : "disconnected"),
  z.enum(["active", "disconnected"]),
);

const normalizedSessionIdSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? value : null),
  z.string().nullable(),
);

const normalizedLastEventSeqSchema = z.preprocess(
  (value) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0,
  z.number().int().nonnegative(),
);
const normalizedViewSchema = z.preprocess(
  (value) =>
    value === "chat" || value === "skills" || value === "research" || value === "settings"
      ? value
      : "chat",
  z.enum(["chat", "skills", "research", "settings"]),
);

function normalizeSettingsPageId(
  value: unknown,
  desktopFeatures: DesktopFeatureFlags = getDesktopFeatureFlags(),
): SettingsPageId {
  const normalized = normalizeKnownSettingsPageId(value);

  if (normalized === "remoteAccess" && desktopFeatures.remoteAccess !== true) {
    return "providers";
  }

  return normalized;
}

function normalizeKnownSettingsPageId(value: unknown): SettingsPageId {
  return value === "providers" ||
    value === "desktop" ||
    value === "usage" ||
    value === "workspaces" ||
    value === "remoteAccess" ||
    value === "backup" ||
    value === "mcp" ||
    value === "memory" ||
    value === "featureFlags" ||
    value === "updates" ||
    value === "developer"
    ? value
    : "providers";
}

const normalizedSettingsPageSchema = z.preprocess(
  (value) => normalizeKnownSettingsPageId(value),
  z.enum([
    "providers",
    "desktop",
    "usage",
    "workspaces",
    "remoteAccess",
    "backup",
    "mcp",
    "memory",
    "featureFlags",
    "updates",
    "developer",
  ]),
);
const normalizedNullableSelectionSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? value : null),
  z.string().nullable(),
);
const normalizedUiWidthSchema = (min: number, max: number, fallback: number) =>
  z.preprocess(
    (value) =>
      typeof value === "number" && Number.isFinite(value)
        ? Math.max(min, Math.min(max, Math.floor(value)))
        : fallback,
    z.number().int(),
  );

const persistedWorkspaceSchema = z
  .object({
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
    userProfile: z
      .object({
        instructions: optionalStringSchema,
        work: optionalStringSchema,
        details: optionalStringSchema,
      })
      .passthrough()
      .optional(),
    defaultEnableMcp: z.preprocess(
      (value) => (typeof value === "boolean" ? value : true),
      z.boolean(),
    ),
    defaultBackupsEnabled: z.preprocess(
      (value) => (typeof value === "boolean" ? value : true),
      z.boolean(),
    ),
    yolo: z.preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean()),
  })
  .passthrough()
  .transform((workspace): WorkspaceRecord => {
    const legacySubAgentModel = (() => {
      const asRecord = workspace as Record<string, unknown>;
      const legacy =
        typeof asRecord.defaultSubAgentModel === "string"
          ? asRecord.defaultSubAgentModel.trim()
          : "";
      return legacy.length > 0 ? legacy : undefined;
    })();
    const model =
      workspace.defaultModel ?? (defaultModelForProvider(workspace.defaultProvider) || "");
    const childModelRoutingMode = (workspace.defaultChildModelRoutingMode ??
      "same-provider") as ChildModelRoutingMode;
    const legacyPreferredValue =
      workspace.defaultPreferredChildModel ?? legacySubAgentModel ?? model;
    const preferredChildModelRef =
      workspace.defaultPreferredChildModelRef ??
      (legacyPreferredValue
        ? legacyPreferredValue.includes(":")
          ? legacyPreferredValue
          : `${workspace.defaultProvider}:${legacyPreferredValue}`
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
      userProfile: workspace.userProfile
        ? normalizeWorkspaceUserProfile(workspace.userProfile)
        : undefined,
      defaultEnableMcp: workspace.defaultEnableMcp,
      defaultBackupsEnabled: workspace.defaultBackupsEnabled,
      yolo: workspace.yolo,
    };
  });

const persistedThreadSchema = z
  .object({
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
    draft: z
      .preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean())
      .optional(),
  })
  .passthrough()
  .transform((thread): ThreadRecord => {
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
      legacyTranscriptId: thread.legacyTranscriptId ?? (thread.id !== id ? thread.id : null),
      draft: thread.draft ?? false,
    };
  });

const persistedUiSchema = z
  .object({
    selectedWorkspaceId: normalizedNullableSelectionSchema.optional(),
    selectedThreadId: normalizedNullableSelectionSchema.optional(),
    pluginManagementWorkspaceId: normalizedNullableSelectionSchema.optional(),
    pluginManagementMode: z.enum(["auto", "global", "workspace"]).optional(),
    view: normalizedViewSchema.optional(),
    settingsPage: normalizedSettingsPageSchema.optional(),
    lastNonSettingsView: normalizedViewSchema.optional(),
    sidebarCollapsed: z
      .preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean())
      .optional(),
    sidebarWidth: normalizedUiWidthSchema(160, 440, 248).optional(),
    contextSidebarCollapsed: z
      .preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean())
      .optional(),
    contextSidebarWidth: normalizedUiWidthSchema(200, 600, 300).optional(),
    messageBarHeight: normalizedUiWidthSchema(80, 500, 96).optional(),
  })
  .passthrough()
  .transform(
    (ui): CachedDesktopUiState => ({
      selectedWorkspaceId: ui.selectedWorkspaceId ?? null,
      selectedThreadId: ui.selectedThreadId ?? null,
      pluginManagementWorkspaceId: ui.pluginManagementWorkspaceId ?? null,
      pluginManagementMode: ui.pluginManagementMode ?? "auto",
      view: ui.view ?? "chat",
      settingsPage: ui.settingsPage ?? "providers",
      lastNonSettingsView: ui.lastNonSettingsView ?? "chat",
      sidebarCollapsed: ui.sidebarCollapsed ?? false,
      sidebarWidth: ui.sidebarWidth ?? 248,
      contextSidebarCollapsed: ui.contextSidebarCollapsed ?? false,
      contextSidebarWidth: ui.contextSidebarWidth ?? 300,
      messageBarHeight: ui.messageBarHeight ?? 96,
    }),
  );

const persistedStateSchema = z
  .object({
    workspaces: z.preprocess((value) => value ?? [], z.array(persistedWorkspaceSchema)),
    threads: z.preprocess((value) => value ?? [], z.array(persistedThreadSchema)),
    developerMode: z.preprocess(
      (value) => (typeof value === "boolean" ? value : false),
      z.boolean(),
    ),
    showHiddenFiles: z.preprocess(
      (value) => (typeof value === "boolean" ? value : false),
      z.boolean(),
    ),
    perWorkspaceSettings: z.preprocess(
      (value) => (typeof value === "boolean" ? value : false),
      z.boolean(),
    ),
    desktopSettings: z
      .object({
        quickChat: z
          .object({
            shortcutEnabled: z
              .preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean())
              .optional(),
            shortcutAccelerator: z
              .preprocess(
                (value) =>
                  typeof value === "string"
                    ? normalizeQuickChatShortcutAccelerator(value)
                    : undefined,
                z.string().optional(),
              )
              .optional(),
          })
          .optional(),
      })
      .optional(),
    desktopFeatureFlagOverrides: z.preprocess(
      (value) => normalizeDesktopFeatureFlagOverrides(value),
      z
        .object({
          menuBar: z.boolean().optional(),
          remoteAccess: z.boolean().optional(),
          workspacePicker: z.boolean().optional(),
          workspaceLifecycle: z.boolean().optional(),
          a2ui: z.boolean().optional(),
        })
        .passthrough()
        .optional(),
    ),
  })
  .passthrough()
  .transform((state) => {
    const providerState = normalizePersistedProviderState(
      (state as { providerState?: unknown }).providerState,
    );
    const providerUiState = normalizePersistedProviderUiState(
      (state as { providerUiState?: unknown }).providerUiState,
      {
        defaultLmStudioEnabled: deriveDefaultLmStudioUiEnabled({
          providerState,
          workspaces: state.workspaces,
        }),
      },
    );
    const onboarding = (state as { onboarding?: PersistedOnboardingState }).onboarding;
    return {
      workspaces: state.workspaces,
      threads: state.threads,
      developerMode: state.developerMode,
      showHiddenFiles: state.showHiddenFiles,
      perWorkspaceSettings: state.perWorkspaceSettings,
      desktopSettings: state.desktopSettings,
      desktopFeatureFlagOverrides: state.desktopFeatureFlagOverrides,
      providerState,
      providerUiState,
      onboarding,
    };
  });

type HydratedPersistedDesktopState = z.infer<typeof persistedStateSchema>;

function hasLegacyA2uiEnabled(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const workspaces = Array.isArray(record.workspaces) ? record.workspaces : [];
  for (const workspace of workspaces) {
    if (!workspace || typeof workspace !== "object") continue;
    const ws = workspace as Record<string, unknown>;
    if (ws.defaultEnableA2ui === true) {
      return true;
    }
    const featureFlags = ws.defaultFeatureFlags;
    if (featureFlags && typeof featureFlags === "object" && !Array.isArray(featureFlags)) {
      const flagsRecord = featureFlags as Record<string, unknown>;
      if (flagsRecord.a2ui === true) {
        return true;
      }
      const workspaceFlags = flagsRecord.workspace;
      if (
        workspaceFlags &&
        typeof workspaceFlags === "object" &&
        !Array.isArray(workspaceFlags) &&
        (workspaceFlags as Record<string, unknown>).a2ui === true
      ) {
        return true;
      }
    }
  }
  return false;
}

export function hydratePersistedDesktopState(value: unknown): HydratedPersistedDesktopState {
  const parsed = persistedStateSchema.parse(value);
  if (hasLegacyA2uiEnabled(value) && !parsed.desktopFeatureFlagOverrides?.a2ui) {
    return {
      ...parsed,
      desktopFeatureFlagOverrides: {
        ...parsed.desktopFeatureFlagOverrides,
        a2ui: true,
      },
    };
  }
  return parsed;
}

function buildResolvedDesktopUiState(
  workspaces: WorkspaceRecord[],
  threads: ThreadRecord[],
  desktopFeatures: DesktopFeatureFlags,
  ui?: CachedDesktopUiState | null,
) {
  const normalizedUi = persistedUiSchema.parse(ui ?? {});
  const workspaceByRecency = [...workspaces].sort((a, b) =>
    b.lastOpenedAt.localeCompare(a.lastOpenedAt),
  );
  const fallbackSelectedWorkspaceId = workspaceByRecency[0]?.id ?? null;
  const selection = resolvePluginCatalogWorkspaceSelection({
    workspaces,
    selectedWorkspaceId:
      normalizedUi.selectedWorkspaceId &&
      workspaces.some((workspace) => workspace.id === normalizedUi.selectedWorkspaceId)
        ? normalizedUi.selectedWorkspaceId
        : fallbackSelectedWorkspaceId,
    pluginManagementWorkspaceId: normalizedUi.pluginManagementWorkspaceId,
    pluginManagementMode: normalizedUi.pluginManagementMode,
  });
  const selectedWorkspaceId = selection.selectedWorkspaceId;
  const pluginManagementWorkspaceId = selection.pluginManagementWorkspaceId;
  const pluginManagementMode = selection.pluginManagementMode;
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
    ? (workspaceThreads.find((thread) => thread.id === normalizedUi.selectedThreadId)?.id ??
      workspaceThreads.find((thread) => thread.legacyTranscriptId === normalizedUi.selectedThreadId)
        ?.id ??
      null)
    : null;
  const selectedThreadId = migratedSelectedThreadId
    ? migratedSelectedThreadId
    : fallbackSelectedThreadId;
  const fallbackLastNonSettingsView =
    normalizedUi.view === "settings" ? "chat" : (normalizedUi.view ?? "chat");
  const lastNonSettingsView =
    normalizedUi.lastNonSettingsView && normalizedUi.lastNonSettingsView !== "settings"
      ? normalizedUi.lastNonSettingsView
      : fallbackLastNonSettingsView;

  return {
    selectedWorkspaceId,
    selectedThreadId,
    pluginManagementWorkspaceId,
    pluginManagementMode,
    view: normalizedUi.view ?? "chat",
    settingsPage: normalizeSettingsPageId(normalizedUi.settingsPage, desktopFeatures),
    lastNonSettingsView,
    sidebarCollapsed: normalizedUi.sidebarCollapsed ?? false,
    sidebarWidth: normalizedUi.sidebarWidth ?? 248,
    contextSidebarCollapsed: normalizedUi.contextSidebarCollapsed ?? false,
    contextSidebarWidth: normalizedUi.contextSidebarWidth ?? 300,
    messageBarHeight: normalizedUi.messageBarHeight ?? 96,
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

function normalizeCachedSessionSnapshot(
  sessionId: string,
  value: unknown,
): CachedSessionSnapshot | null {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const snapshot = (value as { snapshot?: unknown }).snapshot;
  const parsed = safeParseSessionEvent({
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

  const schedule =
    typeof window.requestAnimationFrame === "function"
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
    const desktopFeatureFlags = getDesktopFeatureFlags(state.desktopFeatureFlagOverrides);
    RUNTIME.sessionSnapshots.clear();
    if (
      cached.sessionSnapshots &&
      typeof cached.sessionSnapshots === "object" &&
      !Array.isArray(cached.sessionSnapshots)
    ) {
      for (const [sessionId, entry] of Object.entries(
        cached.sessionSnapshots as Record<string, unknown>,
      )) {
        const normalized = normalizeCachedSessionSnapshot(sessionId, entry);
        if (!normalized) continue;
        RUNTIME.sessionSnapshots.set(sessionId, normalized);
      }
    }
    const ui = buildResolvedDesktopUiState(
      state.workspaces,
      state.threads,
      desktopFeatureFlags,
      cached.ui as CachedDesktopUiState | undefined,
    );
    const connectedProviders = deriveConnectedProviders(
      state.providerState as PersistedProviderState | undefined,
    );
    return {
      ready: true,
      bootstrapPending: true,
      startupError: null,
      workspaces: state.workspaces,
      threads: state.threads,
      selectedWorkspaceId: ui.selectedWorkspaceId,
      selectedThreadId: ui.selectedThreadId,
      pluginManagementWorkspaceId: ui.pluginManagementWorkspaceId,
      pluginManagementMode: ui.pluginManagementMode,
      providerStatusByName: state.providerState?.statusByName ?? {},
      providerStatusLastUpdatedAt: state.providerState?.statusLastUpdatedAt ?? null,
      providerConnected: connectedProviders,
      providerUiState: state.providerUiState,
      developerMode: state.developerMode,
      showHiddenFiles: state.showHiddenFiles,
      perWorkspaceSettings: state.perWorkspaceSettings,
      desktopSettings: normalizeDesktopSettings(state.desktopSettings),
      desktopFeatureFlags,
      desktopFeatureFlagOverrides: state.desktopFeatureFlagOverrides ?? {},
      onboardingState: state.onboarding ?? DEFAULT_ONBOARDING_STATE,
      onboardingVisible: false,
      onboardingStep: "welcome",
      threadRuntimeById:
        ui.selectedThreadId && ui.view === "chat"
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

export function createBootstrapActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  | "init"
  | "openSettings"
  | "closeSettings"
  | "setSettingsPage"
  | "setDeveloperMode"
  | "setShowHiddenFiles"
  | "setPerWorkspaceSettings"
  | "setQuickChatShortcutEnabled"
  | "setQuickChatShortcutAccelerator"
  | "setDesktopFeatureFlagOverride"
  | "setUpdateState"
  | "checkForUpdates"
  | "quitAndInstallUpdate"
  | "toggleSidebar"
  | "toggleContextSidebar"
  | "setSidebarWidth"
  | "setContextSidebarWidth"
  | "setMessageBarHeight"
> {
  return {
    init: async () => {
      set({ startupError: null, bootstrapPending: true });
      try {
        const state = hydratePersistedDesktopState(await loadState());
        const desktopFeatureFlags = getDesktopFeatureFlags(state.desktopFeatureFlagOverrides);
        let updateState = get().updateState;
        try {
          updateState = await getUpdateState();
        } catch (error) {
          console.warn("Desktop updater state load failed:", error);
        }
        const ui = buildResolvedDesktopUiState(
          state.workspaces,
          state.threads,
          desktopFeatureFlags,
          {
            selectedWorkspaceId: get().selectedWorkspaceId,
            selectedThreadId: get().selectedThreadId,
            pluginManagementWorkspaceId: get().pluginManagementWorkspaceId,
            pluginManagementMode: get().pluginManagementMode,
            view: get().view,
            settingsPage: get().settingsPage,
            lastNonSettingsView: get().lastNonSettingsView,
            sidebarCollapsed: get().sidebarCollapsed,
            sidebarWidth: get().sidebarWidth,
            contextSidebarCollapsed: get().contextSidebarCollapsed,
            contextSidebarWidth: get().contextSidebarWidth,
            messageBarHeight: get().messageBarHeight,
          },
        );
        const connectedProviders = deriveConnectedProviders(
          state.providerState as PersistedProviderState | undefined,
        );
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
          pluginManagementWorkspaceId: ui.pluginManagementWorkspaceId,
          pluginManagementMode: ui.pluginManagementMode,
          providerStatusByName: state.providerState?.statusByName ?? {},
          providerStatusLastUpdatedAt: state.providerState?.statusLastUpdatedAt ?? null,
          providerConnected: connectedProviders,
          providerUiState: state.providerUiState,
          developerMode: state.developerMode,
          showHiddenFiles: state.showHiddenFiles,
          perWorkspaceSettings: state.perWorkspaceSettings,
          desktopSettings: normalizeDesktopSettings(state.desktopSettings),
          desktopFeatureFlags,
          desktopFeatureFlagOverrides: state.desktopFeatureFlagOverrides ?? {},
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
          const selectedWorkspaceId = ui.selectedWorkspaceId;
          runAfterInitialPaint(() => {
            const current = get();
            if (current.selectedWorkspaceId !== selectedWorkspaceId || current.view !== "chat") {
              return;
            }
            void current.selectWorkspace(selectedWorkspaceId);
          });
        } else if (ui.selectedWorkspaceId && ui.view === "skills") {
          const startupWorkspaceId =
            resolvePluginManagementWorkspaceId(state.workspaces, ui.pluginManagementWorkspaceId) ??
            ui.selectedWorkspaceId;
          runAfterInitialPaint(() => {
            const current = get();
            if (
              current.selectedWorkspaceId !== ui.selectedWorkspaceId ||
              current.pluginManagementWorkspaceId !== ui.pluginManagementWorkspaceId ||
              current.pluginManagementMode !== ui.pluginManagementMode ||
              current.view !== "skills"
            ) {
              return;
            }
            ensureWorkspaceRuntime(get, set, startupWorkspaceId);
            void ensureServerRunning(get, set, startupWorkspaceId).then(() => {
              ensureControlSocket(get, set, startupWorkspaceId);
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
        settingsPage: normalizeSettingsPageId(page ?? s.settingsPage, s.desktopFeatureFlags),
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
      set((state) => ({
        settingsPage: normalizeSettingsPageId(page, state.desktopFeatureFlags),
      }));
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
        const source =
          state.workspaces.find((w) => w.id === state.selectedWorkspaceId) ?? state.workspaces[0];
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

    setQuickChatShortcutEnabled: (enabled) => {
      set((state) => ({
        desktopSettings: {
          ...state.desktopSettings,
          quickChat: {
            ...state.desktopSettings.quickChat,
            shortcutEnabled: enabled,
          },
        },
      }));
      void persistNow(get);
    },

    setQuickChatShortcutAccelerator: (accelerator) => {
      set((state) => ({
        desktopSettings: {
          ...state.desktopSettings,
          quickChat: {
            ...state.desktopSettings.quickChat,
            shortcutAccelerator: normalizeQuickChatShortcutAccelerator(accelerator),
          },
        },
      }));
      void persistNow(get);
    },

    setDesktopFeatureFlagOverride: async (flagId, enabled) => {
      const definition = FEATURE_FLAG_DEFINITIONS[flagId];
      if (
        definition.packagedAvailability === "forced-off" &&
        (isPackagedDesktopApp() || get().updateState.packaged)
      ) {
        return;
      }
      const currentFeatureFlags = get().desktopFeatureFlags;
      const currentOverrides = get().desktopFeatureFlagOverrides ?? {};
      const nextOverrides = {
        ...currentOverrides,
        [flagId]: enabled,
      };
      const nextFeatureFlags = getDesktopFeatureFlags(nextOverrides);
      set((state) => ({
        desktopFeatureFlagOverrides: nextOverrides,
        desktopFeatureFlags: nextFeatureFlags,
        settingsPage: normalizeSettingsPageId(state.settingsPage, nextFeatureFlags),
      }));
      void persistNow(get);
      if (flagId === "a2ui") {
        const state = get();
        const activeControlWorkspaces = state.workspaces.filter((workspace) =>
          Boolean(state.workspaceRuntimeById[workspace.id]?.controlSessionId),
        );

        const fanoutResults = await Promise.all(
          activeControlWorkspaces.map(async (workspace) => {
            try {
              await requestJsonRpcControlEvent(
                get,
                set,
                workspace.id,
                "cowork/session/defaults/apply",
                {
                  cwd: workspace.path,
                  config: {
                    featureFlags: {
                      workspace: {
                        a2ui: enabled,
                      },
                    },
                  },
                },
              );
              return { workspaceId: workspace.id, ok: true as const };
            } catch (error) {
              return {
                workspaceId: workspace.id,
                ok: false as const,
                detail: error instanceof Error ? error.message : String(error),
              };
            }
          }),
        );

        const failedWorkspaceIds = new Set(
          fanoutResults.filter((r) => !r.ok).map((r) => r.workspaceId),
        );
        if (failedWorkspaceIds.size > 0) {
          const failedNames = activeControlWorkspaces
            .filter((w) => failedWorkspaceIds.has(w.id))
            .map((w) => w.name || w.path)
            .join(", ");
          set((s) => ({
            notifications: pushNotification(s.notifications, {
              id: makeId(),
              ts: nowIso(),
              kind: "error",
              title: `Could not sync A2UI flag to ${failedWorkspaceIds.size} workspace${failedWorkspaceIds.size === 1 ? "" : "s"}`,
              detail: `Reopen or restart: ${failedNames}`,
            }),
          }));
        }

        const activeWorkspaceIds = new Set(
          activeControlWorkspaces
            .filter((w) => !failedWorkspaceIds.has(w.id))
            .map((workspace) => workspace.id),
        );
        const activeThreadIds = get()
          .threads.filter((thread) => activeWorkspaceIds.has(thread.workspaceId))
          .map((thread) => thread.id);
        for (const threadId of activeThreadIds) {
          void get().applyWorkspaceDefaultsToThread(threadId, "explicit");
        }
      }
      if (
        flagId === "remoteAccess" &&
        currentFeatureFlags.remoteAccess === true &&
        enabled === false
      ) {
        await stopMobileRelay().catch(() => {
          // Best-effort teardown: disabling the flag should not fail if the relay is already gone.
        });
      }
    },

    setUpdateState: (updateState) => {
      let settingsPageChanged = false;
      set((state) => {
        const nextSettingsPage = normalizeSettingsPageId(
          state.settingsPage,
          state.desktopFeatureFlags,
        );
        settingsPageChanged = nextSettingsPage !== state.settingsPage;
        return {
          updateState,
          settingsPage: nextSettingsPage,
        };
      });
      if (settingsPageChanged) {
        syncDesktopStateCache(get);
      }
    },

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
