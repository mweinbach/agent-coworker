import { z } from "zod";

import {
  CODEX_WEB_SEARCH_BACKEND_VALUES,
  CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES,
  CODEX_WEB_SEARCH_MODE_VALUES,
  GOOGLE_THINKING_LEVEL_VALUES,
  OPENAI_REASONING_EFFORT_VALUES,
  OPENAI_REASONING_SUMMARY_VALUES,
  OPENAI_TEXT_VERBOSITY_VALUES,
} from "../../../../src/shared/openaiCompatibleOptions";
import type {
  ConfirmActionInput,
  ContextMenuItem,
  CopyPathInput,
  CreateDirectoryInput,
  DeleteTranscriptInput,
  DesktopMenuCommand,
  DesktopNotificationInput,
  ListDirectoryInput,
  OpenExternalUrlInput,
  OpenPathInput,
  PreviewOSFileInput,
  ReadFileInput,
  ReadTranscriptInput,
  RenamePathInput,
  RevealPathInput,
  SetWindowAppearanceInput,
  ShowContextMenuInput,
  StartWorkspaceServerInput,
  StopWorkspaceServerInput,
  SystemAppearance,
  TranscriptBatchInput,
  UpdaterProgress,
  UpdaterReleaseInfo,
  UpdaterState,
  TrashPathInput,
} from "./desktopApi";
import type { PersistedState } from "../app/types";

const SAFE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const invalidPathSegmentPattern = /[/\\\0]/;

const nonEmptyStringSchema = z.string().trim().min(1);
const optionalNonEmptyStringSchema = nonEmptyStringSchema.optional();
const optionalStringSchema = z.preprocess(
  (value) => (typeof value === "string" ? value : undefined),
  z.string().optional(),
);
const safeIdSchema = nonEmptyStringSchema.regex(SAFE_ID, "contains invalid characters");
const directionSchema = z.enum(["server", "client"]);
const reasoningEffortSchema = z.enum(OPENAI_REASONING_EFFORT_VALUES);
const reasoningSummarySchema = z.enum(OPENAI_REASONING_SUMMARY_VALUES);
const textVerbositySchema = z.enum(OPENAI_TEXT_VERBOSITY_VALUES);
const webSearchBackendSchema = z.enum(CODEX_WEB_SEARCH_BACKEND_VALUES);
const webSearchModeSchema = z.enum(CODEX_WEB_SEARCH_MODE_VALUES);
const webSearchContextSizeSchema = z.enum(CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES);

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

const providerOptionsSchema = z.object({
  reasoningEffort: reasoningEffortSchema.optional(),
  reasoningSummary: reasoningSummarySchema.optional(),
  textVerbosity: textVerbositySchema.optional(),
}).strict();

const codexWebSearchLocationSchema = z.object({
  country: z.string().trim().min(1).optional(),
  region: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  timezone: z.string().trim().min(1).optional(),
}).strict();

const codexCliProviderOptionsSchema = providerOptionsSchema.extend({
  webSearchBackend: webSearchBackendSchema.optional(),
  webSearchMode: webSearchModeSchema.optional(),
  webSearch: z.object({
    contextSize: webSearchContextSizeSchema.optional(),
    allowedDomains: z.array(z.string().trim().min(1)).optional(),
    location: codexWebSearchLocationSchema.optional(),
  }).strict().optional(),
}).strict();

const googleProviderOptionsSchema = z.object({
  nativeWebSearch: z.boolean().optional(),
  thinkingConfig: z.object({
    thinkingLevel: z.enum(GOOGLE_THINKING_LEVEL_VALUES).optional(),
  }).strict().optional(),
}).strict();

const workspaceProviderOptionsSchema = z.object({
  openai: providerOptionsSchema.optional(),
  "codex-cli": codexCliProviderOptionsSchema.optional(),
  google: googleProviderOptionsSchema.optional(),
  lmstudio: z.object({
    baseUrl: z.string().trim().min(1).optional(),
    contextLength: z.number().int().positive().optional(),
    autoLoad: z.boolean().optional(),
    reloadOnContextMismatch: z.boolean().optional(),
  }).strict().optional(),
}).strict();

