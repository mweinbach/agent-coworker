import { z } from "zod";

import { FEATURE_FLAG_IDS } from "../shared/featureFlags";
import {
  DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR,
  normalizeQuickChatShortcutAccelerator,
} from "../shared/quickChatShortcut";
import {
  CLOUD_SYNC_PAYLOAD_VERSION,
  type CloudSyncPayload,
  type CloudSyncRemoteChange,
  type CloudSyncRemoteState,
  type CloudSyncScope,
  type CloudSyncSettingsSnapshot,
} from "./types";

const SIDEBAR_SECTIONS = ["projects", "chats"] as const;
const BODY_KEY_PATTERN =
  /(?:prompt|completion|transcript|messages|stdout|stderr|command|shell|file|contents|content|session|repo|path|workspace|credential|secret|token|api[_-]?key|password|cookie|auth|mcp)/i;
const PATH_LIKE_PATTERN =
  /(?:^~\/|^\/(?:Users|home|private|tmp|var|Volumes)(?:\/|$)|^[A-Za-z]:\\|\\(?:Users|Documents and Settings|ProgramData|Temp|tmp)\\|file:\/\/)/;
const SECRET_VALUE_PATTERN =
  /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9_]{16,}|\bxox[baprs]-[A-Za-z0-9-]{16,}|\bAKIA[0-9A-Z]{16})/i;
const SAFE_ALLOWLIST_KEYS = new Set([
  "crashReportsEnabled",
  "perWorkspaceSettings",
  "showHiddenFiles",
  "workspaceLifecycle",
  "workspacePicker",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function sidebarSectionOrder(value: unknown): Array<"projects" | "chats"> {
  const seen = new Set<(typeof SIDEBAR_SECTIONS)[number]>();
  const output: Array<"projects" | "chats"> = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if ((entry === "projects" || entry === "chats") && !seen.has(entry)) {
        seen.add(entry);
        output.push(entry);
      }
    }
  }
  for (const section of SIDEBAR_SECTIONS) {
    if (!seen.has(section)) output.push(section);
  }
  return output;
}

function featureFlagOverrides(value: unknown): Record<string, boolean> {
  const source = isRecord(value) ? value : {};
  const output: Record<string, boolean> = {};
  for (const flagId of FEATURE_FLAG_IDS) {
    const flagValue = source[flagId];
    if (typeof flagValue === "boolean") output[flagId] = flagValue;
  }
  return output;
}

function containsUnsafeText(value: string): boolean {
  return PATH_LIKE_PATTERN.test(value) || SECRET_VALUE_PATTERN.test(value);
}

function containsUnsafePayload(value: unknown, key = ""): boolean {
  if (key && BODY_KEY_PATTERN.test(key) && !SAFE_ALLOWLIST_KEYS.has(key)) return true;
  if (typeof value === "string") return containsUnsafeText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return false;
  if (value === undefined) return false;
  if (Array.isArray(value)) {
    return value.some((entry) => containsUnsafePayload(entry));
  }
  if (!isRecord(value)) return true;
  return Object.entries(value).some(([entryKey, entryValue]) =>
    containsUnsafePayload(entryValue, entryKey),
  );
}

export function buildCloudSyncSettingsSnapshot(state: unknown): CloudSyncSettingsSnapshot {
  const source = isRecord(state) ? state : {};
  const privacy = isRecord(source.privacyTelemetrySettings) ? source.privacyTelemetrySettings : {};
  const desktopSettings = isRecord(source.desktopSettings) ? source.desktopSettings : {};
  const quickChat = isRecord(desktopSettings.quickChat) ? desktopSettings.quickChat : {};
  const providerUiState = isRecord(source.providerUiState) ? source.providerUiState : {};
  const lmstudio = isRecord(providerUiState.lmstudio) ? providerUiState.lmstudio : {};

  return {
    version: CLOUD_SYNC_PAYLOAD_VERSION,
    kind: "settings",
    privacyTelemetrySettings: {
      crashReportsEnabled: booleanValue(privacy.crashReportsEnabled),
      productAnalyticsEnabled: booleanValue(privacy.productAnalyticsEnabled),
      aiTraceTelemetryEnabled: booleanValue(privacy.aiTraceTelemetryEnabled),
      aiTracePayloadsEnabled:
        booleanValue(privacy.aiTraceTelemetryEnabled) &&
        booleanValue(privacy.aiTracePayloadsEnabled),
      diagnosticsUploadEnabled: booleanValue(privacy.diagnosticsUploadEnabled),
      cloudSyncEnabled: false,
    },
    desktopSettings: {
      quickChat: {
        iconEnabled: quickChat.iconEnabled !== false,
        shortcutEnabled: quickChat.shortcutEnabled === true,
        shortcutAccelerator: normalizeQuickChatShortcutAccelerator(
          typeof quickChat.shortcutAccelerator === "string"
            ? quickChat.shortcutAccelerator
            : DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR,
        ),
      },
      archivedChatsAutoDeleteDays: nonNegativeInteger(desktopSettings.archivedChatsAutoDeleteDays),
      sidebarSectionOrder: sidebarSectionOrder(desktopSettings.sidebarSectionOrder),
    },
    desktopFeatureFlagOverrides: featureFlagOverrides(source.desktopFeatureFlagOverrides),
    appPreferences: {
      developerMode: source.developerMode === true,
      showHiddenFiles: source.showHiddenFiles === true,
      perWorkspaceSettings: source.perWorkspaceSettings === true,
    },
    providerUiState: {
      lmstudio: {
        enabled: lmstudio.enabled === true,
      },
    },
  };
}

