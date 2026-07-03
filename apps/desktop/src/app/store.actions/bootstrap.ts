import { defaultModelForProvider } from "@cowork/providers/catalog";
import { z } from "zod";
import {
  type DesktopFeatureFlags,
  FEATURE_FLAG_DEFINITIONS,
  normalizeDesktopFeatureFlagOverrides,
} from "../../../../../src/shared/featureFlags";
import {
  deleteTranscript,
  getDesktopFeatureFlags,
  getUpdateState,
  isDesktopDemoMode,
  isPackagedDesktopApp,
  loadState,
  quitAndInstallUpdate as runQuitAndInstallUpdate,
  checkForUpdates as runUpdateCheck,
  stopMobileRelay,
} from "../../lib/desktopCommands";
import { isCanvasSupportedFile } from "../../lib/filePreviewKind";
import { normalizeQuickChatShortcutAccelerator } from "../../lib/quickChatShortcut";
import type { ChildModelRoutingMode } from "../../lib/wsProtocol";
import { type ProviderName, safeParseSessionEvent } from "../../lib/wsProtocol";
import { normalizeWorkspaceProviderOptions } from "../openaiCompatibleProviderOptions";
import {
  deriveConnectedProviders,
  normalizePersistedProviderState,
} from "../persistedProviderState";
import {
  deriveDefaultLmStudioUiEnabled,
  normalizePersistedProviderUiState,
} from "../providerUiState";
import { isSettingsPageAvailable } from "../settingsPageAvailability";
import {
  type AppStoreActions,
  type AppStoreDataState,
  defaultThreadRuntime,
  isProviderName,
  makeId,
  normalizeThreadTitleSource,
  nowIso,
  persistNow,
  pushNotification,
  RUNTIME,
  type StoreGet,
  type StoreSet,
  syncDesktopStateCache,
  syncDesktopStateCacheNow,
} from "../store.helpers";
import { runAfterNextPaintOrTimeout } from "../store.helpers/paintScheduling";
import { isStandardChatThread } from "../threadFilters";
import { getThreadSelectionContext, getThreadSelectionIntent } from "../threadSelectionContext";
import {
  type CachedDesktopUiState,
  type CachedSessionSnapshot,
  normalizeCloudSyncSettings,
  normalizeDesktopSettings,
  normalizePrivacyTelemetrySettings,
  normalizeSidebarSectionOrder,
  normalizeWorkspaceUserProfile,
  type PersistedCloudSyncSettings,
  type PersistedOnboardingState,
  type PersistedPrivacyTelemetrySettings,
  type PersistedProviderState,
  type SettingsPageId,
  type ThreadRecord,
  type WorkspaceRecord,
} from "../types";
import { DEFAULT_ONBOARDING_STATE, resolveStartupOnboarding } from "./onboarding";

const optionalStringWithContentSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? value : undefined),
  z.string().optional(),
);
const SAFE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const optionalSafeIdSchema = z.preprocess((value) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return SAFE_ID.test(trimmed) ? trimmed : undefined;
}, z.string().optional());
const optionalStringSchema = z.preprocess(
  (value) => (typeof value === "string" ? value : undefined),
  z.string().optional(),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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
  (value) => {
    // The standalone skills/plugins view moved into Settings > Tool Access.
    if (value === "skills") return "settings";
    return value === "chat" || value === "task" || value === "research" || value === "settings"
      ? value
      : "chat";
  },
  z.enum(["chat", "task", "research", "settings"]),
);

function normalizeSettingsPageId(
  value: unknown,
  desktopFeatures: DesktopFeatureFlags = getDesktopFeatureFlags(),
  packaged = isPackagedDesktopApp(),
): SettingsPageId {
  const normalized = normalizeKnownSettingsPageId(value);

  if (!isSettingsPageAvailable(normalized, { desktopFeatures, packaged })) {
    return "models";
  }

  return normalized;
}

function normalizeKnownSettingsPageId(value: unknown): SettingsPageId {
  if (value === "providers") return "models";
  if (value === "mcp" || value === "openAiNativeConnectors") return "toolAccess";
  if (value === "workspaces") return "defaults";
  if (value === "memory") return "profileMemory";
  if (value === "archivedChats") return "chats";
  if (value === "featureFlags") return "experiments";
  if (value === "developer") return "diagnostics";

  return value === "models" ||
    value === "subagents" ||
    value === "toolAccess" ||
    value === "defaults" ||
    value === "profileMemory" ||
    value === "chats" ||
    value === "experiments" ||
    value === "diagnostics" ||
    value === "privacyTelemetry" ||
    value === "desktop" ||
    value === "usage" ||
    value === "remoteAccess" ||
    value === "backup" ||
    value === "updates"
    ? value
    : "models";
}

