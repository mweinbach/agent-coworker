import {
  type CloudSyncProviderId,
  type CloudSyncStatus,
  normalizeCloudSyncSettings,
  type PersistedCloudSyncSettings,
} from "../sync/types";

export const NETWORK_TELEMETRY_KILL_SWITCH_ENV = "COWORK_DISABLE_NETWORK_TELEMETRY" as const;

export type TelemetryEnv = Record<string, string | undefined>;

export type TelemetryPackagingMode =
  | "local-dev"
  | "packaged-public"
  | "self-hosted"
  | "enterprise/offline";

export type TelemetrySurface =
  | "electron-main"
  | "electron-renderer"
  | "preload"
  | "renderer"
  | "cowork-server"
  | "server"
  | "harness";

export type PersistedPrivacyTelemetrySettings = {
  crashReportsEnabled?: boolean;
  productAnalyticsEnabled?: boolean;
  aiTraceTelemetryEnabled?: boolean;
  aiTracePayloadsEnabled?: boolean;
  diagnosticsUploadEnabled?: boolean;
  cloudSyncEnabled?: boolean;
};

export type PrivacyTelemetrySettings = {
  crashReportsEnabled: boolean;
  productAnalyticsEnabled: boolean;
  aiTraceTelemetryEnabled: boolean;
  aiTracePayloadsEnabled: boolean;
  diagnosticsUploadEnabled: boolean;
  cloudSyncEnabled: boolean;
};

export const DEFAULT_PRIVACY_TELEMETRY_SETTINGS: PrivacyTelemetrySettings = {
  crashReportsEnabled: false,
  productAnalyticsEnabled: false,
  aiTraceTelemetryEnabled: false,
  aiTracePayloadsEnabled: false,
  diagnosticsUploadEnabled: false,
  cloudSyncEnabled: false,
};

export type ResolvedTelemetryConsent = PrivacyTelemetrySettings & {
  mode: TelemetryPackagingMode;
  isPackaged: boolean;
  networkTelemetryDisabled: boolean;
};

type IntegrationStatus = "disabled" | "not_configured" | "enabled";
type AiTraceStatus = "disabled" | "not_configured" | "metadata_only" | "full_payload";
type DiagnosticsUploadStatus = "disabled" | "local_only" | "upload_configured";

export type ResolvedTelemetryConfig = {
  mode: TelemetryPackagingMode;
  isPackaged: boolean;
  surface: TelemetrySurface;
  appVersion: string | null;
  anonymousId: string | null;
  networkTelemetryDisabled: boolean;
  consent: ResolvedTelemetryConsent;
  crashReports: {
    enabled: boolean;
    status: IntegrationStatus;
    dsnConfigured: boolean;
    dsn: string | null;
    release: string | null;
    environment: string | null;
  };
  productAnalytics: {
    enabled: boolean;
    status: IntegrationStatus;
    keyConfigured: boolean;
    key: string | null;
    host: string | null;
    environment: string | null;
  };
  aiTraces: {
    enabled: boolean;
    status: AiTraceStatus;
    baseUrl: string | null;
    publicKey: string | null;
    hasSecretKey: boolean;
    secretKey?: string;
    tracingEnvironment: string | null;
    release: string | null;
    recordInputs: boolean;
    recordOutputs: boolean;
  };
  diagnosticsUpload: {
    enabled: boolean;
    status: DiagnosticsUploadStatus;
    uploadUrlConfigured: boolean;
    uploadUrl: string | null;
  };
};

export type ResolvedCloudSyncConfig = {
  enabled: boolean;
  provider: CloudSyncProviderId;
  endpoint?: string;
  token?: string;
  syncSettings: boolean;
  syncWorkspaceMetadata: boolean;
  syncThreads: boolean;
  status: "disabled" | "not_configured" | "connected" | "error";
  queued: number;
  message?: string;
  networkTelemetryDisabled: boolean;
};

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const DEFAULT_LANGFUSE_BASE_URL = "https://cloud.langfuse.com";
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

function defaultEnv(): TelemetryEnv {
  return typeof process === "object" && process?.env ? process.env : {};
}

function normalizeEnvValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseEnvBoolean(value: string | null | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return undefined;
}

function coalesceEnv(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = normalizeEnvValue(value);
    if (normalized) return normalized;
  }
  return null;
}

