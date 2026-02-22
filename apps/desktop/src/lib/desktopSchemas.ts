import { z } from "zod";

import type {
  ConfirmActionInput,
  ContextMenuItem,
  CopyPathInput,
  CreateDirectoryInput,
  DeleteTranscriptInput,
  DesktopMenuCommand,
  DesktopNotificationInput,
  ListDirectoryInput,
  OpenPathInput,
  ReadTranscriptInput,
  RenamePathInput,
  RevealPathInput,
  SetWindowAppearanceInput,
  ShowContextMenuInput,
  StartWorkspaceServerInput,
  StopWorkspaceServerInput,
  SystemAppearance,
  TranscriptBatchInput,
  TrashPathInput,
} from "./desktopApi";
import type { PersistedState } from "../app/types";

const SAFE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const invalidPathSegmentPattern = /[/\\\0]/;

const nonEmptyStringSchema = z.string().trim().min(1);
const optionalNonEmptyStringSchema = nonEmptyStringSchema.optional();
const safeIdSchema = nonEmptyStringSchema.regex(SAFE_ID, "contains invalid characters");
const directionSchema = z.enum(["server", "client"]);

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
});

export const showContextMenuInputSchema: z.ZodType<ShowContextMenuInput> = z.object({
  items: z.array(contextMenuItemSchema),
});

export const listDirectoryInputSchema: z.ZodType<ListDirectoryInput> = z.object({
  path: nonEmptyStringSchema,
  includeHidden: z.boolean().optional(),
});

export const openPathInputSchema: z.ZodType<OpenPathInput> = sharedPathSchema;
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

export const persistedStateInputSchema: z.ZodType<PersistedState> = z.object({
  workspaces: z.array(z.unknown()),
  threads: z.array(z.unknown()),
  developerMode: z.boolean().optional(),
  showHiddenFiles: z.boolean().optional(),
  version: z.number().optional(),
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
]);

export const systemAppearanceSchema: z.ZodType<SystemAppearance> = z.object({
  platform: z.enum(["darwin", "linux", "win32", "aix", "freebsd", "openbsd", "sunos", "android"]),
  themeSource: z.enum(["system", "light", "dark"]),
  shouldUseDarkColors: z.boolean(),
  shouldUseHighContrastColors: z.boolean(),
  shouldUseInvertedColorScheme: z.boolean(),
  prefersReducedTransparency: z.boolean(),
  inForcedColorsMode: z.boolean(),
});
