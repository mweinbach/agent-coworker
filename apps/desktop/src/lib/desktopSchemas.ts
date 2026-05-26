import { z } from "zod";

import {
  CODEX_WEB_SEARCH_BACKEND_VALUES,
  CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES,
  CODEX_WEB_SEARCH_MODE_VALUES,
  GOOGLE_THINKING_LEVEL_VALUES,
  LOCAL_WEB_SEARCH_PROVIDER_VALUES,
  OPENAI_REASONING_EFFORT_VALUES,
  OPENAI_REASONING_SUMMARY_VALUES,
  OPENAI_TEXT_VERBOSITY_VALUES,
} from "../../../../src/shared/openaiCompatibleOptions";
import type { PersistedState } from "../app/types";
import type {
  ConfirmActionInput,
  ContextMenuItem,
  CopyPathInput,
  CreateDirectoryInput,
  CreateOneOffChatWorkspaceInput,
  DeleteTranscriptInput,
  DesktopMenuCommand,
  DesktopNotificationInput,
  ListDirectoryInput,
  MobileRelayForgetTrustedPhoneInput,
  MobileRelayStartInput,
  MobileRelayUpdateTrustedPhonePermissionsInput,
  OpenExternalUrlInput,
  OpenPathInput,
  PreferredFileAppInput,
  PreviewOSFileInput,
  ReadFileForPreviewInput,
  ReadFileInput,
  ReadTranscriptInput,
  RenamePathInput,
  RevealPathInput,
  SaveExportedFileInput,
  SetWindowAppearanceInput,
  ShowCanvasWindowInput,
  ShowContextMenuInput,
  ShowQuickChatWindowInput,
  StartWorkspaceServerInput,
  StopWorkspaceServerInput,
  SystemAppearance,
  TranscriptBatchInput,
  TrashPathInput,
  UpdaterProgress,
  UpdaterReleaseInfo,
  UpdaterState,
  WindowDragPointInput,
  WriteFileInput,
} from "./desktopApi";
import { normalizeQuickChatShortcutAccelerator } from "./quickChatShortcut";

const SAFE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const invalidPathSegmentPattern = /[/\\\0]/;

const nonEmptyStringSchema = z.string().trim().min(1);
const optionalNonEmptyStringSchema = nonEmptyStringSchema.optional();
const optionalStringSchema = z.preprocess(
  (value) => (typeof value === "string" ? value : undefined),
  z.string().optional(),
);
const sidebarSectionKeys = ["projects", "chats"] as const;
type SidebarSectionKey = (typeof sidebarSectionKeys)[number];
function normalizePersistedSidebarSectionOrder(value: unknown): SidebarSectionKey[] {
  const seen = new Set<SidebarSectionKey>();
  const ordered: SidebarSectionKey[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry !== "projects" && entry !== "chats") {
        continue;
      }
      if (seen.has(entry)) {
        continue;
      }
      seen.add(entry);
      ordered.push(entry);
    }
  }
  for (const key of sidebarSectionKeys) {
    if (!seen.has(key)) {
      ordered.push(key);
    }
  }
  return ordered;
}
const safeIdSchema = nonEmptyStringSchema.regex(SAFE_ID, "contains invalid characters");
const directionSchema = z.enum(["server", "client"]);
const reasoningEffortSchema = z.enum(OPENAI_REASONING_EFFORT_VALUES);
const reasoningSummarySchema = z.enum(OPENAI_REASONING_SUMMARY_VALUES);
const textVerbositySchema = z.enum(OPENAI_TEXT_VERBOSITY_VALUES);
const webSearchBackendSchema = z.enum(CODEX_WEB_SEARCH_BACKEND_VALUES);
const webSearchModeSchema = z.enum(CODEX_WEB_SEARCH_MODE_VALUES);
const webSearchContextSizeSchema = z.enum(CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES);
const mobileRelayTrustedDevicePermissionKeys = [
  "turns",
  "serverRequests",
  "providerAuth",
  "mcpAuth",
  "workspaceSettings",
  "backups",
] as const;