function normalizeUrl(value: string | null | undefined): string | null {
  const normalized = normalizeEnvValue(value);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function normalizePackagingMode(value: string | null | undefined): TelemetryPackagingMode | null {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "local-dev" ||
    normalized === "packaged-public" ||
    normalized === "self-hosted" ||
    normalized === "enterprise/offline"
  ) {
    return normalized;
  }
  return null;
}

function resolvePackagingMode(opts: {
  env: TelemetryEnv;
  isPackaged?: boolean;
  mode?: TelemetryPackagingMode | null;
}): TelemetryPackagingMode {
  if (opts.mode) return opts.mode;
  const fromEnv = normalizePackagingMode(opts.env.COWORK_TELEMETRY_MODE);
  if (fromEnv) return fromEnv;
  if (isNetworkTelemetryGloballyDisabled(opts.env)) return "enterprise/offline";
  return opts.isPackaged ? "packaged-public" : "local-dev";
}

function isLocalOptInMode(mode: TelemetryPackagingMode): boolean {
  return mode === "local-dev" || mode === "self-hosted";
}

function isRendererSurface(surface: TelemetrySurface): boolean {
  return surface === "electron-renderer" || surface === "renderer" || surface === "preload";
}

function resolveTracePayloadEnv(env: TelemetryEnv): boolean | undefined {
  const recordPayloads = parseEnvBoolean(env.AGENT_OBSERVABILITY_RECORD_PAYLOADS);
  if (recordPayloads !== undefined) return recordPayloads;
  const recordInputs = parseEnvBoolean(env.AGENT_OBSERVABILITY_RECORD_INPUTS);
  const recordOutputs = parseEnvBoolean(env.AGENT_OBSERVABILITY_RECORD_OUTPUTS);
  if (recordInputs === true || recordOutputs === true) return true;
  if (recordInputs === false && recordOutputs === false) return false;
  return undefined;
}

export function isNetworkTelemetryGloballyDisabled(env: TelemetryEnv = defaultEnv()): boolean {
  return parseEnvBoolean(env[NETWORK_TELEMETRY_KILL_SWITCH_ENV]) === true;
}

export function normalizePrivacyTelemetrySettings(
  value?: PersistedPrivacyTelemetrySettings | null,
): PrivacyTelemetrySettings {
  const aiTraceTelemetryEnabled = value?.aiTraceTelemetryEnabled === true;

  return {
    crashReportsEnabled: value?.crashReportsEnabled === true,
    productAnalyticsEnabled: value?.productAnalyticsEnabled === true,
    aiTraceTelemetryEnabled,
    aiTracePayloadsEnabled: aiTraceTelemetryEnabled && value?.aiTracePayloadsEnabled === true,
    diagnosticsUploadEnabled: value?.diagnosticsUploadEnabled === true,
    cloudSyncEnabled: value?.cloudSyncEnabled === true,
  };
}

export function resolveTelemetryConsent(opts: {
  settings?: PersistedPrivacyTelemetrySettings | PrivacyTelemetrySettings | null;
  env?: TelemetryEnv;
  isPackaged?: boolean;
  mode?: TelemetryPackagingMode | null;
} = {}): ResolvedTelemetryConsent {
  const env = opts.env ?? defaultEnv();
  const isPackaged = opts.isPackaged === true;
  const mode = resolvePackagingMode({ env, isPackaged, mode: opts.mode ?? null });
  const networkTelemetryDisabled = isNetworkTelemetryGloballyDisabled(env);
  const normalized = normalizePrivacyTelemetrySettings(opts.settings);

  if (networkTelemetryDisabled) {
    return {
      ...DEFAULT_PRIVACY_TELEMETRY_SETTINGS,
      mode,
      isPackaged,
      networkTelemetryDisabled: true,
    };
  }

  const allowEnvOptIn = isLocalOptInMode(mode);
  const crashReportsEnabled =
    normalized.crashReportsEnabled ||
    (allowEnvOptIn && parseEnvBoolean(env.COWORK_CRASH_REPORTS_ENABLED) === true);
  const productAnalyticsEnabled =
    normalized.productAnalyticsEnabled ||
    (allowEnvOptIn && parseEnvBoolean(env.COWORK_PRODUCT_ANALYTICS_ENABLED) === true);
  const aiTraceTelemetryEnabled =
    normalized.aiTraceTelemetryEnabled ||
    (allowEnvOptIn && parseEnvBoolean(env.AGENT_OBSERVABILITY_ENABLED) === true);
  const aiTracePayloadsEnabled =
    aiTraceTelemetryEnabled &&
    (normalized.aiTracePayloadsEnabled || (allowEnvOptIn && resolveTracePayloadEnv(env) === true));
  const cloudSyncEnabled =
    normalized.cloudSyncEnabled ||
    (allowEnvOptIn && parseEnvBoolean(env.COWORK_CLOUD_SYNC_ENABLED) === true);

  return {
    crashReportsEnabled,
    productAnalyticsEnabled,
    aiTraceTelemetryEnabled,
    aiTracePayloadsEnabled,
    diagnosticsUploadEnabled: normalized.diagnosticsUploadEnabled,
    cloudSyncEnabled,
    mode,
    isPackaged,
    networkTelemetryDisabled,
  };
}