const normalizedSettingsPageSchema = z.preprocess(
  (value) => normalizeKnownSettingsPageId(value),
  z.enum([
    "models",
    "subagents",
    "toolAccess",
    "defaults",
    "profileMemory",
    "chats",
    "experiments",
    "diagnostics",
    "privacyTelemetry",
    "desktop",
    "usage",
    "remoteAccess",
    "backup",
    "updates",
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
    workspaceKind: z
      .preprocess(
        (value) => (value === "oneOffChat" ? "oneOffChat" : "project"),
        z.enum(["project", "oneOffChat"]),
      )
      .optional(),
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
      (value) => (typeof value === "boolean" ? value : false),
      z.boolean(),
    ),
    defaultAdvancedMemory: z.boolean().optional(),
    defaultMemoryGenerationModel: z.string().optional(),
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
      workspaceKind: workspace.workspaceKind ?? "project",
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
      defaultAdvancedMemory: workspace.defaultAdvancedMemory,
      defaultMemoryGenerationModel: workspace.defaultMemoryGenerationModel,
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
    taskId: optionalSafeIdSchema,
    taskThreadId: optionalSafeIdSchema,
    draft: z
      .preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean())
      .optional(),
    archived: z
      .preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean())
      .optional(),
    archivedAt: z.string().optional(),
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
      ...(thread.taskId ? { taskId: thread.taskId } : {}),
      ...(thread.taskThreadId ? { taskThreadId: thread.taskThreadId } : {}),
      draft: thread.draft ?? false,
      archived: thread.archived ?? false,
      archivedAt: thread.archivedAt,
    };
  });

const persistedUiSchema = z
  .object({
    selectedWorkspaceId: normalizedNullableSelectionSchema.optional(),
    selectedThreadId: normalizedNullableSelectionSchema.optional(),
    selectedTaskId: normalizedNullableSelectionSchema.optional(),
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
    canvasSidebarWidth: normalizedUiWidthSchema(200, 900, 500).optional(),
    messageBarHeight: normalizedUiWidthSchema(80, 500, 96).optional(),
  })
  .passthrough()
  .transform(
    (ui): CachedDesktopUiState => ({
      selectedWorkspaceId: ui.selectedWorkspaceId ?? null,
      selectedThreadId: ui.selectedThreadId ?? null,
      selectedTaskId: ui.selectedTaskId ?? null,
      view: ui.view ?? "chat",
      settingsPage: ui.settingsPage ?? "models",
      lastNonSettingsView: ui.lastNonSettingsView ?? "chat",
      sidebarCollapsed: ui.sidebarCollapsed ?? false,
      sidebarWidth: ui.sidebarWidth ?? 248,
      contextSidebarCollapsed: ui.contextSidebarCollapsed ?? false,
      contextSidebarWidth: ui.contextSidebarWidth ?? 300,
      canvasSidebarWidth: ui.canvasSidebarWidth ?? 500,
      messageBarHeight: ui.messageBarHeight ?? 96,
    }),
  );

const privacyTelemetrySettingsSchema = z.preprocess(
  (value) =>
    normalizePrivacyTelemetrySettings(
      isRecord(value) ? (value as PersistedPrivacyTelemetrySettings) : undefined,
    ),
  z.object({
    crashReportsEnabled: z.boolean(),
    productAnalyticsEnabled: z.boolean(),
    aiTraceTelemetryEnabled: z.boolean(),
    aiTracePayloadsEnabled: z.boolean(),
    diagnosticsUploadEnabled: z.boolean(),
    cloudSyncEnabled: z.boolean(),
  }),
);