export const startWorkspaceServerInputSchema: z.ZodType<StartWorkspaceServerInput> = z.object({
  workspaceId: safeIdSchema,
  workspacePath: nonEmptyStringSchema,
  yolo: z.boolean(),
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

export const listDirectoryInputSchema: z.ZodType<ListDirectoryInput> = z.object({
  path: nonEmptyStringSchema,
  includeHidden: z.boolean().optional(),
});

export const openPathInputSchema: z.ZodType<OpenPathInput> = sharedPathSchema;
export const openExternalUrlInputSchema: z.ZodType<OpenExternalUrlInput> = z.object({
  url: nonEmptyStringSchema,
});
export const previewOSFileInputSchema: z.ZodType<PreviewOSFileInput> = sharedPathSchema;
export const readFileInputSchema: z.ZodType<ReadFileInput> = sharedPathSchema;
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

const persistedWorkspaceSchema = z.object({
  id: safeIdSchema,
  name: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
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
  userProfile: z.object({
    instructions: optionalStringSchema,
    work: optionalStringSchema,
    details: optionalStringSchema,
  }).passthrough().optional(),
  defaultEnableMcp: z.preprocess((value) => (typeof value === "boolean" ? value : true), z.boolean()),
  defaultBackupsEnabled: z.preprocess((value) => (typeof value === "boolean" ? value : true), z.boolean()),
  yolo: z.preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean()),
}).passthrough();

const persistedThreadSchema = z.object({
  id: safeIdSchema,
  workspaceId: safeIdSchema,
  title: nonEmptyStringSchema,
  titleSource: z.enum(["default", "model", "heuristic", "manual"]).optional(),
  createdAt: nonEmptyStringSchema,
  lastMessageAt: nonEmptyStringSchema,
  status: z.enum(["active", "disconnected"]),
  sessionId: z.preprocess((value) => (typeof value === "string" && value.trim() ? value : null), z.string().nullable()),
  messageCount: z.preprocess(
    (value) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0),
    z.number().int().nonnegative(),
  ),
  lastEventSeq: z.preprocess(
    (value) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0),
    z.number().int().nonnegative(),
  ),
  legacyTranscriptId: z.preprocess((value) => (typeof value === "string" && value.trim() ? value : null), z.string().nullable()).optional(),
}).passthrough();

const persistedOnboardingSchema = z.object({
  status: z.preprocess(
    (value) => (value === "pending" || value === "dismissed" || value === "completed" ? value : "pending"),
    z.enum(["pending", "dismissed", "completed"]),
  ),
  completedAt: z.preprocess((value) => (typeof value === "string" && value.trim() ? value : null), z.string().nullable()),
  dismissedAt: z.preprocess((value) => (typeof value === "string" && value.trim() ? value : null), z.string().nullable()),
}).optional();

const persistedProviderUiStateSchema = z.object({
  lmstudio: z.object({
    enabled: z.preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean()),
    hiddenModels: z.preprocess(
      (value) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [],
      z.array(nonEmptyStringSchema),
    ),
  }).optional(),
}).optional();

export const persistedStateInputSchema: z.ZodType<PersistedState> = z.object({
  workspaces: z.array(persistedWorkspaceSchema),
  threads: z.array(persistedThreadSchema),
  developerMode: z.preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean()),
  showHiddenFiles: z.preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean()),
  perWorkspaceSettings: z.preprocess((value) => (typeof value === "boolean" ? value : false), z.boolean()).optional(),
  version: z.preprocess(
    (value) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 2),
    z.number().int().nonnegative(),
  ),
  providerUiState: persistedProviderUiStateSchema,
  onboarding: persistedOnboardingSchema,
}).passthrough() as z.ZodType<PersistedState>;

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
  phase: z.enum(["disabled", "idle", "checking", "available", "downloading", "downloaded", "up-to-date", "error"]),
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
