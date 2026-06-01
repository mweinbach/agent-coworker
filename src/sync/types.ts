export type CloudSyncProviderId = "custom" | "none";

export type PersistedCloudSyncSettings = {
  enabled?: boolean;
  provider?: CloudSyncProviderId;
  endpoint?: string;
  syncSettings?: boolean;
  syncWorkspaceMetadata?: boolean;
  syncThreads?: boolean;
};

export type CloudSyncSettings = {
  enabled: boolean;
  provider: CloudSyncProviderId;
  endpoint?: string;
  syncSettings: boolean;
  syncWorkspaceMetadata: boolean;
  syncThreads: boolean;
};

export const CLOUD_SYNC_PAYLOAD_VERSION = 1 as const;
export const CLOUD_SYNC_SETTINGS_DEDUPE_KEY = "settings:v1" as const;

export const DEFAULT_CLOUD_SYNC_SETTINGS: CloudSyncSettings = {
  enabled: false,
  provider: "none",
  syncSettings: true,
  syncWorkspaceMetadata: false,
  syncThreads: false,
};

function normalizeCloudSyncEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    return trimmed.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

export type CloudSyncScope = "settings" | "workspaceMetadata" | "threads";

export type CloudSyncSettingsSnapshot = {
  version: typeof CLOUD_SYNC_PAYLOAD_VERSION;
  kind: "settings";
  privacyTelemetrySettings: {
    crashReportsEnabled: boolean;
    productAnalyticsEnabled: boolean;
    aiTraceTelemetryEnabled: boolean;
    aiTracePayloadsEnabled: boolean;
    diagnosticsUploadEnabled: boolean;
    cloudSyncEnabled: boolean;
  };
  desktopSettings: {
    quickChat: {
      iconEnabled: boolean;
      shortcutEnabled: boolean;
      shortcutAccelerator: string;
    };
    archivedChatsAutoDeleteDays: number;
    sidebarSectionOrder: Array<"projects" | "chats">;
  };
  desktopFeatureFlagOverrides: Record<string, boolean>;
  appPreferences: {
    developerMode: boolean;
    showHiddenFiles: boolean;
    perWorkspaceSettings: boolean;
  };
  providerUiState: {
    lmstudio: {
      enabled: boolean;
    };
  };
};

export type CloudSyncWorkspaceMetadataPayload = {
  version: typeof CLOUD_SYNC_PAYLOAD_VERSION;
  kind: "workspaceMetadata";
  workspaces: [];
  todo: "future-sanitized-workspace-metadata";
};

export type CloudSyncThreadPayload = {
  version: typeof CLOUD_SYNC_PAYLOAD_VERSION;
  kind: "threads";
  threads: [];
  todo: "future-e2ee-thread-sync";
};

export type CloudSyncPayload =
  | CloudSyncSettingsSnapshot
  | CloudSyncWorkspaceMetadataPayload
  | CloudSyncThreadPayload;

export type CloudSyncPatch = {
  version: typeof CLOUD_SYNC_PAYLOAD_VERSION;
  id: string;
  scope: CloudSyncScope;
  dedupeKey?: string;
  createdAt: string;
  payload: CloudSyncPayload;
};

export type CloudSyncRemoteState = {
  version: typeof CLOUD_SYNC_PAYLOAD_VERSION;
  scope: CloudSyncScope;
  cursor?: string;
  payload: CloudSyncPayload | null;
};

export type CloudSyncRemoteChange = {
  version: typeof CLOUD_SYNC_PAYLOAD_VERSION;
  id: string;
  scope: CloudSyncScope;
  cursor?: string;
  payload: CloudSyncPayload;
};

export type CloudSyncPullResult = {
  cursor?: string;
  changes: CloudSyncRemoteChange[];
};

export type CloudSyncHealth = {
  ok: boolean;
  status: "disabled" | "not_configured" | "connected" | "error";
  message?: string;
};

export type CloudSyncQueueEntry = {
  queueVersion: typeof CLOUD_SYNC_PAYLOAD_VERSION;
  patch: CloudSyncPatch;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
};

export type CloudSyncStatus = {
  status: "disabled" | "not_configured" | "queued" | "connected" | "error";
  queued: number;
  message?: string;
};

export function normalizeCloudSyncSettings(
  value?: PersistedCloudSyncSettings | null,
): CloudSyncSettings {
  const endpoint = normalizeCloudSyncEndpoint(value?.endpoint);
  return {
    enabled: value?.enabled === true,
    provider: value?.provider === "custom" ? "custom" : "none",
    ...(endpoint ? { endpoint } : {}),
    syncSettings: value?.syncSettings !== false,
    syncWorkspaceMetadata: value?.syncWorkspaceMetadata === true,
    syncThreads: value?.syncThreads === true,
  };
}