const cloudSyncSettingsSchema = z.preprocess(
  (value) =>
    normalizeCloudSyncSettings(isRecord(value) ? (value as PersistedCloudSyncSettings) : undefined),
  z.object({
    enabled: z.boolean(),
    provider: z.enum(["custom", "none"]),
    endpoint: z.string().optional(),
    syncSettings: z.boolean(),
    syncWorkspaceMetadata: z.boolean(),
    syncThreads: z.boolean(),
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
        archivedChatsAutoDeleteDays: z
          .preprocess(
            (value) =>
              typeof value === "number" && Number.isFinite(value)
                ? Math.max(0, Math.floor(value))
                : 0,
            z.number().int().nonnegative(),
          )
          .optional(),
        quickChat: z
          .object({
            iconEnabled: z
              .preprocess((value) => (typeof value === "boolean" ? value : true), z.boolean())
              .optional(),
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
        sidebarSectionOrder: z
          .preprocess(
            (value) => normalizeSidebarSectionOrder(Array.isArray(value) ? value : undefined),
            z.array(z.enum(["projects", "chats"])),
          )
          .optional(),
      })
      .optional(),
    privacyTelemetrySettings: privacyTelemetrySettingsSchema.optional(),
    cloudSync: cloudSyncSettingsSchema.optional(),
    desktopFeatureFlagOverrides: z.preprocess(
      (value) => normalizeDesktopFeatureFlagOverrides(value),
      z
        .object({
          menuBar: z.boolean().optional(),
          remoteAccess: z.boolean().optional(),
          workspacePicker: z.boolean().optional(),
          workspaceLifecycle: z.boolean().optional(),
          openAiNativeConnectors: z.boolean().optional(),
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
      privacyTelemetrySettings: state.privacyTelemetrySettings,
      cloudSync: state.cloudSync,
      desktopFeatureFlagOverrides: state.desktopFeatureFlagOverrides,
      providerState,
      providerUiState,
      onboarding,
    };
  });

type HydratedPersistedDesktopState = z.infer<typeof persistedStateSchema>;

function hydratePersistedDesktopState(value: unknown): HydratedPersistedDesktopState {
  const parsed = persistedStateSchema.parse(value);
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
  const selectedWorkspaceId =
    normalizedUi.selectedWorkspaceId &&
    workspaces.some((workspace) => workspace.id === normalizedUi.selectedWorkspaceId)
      ? normalizedUi.selectedWorkspaceId
      : fallbackSelectedWorkspaceId;
  // When the Tasks feature is disabled — including packaged builds that ignore a
  // stale dev override — never resolve into task context. This is the single
  // invariant that keeps `view` out of "task" so the App/PrimaryContent task
  // branches stay unreachable.
  const tasksEnabled = desktopFeatures.tasks === true;
  const threadSelectionIntent = tasksEnabled
    ? getThreadSelectionIntent(
        normalizedUi.view,
        normalizedUi.lastNonSettingsView,
        normalizedUi.selectedTaskId,
      )
    : ({ context: "chat", selectedTaskId: null } as const);
  const workspaceThreads = selectedWorkspaceId
    ? threads
        .filter((thread) => {
          if (thread.workspaceId !== selectedWorkspaceId) return false;
          if (threadSelectionIntent.context === "task") {
            return Boolean(
              threadSelectionIntent.selectedTaskId &&
                thread.taskId === threadSelectionIntent.selectedTaskId,
            );
          }
          return isStandardChatThread(thread, { includeDrafts: true });
        })
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
  const rawLastNonSettingsView =
    normalizedUi.lastNonSettingsView && normalizedUi.lastNonSettingsView !== "settings"
      ? normalizedUi.lastNonSettingsView
      : fallbackLastNonSettingsView;
  const lastNonSettingsView =
    !tasksEnabled && rawLastNonSettingsView === "task" ? "chat" : rawLastNonSettingsView;
  const normalizedView = normalizedUi.view ?? "chat";
  const view = !tasksEnabled && normalizedView === "task" ? "chat" : normalizedView;

  return {
    selectedWorkspaceId,
    selectedThreadId,
    selectedTaskId: threadSelectionIntent.selectedTaskId,
    view,
    settingsPage: normalizeSettingsPageId(normalizedUi.settingsPage, desktopFeatures),
    lastNonSettingsView,
    sidebarCollapsed: normalizedUi.sidebarCollapsed ?? false,
    sidebarWidth: normalizedUi.sidebarWidth ?? 248,
    contextSidebarCollapsed: normalizedUi.contextSidebarCollapsed ?? false,
    contextSidebarWidth: normalizedUi.contextSidebarWidth ?? 300,
    canvasSidebarWidth: normalizedUi.canvasSidebarWidth ?? 500,
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
  if (parsed?.type !== "session_snapshot" || parsed.snapshot.sessionId !== sessionId) {
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
  runAfterNextPaintOrTimeout(task);
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
      selectedTaskId: ui.selectedTaskId,
      providerStatusByName: state.providerState?.statusByName ?? {},
      providerStatusLastUpdatedAt: state.providerState?.statusLastUpdatedAt ?? null,
      providerConnected: connectedProviders,
      providerUiState: state.providerUiState,
      developerMode: state.developerMode,
      showHiddenFiles: state.showHiddenFiles,
      perWorkspaceSettings: state.perWorkspaceSettings,
      desktopSettings: normalizeDesktopSettings(state.desktopSettings),
      privacyTelemetrySettings: normalizePrivacyTelemetrySettings(state.privacyTelemetrySettings),
      cloudSync: normalizeCloudSyncSettings(state.cloudSync),
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
      canvasSidebarWidth: ui.canvasSidebarWidth,
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
  | "setQuickChatIconEnabled"
  | "setArchivedChatsAutoDeleteDays"
  | "setQuickChatShortcutEnabled"
  | "setQuickChatShortcutAccelerator"
  | "setSidebarSectionOrder"
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
            selectedTaskId: get().selectedTaskId,
            view: get().view,
            settingsPage: get().settingsPage,
            lastNonSettingsView: get().lastNonSettingsView,
            sidebarCollapsed: get().sidebarCollapsed,
            sidebarWidth: get().sidebarWidth,
            contextSidebarCollapsed: get().contextSidebarCollapsed,
            contextSidebarWidth: get().contextSidebarWidth,
            canvasSidebarWidth: get().canvasSidebarWidth,
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

        const startupOnboarding = resolveStartupOnboarding({
          ...onboardingOpts,
          demoMode: isDesktopDemoMode(),
          nowIso,
        });
        const resolvedOnboarding = startupOnboarding.onboardingState;
        const autoOpen = startupOnboarding.visible;

        const resolvedDesktopSettings = normalizeDesktopSettings(state.desktopSettings);
        const autoDeleteDays = resolvedDesktopSettings.archivedChatsAutoDeleteDays;
        let finalThreads = state.threads;

        if (autoDeleteDays && autoDeleteDays > 0) {
          const nowMs = Date.now();
          const thresholdMs = autoDeleteDays * 24 * 60 * 60 * 1000;
          const remainingThreads: typeof state.threads = [];
          for (const thread of state.threads) {
            if (thread.archived && thread.archivedAt) {
              const archivedTime = Date.parse(thread.archivedAt);
              if (Number.isFinite(archivedTime) && nowMs - archivedTime > thresholdMs) {
                const transcriptIds = [
                  thread.legacyTranscriptId ?? null,
                  thread.sessionId ?? null,
                  thread.id,
                ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
                for (const transcriptId of new Set(transcriptIds)) {
                  try {
                    await deleteTranscript({ threadId: transcriptId });
                  } catch {
                    // ignore
                  }
                }
                continue;
              }
            }
            remainingThreads.push(thread);
          }
          finalThreads = remainingThreads;
        }

        set({
          workspaces: state.workspaces,
          threads: finalThreads,
          selectedWorkspaceId: ui.selectedWorkspaceId,
          selectedThreadId: ui.selectedThreadId,
          selectedTaskId: ui.selectedTaskId,
          providerStatusByName: state.providerState?.statusByName ?? {},
          providerStatusLastUpdatedAt: state.providerState?.statusLastUpdatedAt ?? null,
          providerConnected: connectedProviders,
          providerUiState: state.providerUiState,
          developerMode: state.developerMode,
          showHiddenFiles: state.showHiddenFiles,
          perWorkspaceSettings: state.perWorkspaceSettings,
          desktopSettings: normalizeDesktopSettings(state.desktopSettings),
          privacyTelemetrySettings: normalizePrivacyTelemetrySettings(
            state.privacyTelemetrySettings,
          ),
          cloudSync: normalizeCloudSyncSettings(state.cloudSync),
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
          canvasSidebarWidth: ui.canvasSidebarWidth,
          messageBarHeight: ui.messageBarHeight,
        });

        // Persist backfilled onboarding status if we changed it.
        if (startupOnboarding.shouldPersist) {
          void persistNow(get);
        } else {
          syncDesktopStateCacheNow(get);
        }

        const startupSelectionContext = getThreadSelectionContext(ui.view, ui.lastNonSettingsView);

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
        } else if (ui.selectedWorkspaceId && startupSelectionContext === "task") {
          const startupWorkspaceId = ui.selectedWorkspaceId;
          const startupTaskId = ui.selectedTaskId;
          const preserveStartupView = ui.view === "settings";
          runAfterInitialPaint(() => {
            const current = get();
            if (
              current.selectedWorkspaceId !== startupWorkspaceId ||
              current.selectedTaskId !== startupTaskId ||
              getThreadSelectionContext(current.view, current.lastNonSettingsView) !== "task"
            ) {
              return;
            }
            void current.refreshTasks(startupWorkspaceId).then(() => {
              const refreshed = get();
              if (
                refreshed.selectedWorkspaceId !== startupWorkspaceId ||
                refreshed.selectedTaskId !== startupTaskId ||
                getThreadSelectionContext(refreshed.view, refreshed.lastNonSettingsView) !== "task"
              ) {
                return;
              }
              if (!startupTaskId) {
                return;
              }
              const taskExists = (
                refreshed.taskSummariesByWorkspaceId[startupWorkspaceId] ?? []
              ).some((task) => task.id === startupTaskId);
              if (taskExists) {
                void refreshed.selectTask(startupTaskId, { preserveView: preserveStartupView });
                return;
              }
              set({ selectedTaskId: null, selectedThreadId: null });
              syncDesktopStateCacheNow(get);
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
        settingsPage: normalizeSettingsPageId(
          page ?? s.settingsPage,
          s.desktopFeatureFlags,
          s.updateState.packaged || isPackagedDesktopApp(),
        ),
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
        settingsPage: normalizeSettingsPageId(
          page,
          state.desktopFeatureFlags,
          state.updateState.packaged || isPackagedDesktopApp(),
        ),
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
        const selected = state.selectedWorkspaceId
          ? (state.workspaces.find((w) => w.id === state.selectedWorkspaceId) ?? null)
          : null;
        const source =
          (selected?.workspaceKind === "oneOffChat" ? null : selected) ??
          state.workspaces.find((w) => w.workspaceKind !== "oneOffChat") ??
          selected ??
          state.workspaces[0];
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
            "defaultAdvancedMemory",
            "defaultMemoryGenerationModel",
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

    setQuickChatIconEnabled: (enabled) => {
      set((state) => ({
        desktopSettings: {
          ...state.desktopSettings,
          quickChat: {
            ...state.desktopSettings.quickChat,
            iconEnabled: enabled,
          },
        },
      }));
      void persistNow(get);
    },

    setArchivedChatsAutoDeleteDays: (days) => {
      set((state) => ({
        desktopSettings: {
          ...state.desktopSettings,
          archivedChatsAutoDeleteDays: days,
        },
      }));
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

    setSidebarSectionOrder: (orderedSections) => {
      set((state) => ({
        desktopSettings: {
          ...state.desktopSettings,
          sidebarSectionOrder: normalizeSidebarSectionOrder(orderedSections),
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
      set((state) => {
        // If Tasks was just turned off while a task is in view, eject back to
        // chat and drop the task selection so no TaskView can render.
        const clearTask =
          nextFeatureFlags.tasks !== true &&
          getThreadSelectionContext(state.view, state.lastNonSettingsView) === "task";
        return {
          desktopFeatureFlagOverrides: nextOverrides,
          desktopFeatureFlags: nextFeatureFlags,
          settingsPage: normalizeSettingsPageId(
            state.settingsPage,
            nextFeatureFlags,
            state.updateState.packaged || isPackagedDesktopApp(),
          ),
          ...(clearTask
            ? {
                view: state.view === "settings" ? state.view : "chat",
                lastNonSettingsView:
                  state.lastNonSettingsView === "task" ? "chat" : state.lastNonSettingsView,
                selectedTaskId: null,
              }
            : {}),
        };
      });
      await persistNow(get);
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
          updateState.packaged || isPackagedDesktopApp(),
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
      const state = get();
      const canvasEnabled = state.desktopFeatureFlags.canvas === true;
      const isCanvasSupported =
        state.filePreview?.path && isCanvasSupportedFile(state.filePreview.path);
      const isCanvasOpen = canvasEnabled && isCanvasSupported;

      if (isCanvasOpen) {
        set({ canvasSidebarWidth: Math.max(200, Math.min(900, width)) });
      } else {
        set({ contextSidebarWidth: Math.max(200, Math.min(600, width)) });
      }
      syncDesktopStateCache(get);
    },

    setMessageBarHeight: (height: number) => {
      set({ messageBarHeight: Math.max(80, Math.min(500, height)) });
      syncDesktopStateCache(get);
    },
  };
}