export function resolveTelemetryConfig(opts: {
  consent?: ResolvedTelemetryConsent;
  settings?: PersistedPrivacyTelemetrySettings | PrivacyTelemetrySettings | null;
  env?: TelemetryEnv;
  isPackaged?: boolean;
  appVersion?: string | null;
  anonymousId?: string | null;
  surface?: TelemetrySurface;
  includeSecrets?: boolean;
  mode?: TelemetryPackagingMode | null;
} = {}): ResolvedTelemetryConfig {
  const env = opts.env ?? defaultEnv();
  const surface = opts.surface ?? "server";
  const consent =
    opts.consent ??
    resolveTelemetryConsent({
      settings: opts.settings,
      env,
      isPackaged: opts.isPackaged,
      mode: opts.mode ?? null,
    });
  const networkTelemetryDisabled =
    consent.networkTelemetryDisabled || isNetworkTelemetryGloballyDisabled(env);
  const canIncludeSecrets = opts.includeSecrets === true && !isRendererSurface(surface);
  const appVersion = normalizeEnvValue(opts.appVersion) ?? coalesceEnv(env.COWORK_RELEASE);
  const anonymousId =
    normalizeEnvValue(opts.anonymousId) ??
    coalesceEnv(env.COWORK_PRODUCT_ANALYTICS_INSTALLATION_ID);

  const sentryDsn = coalesceEnv(env.COWORK_SENTRY_DSN, env.SENTRY_DSN);
  const sentryEnabled =
    !networkTelemetryDisabled && consent.crashReportsEnabled && Boolean(sentryDsn);
  const crashStatus: IntegrationStatus =
    networkTelemetryDisabled || !consent.crashReportsEnabled
      ? "disabled"
      : sentryDsn
        ? "enabled"
        : "not_configured";

  const posthogKey = coalesceEnv(env.COWORK_POSTHOG_KEY);
  const posthogHost = normalizeUrl(env.COWORK_POSTHOG_HOST) ?? DEFAULT_POSTHOG_HOST;
  const productEnabled =
    !networkTelemetryDisabled &&
    consent.productAnalyticsEnabled &&
    Boolean(posthogKey) &&
    Boolean(anonymousId);
  const productStatus: IntegrationStatus =
    networkTelemetryDisabled || !consent.productAnalyticsEnabled
      ? "disabled"
      : posthogKey && anonymousId
        ? "enabled"
        : "not_configured";

  const langfuseBaseUrl = normalizeUrl(env.LANGFUSE_BASE_URL) ?? DEFAULT_LANGFUSE_BASE_URL;
  const langfusePublicKey = coalesceEnv(env.LANGFUSE_PUBLIC_KEY);
  const langfuseSecretKey = coalesceEnv(env.LANGFUSE_SECRET_KEY);
  const langfuseConfigured = Boolean(langfuseBaseUrl && langfusePublicKey && langfuseSecretKey);
  const aiEnabled =
    !networkTelemetryDisabled && consent.aiTraceTelemetryEnabled && langfuseConfigured;
  const aiStatus: AiTraceStatus =
    networkTelemetryDisabled || !consent.aiTraceTelemetryEnabled
      ? "disabled"
      : !langfuseConfigured
        ? "not_configured"
        : consent.aiTracePayloadsEnabled
          ? "full_payload"
          : "metadata_only";
  const recordInputs = aiEnabled && consent.aiTracePayloadsEnabled;
  const recordOutputs = aiEnabled && consent.aiTracePayloadsEnabled;

  const diagnosticsUploadUrl = networkTelemetryDisabled
    ? null
    : normalizeUrl(env.COWORK_DIAGNOSTICS_UPLOAD_URL);
  const diagnosticsUploadEnabled =
    !networkTelemetryDisabled && consent.diagnosticsUploadEnabled && Boolean(diagnosticsUploadUrl);
  const diagnosticsStatus: DiagnosticsUploadStatus =
    networkTelemetryDisabled || !consent.diagnosticsUploadEnabled
      ? "disabled"
      : diagnosticsUploadUrl
        ? "upload_configured"
        : "local_only";

  return {
    mode: consent.mode,
    isPackaged: consent.isPackaged,
    surface,
    appVersion,
    anonymousId,
    networkTelemetryDisabled,
    consent: {
      ...consent,
      networkTelemetryDisabled,
    },
    crashReports: {
      enabled: sentryEnabled,
      status: crashStatus,
      dsnConfigured: Boolean(sentryDsn),
      dsn: sentryDsn,
      release: coalesceEnv(env.COWORK_RELEASE, env.SENTRY_RELEASE, appVersion),
      environment: coalesceEnv(env.COWORK_SENTRY_ENVIRONMENT),
    },
    productAnalytics: {
      enabled: productEnabled,
      status: productStatus,
      keyConfigured: Boolean(posthogKey),
      key: posthogKey,
      host: posthogHost,
      environment: coalesceEnv(env.COWORK_POSTHOG_ENVIRONMENT, env.NODE_ENV),
    },
    aiTraces: {
      enabled: aiEnabled,
      status: aiStatus,
      baseUrl: langfuseBaseUrl,
      publicKey: langfusePublicKey,
      hasSecretKey: Boolean(langfuseSecretKey),
      ...(canIncludeSecrets && langfuseSecretKey ? { secretKey: langfuseSecretKey } : {}),
      tracingEnvironment: coalesceEnv(env.LANGFUSE_TRACING_ENVIRONMENT),
      release: coalesceEnv(env.LANGFUSE_RELEASE, env.COWORK_RELEASE, appVersion),
      recordInputs,
      recordOutputs,
    },
    diagnosticsUpload: {
      enabled: diagnosticsUploadEnabled,
      status: diagnosticsStatus,
      uploadUrlConfigured: Boolean(diagnosticsUploadUrl),
      uploadUrl: diagnosticsUploadUrl,
    },
  };
}