const settingsSnapshotSchema = z
  .object({
    version: z.literal(CLOUD_SYNC_PAYLOAD_VERSION),
    kind: z.literal("settings"),
    privacyTelemetrySettings: z
      .object({
        crashReportsEnabled: z.boolean().optional(),
        productAnalyticsEnabled: z.boolean().optional(),
        aiTraceTelemetryEnabled: z.boolean().optional(),
        aiTracePayloadsEnabled: z.boolean().optional(),
        diagnosticsUploadEnabled: z.boolean().optional(),
        cloudSyncEnabled: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    desktopSettings: z
      .object({
        quickChat: z
          .object({
            iconEnabled: z.boolean().optional(),
            shortcutEnabled: z.boolean().optional(),
            shortcutAccelerator: z.string().optional(),
          })
          .passthrough()
          .optional(),
        archivedChatsAutoDeleteDays: z.number().optional(),
        sidebarSectionOrder: z.array(z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
    desktopFeatureFlagOverrides: z.record(z.string(), z.unknown()).optional(),
    appPreferences: z
      .object({
        developerMode: z.boolean().optional(),
        showHiddenFiles: z.boolean().optional(),
        perWorkspaceSettings: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    providerUiState: z
      .object({
        lmstudio: z
          .object({
            enabled: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function sanitizeCloudSyncPayload(value: unknown): CloudSyncPayload | null {
  const parsedSettings = settingsSnapshotSchema.safeParse(value);
  if (parsedSettings.success) {
    const snapshot = buildCloudSyncSettingsSnapshot(parsedSettings.data);
    return containsUnsafePayload(snapshot) ? null : snapshot;
  }
  if (!isRecord(value) || value.version !== CLOUD_SYNC_PAYLOAD_VERSION) return null;
  if (value.kind === "workspaceMetadata") {
    return {
      version: CLOUD_SYNC_PAYLOAD_VERSION,
      kind: "workspaceMetadata",
      workspaces: [],
      todo: "future-sanitized-workspace-metadata",
    };
  }
  if (value.kind === "threads") {
    return {
      version: CLOUD_SYNC_PAYLOAD_VERSION,
      kind: "threads",
      threads: [],
      todo: "future-e2ee-thread-sync",
    };
  }
  return null;
}

function normalizeScope(value: unknown): CloudSyncScope | null {
  if (value === "settings" || value === "workspaceMetadata" || value === "threads") return value;
  return null;
}

export function parseCloudSyncRemoteState(value: unknown): CloudSyncRemoteState | null {
  if (!isRecord(value) || value.version !== CLOUD_SYNC_PAYLOAD_VERSION) return null;
  const scope = normalizeScope(value.scope);
  if (!scope) return null;
  const payload =
    value.payload === null || value.payload === undefined
      ? null
      : sanitizeCloudSyncPayload(value.payload);
  if (value.payload !== null && value.payload !== undefined && !payload) return null;
  return {
    version: CLOUD_SYNC_PAYLOAD_VERSION,
    scope,
    ...(typeof value.cursor === "string" && value.cursor.trim()
      ? { cursor: value.cursor.trim() }
      : {}),
    payload,
  };
}

export function parseCloudSyncRemoteChange(value: unknown): CloudSyncRemoteChange | null {
  if (!isRecord(value) || value.version !== CLOUD_SYNC_PAYLOAD_VERSION) return null;
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : null;
  const scope = normalizeScope(value.scope);
  const payload = sanitizeCloudSyncPayload(value.payload);
  if (!id || !scope || !payload) return null;
  return {
    version: CLOUD_SYNC_PAYLOAD_VERSION,
    id,
    scope,
    ...(typeof value.cursor === "string" && value.cursor.trim()
      ? { cursor: value.cursor.trim() }
      : {}),
    payload,
  };
}

export function containsForbiddenCloudSyncData(value: unknown): boolean {
  return containsUnsafePayload(value);
}