const contextMenuItemSchema: z.ZodType<ContextMenuItem> = z.object({
  id: safeIdSchema,
  label: nonEmptyStringSchema,
  enabled: z.boolean().optional(),
});

const sharedPathSchema = z.object({
  path: nonEmptyStringSchema,
});

const validatedSegmentSchema = nonEmptyStringSchema.refine(
  (value) => !invalidPathSegmentPattern.test(value) && value !== "." && value !== "..",
  "invalid path segment",
);

const providerOptionsSchema = z
  .object({
    reasoningEffort: reasoningEffortSchema.optional(),
    reasoningSummary: reasoningSummarySchema.optional(),
    textVerbosity: textVerbositySchema.optional(),
  })
  .strict();

const codexWebSearchLocationSchema = z
  .object({
    country: z.string().trim().min(1).optional(),
    region: z.string().trim().min(1).optional(),
    city: z.string().trim().min(1).optional(),
    timezone: z.string().trim().min(1).optional(),
  })
  .strict();

const codexCliProviderOptionsSchema = providerOptionsSchema
  .extend({
    webSearchBackend: webSearchBackendSchema.optional(),
    webSearchFallbackBackend: z.enum(LOCAL_WEB_SEARCH_PROVIDER_VALUES).optional(),
    webSearchMode: webSearchModeSchema.optional(),
    webSearch: z
      .object({
        contextSize: webSearchContextSizeSchema.optional(),
        allowedDomains: z.array(z.string().trim().min(1)).optional(),
        location: codexWebSearchLocationSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const googleProviderOptionsSchema = z
  .object({
    nativeWebSearch: z.boolean().optional(),
    thinkingConfig: z
      .object({
        thinkingLevel: z.enum(GOOGLE_THINKING_LEVEL_VALUES).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const workspaceProviderOptionsSchema = z
  .object({
    openai: providerOptionsSchema.optional(),
    "codex-cli": codexCliProviderOptionsSchema.optional(),
    google: googleProviderOptionsSchema.optional(),
    lmstudio: z
      .object({
        baseUrl: z.string().trim().min(1).optional(),
        contextLength: z.number().int().positive().optional(),
        autoLoad: z.boolean().optional(),
        reloadOnContextMismatch: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const desktopFeatureFlagOverridesSchema = z
  .object({
    menuBar: z.preprocess(
      (value) => (typeof value === "boolean" ? value : undefined),
      z.boolean().optional(),
    ),
    remoteAccess: z.preprocess(
      (value) => (typeof value === "boolean" ? value : undefined),
      z.boolean().optional(),
    ),
    workspacePicker: z.preprocess(
      (value) => (typeof value === "boolean" ? value : undefined),
      z.boolean().optional(),
    ),
    workspaceLifecycle: z.preprocess(
      (value) => (typeof value === "boolean" ? value : undefined),
      z.boolean().optional(),
    ),
    a2ui: z.preprocess(
      (value) => (typeof value === "boolean" ? value : undefined),
      z.boolean().optional(),
    ),
    openAiNativeConnectors: z.preprocess(
      (value) => (typeof value === "boolean" ? value : undefined),
      z.boolean().optional(),
    ),
  })
  .passthrough()
  .optional();

export const startWorkspaceServerInputSchema: z.ZodType<StartWorkspaceServerInput> = z.object({
  workspaceId: safeIdSchema,
  workspacePath: nonEmptyStringSchema,
  yolo: z.boolean(),
  featureFlags: desktopFeatureFlagOverridesSchema.optional(),
});

export const createOneOffChatWorkspaceInputSchema: z.ZodType<CreateOneOffChatWorkspaceInput> =
  z.object({
    titleHint: z.string().trim().optional(),
  });

export const stopWorkspaceServerInputSchema: z.ZodType<StopWorkspaceServerInput> = z.object({
  workspaceId: safeIdSchema,
});

export const readTranscriptInputSchema: z.ZodType<ReadTranscriptInput> = z.object({
  threadId: safeIdSchema,
});

export const deleteTranscriptInputSchema: z.ZodType<DeleteTranscriptInput> = z.object({
  threadId: safeIdSchema,
});

export const transcriptBatchInputSchema: z.ZodType<TranscriptBatchInput> = z.object({
  ts: nonEmptyStringSchema,
  threadId: safeIdSchema,
  direction: directionSchema,
  payload: z.unknown(),
}) as z.ZodType<TranscriptBatchInput>;

export const showContextMenuInputSchema: z.ZodType<ShowContextMenuInput> = z.object({
  items: z.array(contextMenuItemSchema),
});

export const windowDragPointInputSchema: z.ZodType<WindowDragPointInput> = z.object({
  screenX: z.number().finite(),
  screenY: z.number().finite(),
});

export const showCanvasWindowInputSchema: z.ZodType<ShowCanvasWindowInput> = z.object({
  path: nonEmptyStringSchema,
});

export const showQuickChatWindowInputSchema: z.ZodType<ShowQuickChatWindowInput> = z.object({
  threadId: safeIdSchema.optional(),
  newThread: z.boolean().optional(),
});

export const listDirectoryInputSchema: z.ZodType<ListDirectoryInput> = z.object({
  path: nonEmptyStringSchema,
  includeHidden: z.boolean().optional(),
});

export const openPathInputSchema: z.ZodType<OpenPathInput> = sharedPathSchema;
export const saveExportedFileInputSchema: z.ZodType<SaveExportedFileInput> = z.object({
  sourcePath: nonEmptyStringSchema,
  defaultFileName: validatedSegmentSchema,
});
export const preferredFileAppInputSchema: z.ZodType<PreferredFileAppInput> = sharedPathSchema;
export const openExternalUrlInputSchema: z.ZodType<OpenExternalUrlInput> = z.object({
  url: nonEmptyStringSchema.refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:"
      );
    } catch {
      return false;
    }
  }, "URL must use http:, https:, or mailto: scheme"),
});
export const previewOSFileInputSchema: z.ZodType<PreviewOSFileInput> = sharedPathSchema;
export const readFileInputSchema: z.ZodType<ReadFileInput> = sharedPathSchema;
export const writeFileInputSchema: z.ZodType<WriteFileInput> = z.object({
  path: nonEmptyStringSchema,
  content: z.string(),
});

export const readFileForPreviewInputSchema: z.ZodType<ReadFileForPreviewInput> = z.object({
  path: nonEmptyStringSchema,
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024)
    .optional(),
});

export const revealPathInputSchema: z.ZodType<RevealPathInput> = sharedPathSchema;
export const copyPathInputSchema: z.ZodType<CopyPathInput> = sharedPathSchema;
export const trashPathInputSchema: z.ZodType<TrashPathInput> = sharedPathSchema;

export const createDirectoryInputSchema: z.ZodType<CreateDirectoryInput> = z.object({
  parentPath: nonEmptyStringSchema,
  name: validatedSegmentSchema,
});

export const renamePathInputSchema: z.ZodType<RenamePathInput> = z.object({
  path: nonEmptyStringSchema,
  newName: validatedSegmentSchema,
});

const persistedWorkspaceSchema = z
  .object({
    id: safeIdSchema,
    name: nonEmptyStringSchema,
    path: nonEmptyStringSchema,
    workspaceKind: z
      .preprocess(
        (value) => (value === "oneOffChat" ? "oneOffChat" : "project"),
        z.enum(["project", "oneOffChat"]),
      )
      .optional(),
    createdAt: nonEmptyStringSchema,
    lastOpenedAt: nonEmptyStringSchema,
    wsProtocol: z.preprocess(() => "jsonrpc", z.literal("jsonrpc")),
    defaultProvider: optionalNonEmptyStringSchema,
    defaultModel: optionalNonEmptyStringSchema,
    defaultPreferredChildModel: optionalNonEmptyStringSchema,
    defaultChildModelRoutingMode: z.enum(["same-provider", "cross-provider-allowlist"]).optional(),
    defaultPreferredChildModelRef: optionalNonEmptyStringSchema,
    defaultAllowedChildModelRefs: z.array(nonEmptyStringSchema).optional(),
    defaultToolOutputOverflowChars: z.preprocess((value) => {
      if (value === undefined) return undefined;
      if (value === null) return null;
      if (typeof value === "number" && Number.isFinite(value)) {
        return Math.max(0, Math.floor(value));
      }
      return undefined;
    }, z.number().int().nonnegative().nullable().optional()),
    providerOptions: workspaceProviderOptionsSchema.optional(),
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
    yolo: z.preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean()),
  })
  .passthrough();

const persistedThreadSchema = z
  .object({
    id: safeIdSchema,
    workspaceId: safeIdSchema,
    title: nonEmptyStringSchema,
    titleSource: z.enum(["default", "model", "heuristic", "manual"]).optional(),
    createdAt: nonEmptyStringSchema,
    lastMessageAt: nonEmptyStringSchema,
    status: z.enum(["active", "disconnected"]),
    sessionId: z.preprocess(
      (value) => (typeof value === "string" && value.trim() ? value : null),
      z.string().nullable(),
    ),
    messageCount: z.preprocess(
      (value) =>
        typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0,
      z.number().int().nonnegative(),
    ),
    lastEventSeq: z.preprocess(
      (value) =>
        typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0,
      z.number().int().nonnegative(),
    ),
    legacyTranscriptId: z
      .preprocess(
        (value) => (typeof value === "string" && value.trim() ? value : null),
        z.string().nullable(),
      )
      .optional(),
  })
  .passthrough();

const persistedOnboardingSchema = z
  .object({
    status: z.preprocess(
      (value) =>
        value === "pending" || value === "dismissed" || value === "completed" ? value : "pending",
      z.enum(["pending", "dismissed", "completed"]),
    ),
    completedAt: z.preprocess(
      (value) => (typeof value === "string" && value.trim() ? value : null),
      z.string().nullable(),
    ),
    dismissedAt: z.preprocess(
      (value) => (typeof value === "string" && value.trim() ? value : null),
      z.string().nullable(),
    ),
  })
  .optional();

const persistedProviderUiStateSchema = z
  .object({
    lmstudio: z
      .object({
        enabled: z.preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean()),
        hiddenModels: z.preprocess(
          (value) =>
            Array.isArray(value)
              ? value.filter((entry): entry is string => typeof entry === "string")
              : [],
          z.array(nonEmptyStringSchema),
        ),
      })
      .optional(),
    archivedChatsAutoDeleteDays: z
      .preprocess(
        (value) =>
          typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0,
        z.number().int().nonnegative(),
      )
      .optional(),
  })
  .optional();

const persistedDesktopSettingsSchema = z
  .object({
    archivedChatsAutoDeleteDays: z
      .preprocess(
        (value) =>
          typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0,
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
              typeof value === "string" ? normalizeQuickChatShortcutAccelerator(value) : undefined,
            z.string().optional(),
          )
          .optional(),
      })
      .optional(),
    sidebarSectionOrder: z
      .preprocess(
        (value) => normalizePersistedSidebarSectionOrder(value),
        z.array(z.enum(["projects", "chats"])),
      )
      .optional(),
  })
  .optional();

export const persistedStateInputSchema: z.ZodType<PersistedState> = z
  .object({
    workspaces: z.array(persistedWorkspaceSchema),
    threads: z.array(persistedThreadSchema),
    developerMode: z.preprocess(
      (value) => (typeof value === "boolean" ? value : false),
      z.boolean(),
    ),
    showHiddenFiles: z.preprocess(
      (value) => (typeof value === "boolean" ? value : false),
      z.boolean(),
    ),
    perWorkspaceSettings: z
      .preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean())
      .optional(),
    desktopSettings: persistedDesktopSettingsSchema,
    desktopFeatureFlagOverrides: desktopFeatureFlagOverridesSchema,
    version: z.preprocess(
      (value) =>
        typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 2,
      z.number().int().nonnegative(),
    ),
    providerUiState: persistedProviderUiStateSchema,
    onboarding: persistedOnboardingSchema,
  })
  .passthrough() as z.ZodType<PersistedState>;

export const confirmActionInputSchema: z.ZodType<ConfirmActionInput> = z.object({
  title: nonEmptyStringSchema,
  message: nonEmptyStringSchema,
  detail: optionalNonEmptyStringSchema,
  kind: z.enum(["none", "info", "warning", "error"]).optional(),
  confirmLabel: optionalNonEmptyStringSchema,
  cancelLabel: optionalNonEmptyStringSchema,
  defaultAction: z.enum(["confirm", "cancel"]).optional(),
});

export const desktopNotificationInputSchema: z.ZodType<DesktopNotificationInput> = z.object({
  title: nonEmptyStringSchema,
  body: optionalNonEmptyStringSchema,
  silent: z.boolean().optional(),
});

export const updaterProgressSchema: z.ZodType<UpdaterProgress> = z.object({
  percent: z.number().finite(),
  transferred: z.number().finite(),
  total: z.number().finite(),
  bytesPerSecond: z.number().finite(),
});

export const updaterReleaseInfoSchema: z.ZodType<UpdaterReleaseInfo> = z.object({
  version: nonEmptyStringSchema,
  releaseName: optionalNonEmptyStringSchema,
  releaseDate: optionalNonEmptyStringSchema,
  releaseNotes: optionalNonEmptyStringSchema,
  releasePageUrl: optionalNonEmptyStringSchema,
});

export const updaterStateSchema: z.ZodType<UpdaterState> = z.object({
  phase: z.enum([
    "disabled",
    "idle",
    "checking",
    "available",
    "downloading",
    "downloaded",
    "up-to-date",
    "error",
  ]),
  packaged: z.boolean(),
  currentVersion: nonEmptyStringSchema,
  lastCheckStartedAt: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  downloadedAt: z.string().nullable(),
  message: z.string().nullable(),
  error: z.string().nullable(),
  progress: updaterProgressSchema.nullable(),
  release: updaterReleaseInfoSchema.nullable(),
});

export const setWindowAppearanceInputSchema: z.ZodType<SetWindowAppearanceInput> = z.object({
  themeSource: z.enum(["system", "light", "dark"]).optional(),
  backgroundMaterial: z.enum(["auto", "none", "mica", "acrylic", "tabbed"]).optional(),
});

export const desktopMenuCommandSchema: z.ZodType<DesktopMenuCommand> = z.enum([
  "newThread",
  "toggleSidebar",
  "openSettings",
  "openWorkspacesSettings",
  "openResearch",
  "openSkills",
  "openUpdates",
]);

export const systemAppearanceSchema: z.ZodType<SystemAppearance> = z.object({
  platform: z.enum(["darwin", "linux", "win32", "aix", "freebsd", "openbsd", "sunos", "android"]),
  themeSource: z.enum(["system", "light", "dark"]),
  shouldUseDarkColors: z.boolean(),
  shouldUseDarkColorsForSystemIntegratedUI: z.boolean(),
  shouldUseHighContrastColors: z.boolean(),
  shouldUseInvertedColorScheme: z.boolean(),
  prefersReducedTransparency: z.boolean(),
  inForcedColorsMode: z.boolean(),
});

const h3MobileRelayPairingPayloadSchema = z.object({
  v: z.literal(1),
  scheme: z.literal("h3"),
  hosts: z.array(nonEmptyStringSchema).min(1),
  port: z.number().int().min(1).max(65535),
  certSha256: nonEmptyStringSchema,
  spkiSha256: nonEmptyStringSchema,
  identityPub: nonEmptyStringSchema,
  nonce: nonEmptyStringSchema,
  expiresAt: z.number().int().nonnegative(),
});

const mobileRelayPairingPayloadSchema = h3MobileRelayPairingPayloadSchema;

export const mobileRelayStartInputSchema: z.ZodType<MobileRelayStartInput> = z.object({
  workspaceId: safeIdSchema,
  workspacePath: nonEmptyStringSchema,
  yolo: z.boolean(),
  featureFlags: desktopFeatureFlagOverridesSchema.optional(),
});

const mobileRelayTrustedDevicePermissionsSchema = z.preprocess(
  (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {}),
  z.object({
    turns: z.boolean().optional().default(false),
    serverRequests: z.boolean().optional().default(false),
    providerAuth: z.boolean().optional().default(false),
    mcpAuth: z.boolean().optional().default(false),
    workspaceSettings: z.boolean().optional().default(false),
    backups: z.boolean().optional().default(false),
  }),
);

const mobileRelayTrustedPhoneDeviceSchema = z.object({
  deviceId: nonEmptyStringSchema,
  fingerprint: nonEmptyStringSchema,
  displayName: z.string().nullable(),
  lastPairedAt: z.string().nullable().optional().default(null),
  lastConnectedAt: z.string().nullable().optional().default(null),
  permissions: mobileRelayTrustedDevicePermissionsSchema,
});

export const mobileRelayForgetTrustedPhoneInputSchema: z.ZodType<MobileRelayForgetTrustedPhoneInput> =
  z
    .object({
      deviceId: optionalNonEmptyStringSchema,
    })
    .optional()
    .default({});

const mobileRelayTrustedDevicePermissionsPatchSchema = z
  .object(
    Object.fromEntries(
      mobileRelayTrustedDevicePermissionKeys.map((key) => [key, z.boolean().optional()]),
    ) as Record<
      (typeof mobileRelayTrustedDevicePermissionKeys)[number],
      z.ZodOptional<z.ZodBoolean>
    >,
  )
  .strict()
  .refine((value) => Object.values(value).some((entry) => typeof entry === "boolean"), {
    message: "must include at least one permission",
  });

export const mobileRelayUpdateTrustedPhonePermissionsInputSchema: z.ZodType<MobileRelayUpdateTrustedPhonePermissionsInput> =
  z.object({
    deviceId: nonEmptyStringSchema,
    permissions: mobileRelayTrustedDevicePermissionsPatchSchema,
  });

export const mobileRelayBridgeStateSchema = z.object({
  status: z.enum(["idle", "starting", "pairing", "connected", "reconnecting", "error"]),
  workspaceId: z.string().nullable(),
  workspacePath: z.string().nullable(),
  relaySource: z.enum(["direct", "remodex", "managed", "override", "unavailable"]),
  relaySourceMessage: z.string().nullable(),
  relayServiceStatus: z.enum(["unknown", "running", "not-running", "unavailable"]),
  relayServiceMessage: z.string().nullable(),
  relayServiceUpdatedAt: z.string().nullable(),
  relayUrl: z.string().nullable(),
  sessionId: z.string().nullable(),
  pairingPayload: mobileRelayPairingPayloadSchema.nullable(),
  trustedPhoneDeviceId: z.string().nullable(),
  trustedPhoneFingerprint: z.string().nullable(),
  trustedPhoneDevices: z.array(mobileRelayTrustedPhoneDeviceSchema).optional().default([]),
  directUrl: z.string().nullable(),
  ticketUrl: z.string().nullable(),
  certSha256: z.string().nullable(),
  spkiSha256: z.string().nullable(),
  hostHints: z.array(z.string()),
  lastError: z.string().nullable(),
});