export function resolveCloudSyncConfig(opts: {
  persisted?: PersistedCloudSyncSettings | null | unknown;
  env?: TelemetryEnv;
  lastStatus?: CloudSyncStatus | null;
  includeSecrets?: boolean;
} = {}): ResolvedCloudSyncConfig {
  const env = opts.env ?? defaultEnv();
  const networkTelemetryDisabled = isNetworkTelemetryGloballyDisabled(env);
  const persisted =
    opts.persisted && typeof opts.persisted === "object" && !Array.isArray(opts.persisted)
      ? (opts.persisted as PersistedCloudSyncSettings)
      : undefined;
  const settings = normalizeCloudSyncSettings(persisted);
  const envEnabled = parseEnvBoolean(env.COWORK_CLOUD_SYNC_ENABLED);
  const endpoint = normalizeUrl(env.COWORK_CLOUD_SYNC_ENDPOINT) ?? settings.endpoint;
  const provider: CloudSyncProviderId = settings.provider === "custom" || endpoint ? "custom" : "none";
  const enabled = !networkTelemetryDisabled && (envEnabled ?? settings.enabled);
  const queued = opts.lastStatus?.queued ?? 0;

  if (networkTelemetryDisabled || !enabled || !settings.syncSettings) {
    return {
      enabled: false,
      provider: "none",
      syncSettings: settings.syncSettings,
      syncWorkspaceMetadata: settings.syncWorkspaceMetadata,
      syncThreads: settings.syncThreads,
      status: "disabled",
      queued,
      networkTelemetryDisabled,
    };
  }

  if (provider !== "custom" || !endpoint) {
    return {
      ...settings,
      enabled,
      provider,
      status: "not_configured",
      queued,
      networkTelemetryDisabled,
    };
  }

  const token = normalizeEnvValue(env.COWORK_CLOUD_SYNC_TOKEN);
  const lastStatus = opts.lastStatus?.status;
  const status =
    lastStatus === "error"
      ? "error"
      : lastStatus === "connected" || lastStatus === "queued"
        ? "connected"
        : "connected";

  return {
    ...settings,
    enabled,
    provider: "custom",
    endpoint,
    ...(opts.includeSecrets === true && token ? { token } : {}),
    status,
    queued,
    ...(opts.lastStatus?.message ? { message: opts.lastStatus.message } : {}),
    networkTelemetryDisabled,
  };
}
