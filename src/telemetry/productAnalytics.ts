export const PRODUCT_ANALYTICS_EVENT_NAMES = [
  "app_started",
  "app_updated",
  "workspace_added",
  "workspace_removed",
  "workspace_server_started",
  "workspace_server_failed",
  "provider_connected",
  "provider_auth_failed",
  "turn_started",
  "turn_completed",
  "turn_failed",
  "tool_approval_requested",
  "mcp_server_added",
  "mcp_server_validation_failed",
  "plugin_installed",
  "skill_installed",
  "quick_chat_opened",
  "mobile_pairing_started",
  "mobile_pairing_completed",
  "update_checked",
  "update_downloaded",
  "update_install_started",
] as const;

export type ProductAnalyticsEventName = (typeof PRODUCT_ANALYTICS_EVENT_NAMES)[number];

export type ProductAnalyticsEventSource = "desktop" | "main" | "server" | "renderer";

export type ProductAnalyticsEnvironment =
  | "development"
  | "packaged"
  | "beta"
  | "production"
  | "test";

type ProductAnalyticsValue = string | number | boolean | null | undefined;

export type ProductAnalyticsPropertyName =
  | "appVersion"
  | "platform"
  | "arch"
  | "packaged"
  | "eventSource"
  | "provider"
  | "model"
  | "durationMs"
  | "status"
  | "errorCategory"
  | "workspaceCount"
  | "threadCount"
  | "providerCount"
  | "mcpServerCount"
  | "pluginCount"
  | "skillCount"
  | "toolCount"
  | "attachmentCount"
  | "referenceCount"
  | "productAnalyticsEnabled"
  | "crashReportsEnabled"
  | "aiTraceTelemetryEnabled"
  | "aiTracePayloadsEnabled"
  | "diagnosticsUploadEnabled"
  | "cloudSyncEnabled"
  | "mcpEnabled"
  | "yoloEnabled"
  | "quickChatIconEnabled"
  | "quickChatShortcutEnabled"
  | "mobilePairingEnabled"
  | "hasAttachments"
  | "hasReferences"
  | "remoteAccessEnabled"
  | "openAiNativeConnectorsEnabled"
  | "updateAvailable";

export type ProductAnalyticsProperties = Partial<
  Record<ProductAnalyticsPropertyName, ProductAnalyticsValue>
>;

type CommonProperties = Pick<
  ProductAnalyticsProperties,
  "appVersion" | "platform" | "arch" | "packaged" | "eventSource"
>;

export type ProductAnalyticsEventMap = {
  app_started: CommonProperties &
    Pick<
      ProductAnalyticsProperties,
      | "workspaceCount"
      | "threadCount"
      | "providerCount"
      | "productAnalyticsEnabled"
      | "crashReportsEnabled"
      | "aiTraceTelemetryEnabled"
      | "aiTracePayloadsEnabled"
      | "diagnosticsUploadEnabled"
      | "cloudSyncEnabled"
      | "quickChatIconEnabled"
      | "quickChatShortcutEnabled"
    >;
  app_updated: CommonProperties & Pick<ProductAnalyticsProperties, "status">;
  workspace_added: CommonProperties &
    Pick<ProductAnalyticsProperties, "workspaceCount" | "mcpEnabled" | "yoloEnabled">;
  workspace_removed: CommonProperties & Pick<ProductAnalyticsProperties, "workspaceCount">;
  workspace_server_started: CommonProperties &
    Pick<ProductAnalyticsProperties, "durationMs" | "status" | "mcpEnabled" | "yoloEnabled">;
  workspace_server_failed: CommonProperties &
    Pick<ProductAnalyticsProperties, "durationMs" | "status" | "errorCategory">;
  provider_connected: CommonProperties & Pick<ProductAnalyticsProperties, "provider" | "status">;
  provider_auth_failed: CommonProperties &
    Pick<ProductAnalyticsProperties, "provider" | "status" | "errorCategory">;
  turn_started: CommonProperties &
    Pick<
      ProductAnalyticsProperties,
      | "provider"
      | "model"
      | "mcpEnabled"
      | "hasAttachments"
      | "hasReferences"
      | "attachmentCount"
      | "referenceCount"
    >;
  turn_completed: CommonProperties &
    Pick<
      ProductAnalyticsProperties,
      "provider" | "model" | "durationMs" | "status" | "toolCount"
    >;
  turn_failed: CommonProperties &
    Pick<
      ProductAnalyticsProperties,
      "provider" | "model" | "durationMs" | "status" | "errorCategory"
    >;
  tool_approval_requested: CommonProperties &
    Pick<ProductAnalyticsProperties, "status" | "errorCategory">;
  mcp_server_added: CommonProperties & Pick<ProductAnalyticsProperties, "mcpServerCount">;
  mcp_server_validation_failed: CommonProperties &
    Pick<ProductAnalyticsProperties, "durationMs" | "status" | "errorCategory">;
  plugin_installed: CommonProperties & Pick<ProductAnalyticsProperties, "pluginCount" | "status">;
  skill_installed: CommonProperties & Pick<ProductAnalyticsProperties, "skillCount" | "status">;
  quick_chat_opened: CommonProperties &
    Pick<ProductAnalyticsProperties, "quickChatIconEnabled" | "quickChatShortcutEnabled">;
  mobile_pairing_started: CommonProperties &
    Pick<ProductAnalyticsProperties, "status" | "mobilePairingEnabled">;
  mobile_pairing_completed: CommonProperties &
    Pick<ProductAnalyticsProperties, "durationMs" | "status" | "mobilePairingEnabled">;
  update_checked: CommonProperties &
    Pick<ProductAnalyticsProperties, "durationMs" | "status" | "errorCategory" | "updateAvailable">;
  update_downloaded: CommonProperties &
    Pick<ProductAnalyticsProperties, "durationMs" | "status">;
  update_install_started: CommonProperties & Pick<ProductAnalyticsProperties, "status">;
};

export type ProductAnalyticsEventProperties<Name extends ProductAnalyticsEventName> =
  ProductAnalyticsEventMap[Name];

export type ProductAnalyticsEnv = Record<string, string | undefined>;

export type ProductAnalyticsClient = {
  capture: (event: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
    disableGeoip?: boolean;
    sendFeatureFlags?: false;
  }) => void;
  shutdown?: (timeoutMs?: number) => Promise<void> | void;
};

export type ProductAnalyticsSdkModule = {
  PostHog: new (apiKey: string, options?: Record<string, unknown>) => ProductAnalyticsClient;
};

export type ProductAnalyticsSdkLoader = () => Promise<ProductAnalyticsSdkModule>;

export type ProductAnalyticsInitContext = {
  enabled: boolean;
  env?: ProductAnalyticsEnv;
  apiKey?: string | null;
  host?: string | null;
  anonymousId?: string | null;
  release?: string | null;
  appVersion?: string | null;
  environment?: ProductAnalyticsEnvironment | string | null;
  eventSource?: ProductAnalyticsEventSource | null;
  platform?: string | null;
  arch?: string | null;
  packaged?: boolean;
  loadSdk?: ProductAnalyticsSdkLoader;
};

export type ResolvedProductAnalyticsConfig = {
  enabled: boolean;
  keyConfigured: boolean;
  apiKey: string | null;
  host: string;
  anonymousId: string | null;
  release: string | null;
  appVersion: string | null;
  environment: ProductAnalyticsEnvironment;
  eventSource: ProductAnalyticsEventSource;
  platform: string | null;
  arch: string | null;
  packaged: boolean;
};

export type ProductAnalyticsStatus = ResolvedProductAnalyticsConfig & {
  initialized: boolean;
  reason: "enabled" | "disabled" | "not_configured" | "missing_identity" | "sdk_unavailable";
};

type SanitizedProductEvent = {
  name: ProductAnalyticsEventName;
  properties: Record<string, string | number | boolean | null>;
};

type ProductAnalyticsSanitizeResult =
  | { ok: true; event: SanitizedProductEvent }
  | { ok: false; reason: string };

const PRODUCT_ANALYTICS_EVENT_NAME_SET = new Set<string>(PRODUCT_ANALYTICS_EVENT_NAMES);
const PRODUCT_ANALYTICS_PROPERTY_NAMES = new Set<string>([
  "appVersion",
  "platform",
  "arch",
  "packaged",
  "eventSource",
  "provider",
  "model",
  "durationMs",
  "status",
  "errorCategory",
  "workspaceCount",
  "threadCount",
  "providerCount",
  "mcpServerCount",
  "pluginCount",
  "skillCount",
  "toolCount",
  "attachmentCount",
  "referenceCount",
  "productAnalyticsEnabled",
  "crashReportsEnabled",
  "aiTraceTelemetryEnabled",
  "aiTracePayloadsEnabled",
  "diagnosticsUploadEnabled",
  "cloudSyncEnabled",
  "mcpEnabled",
  "yoloEnabled",
  "quickChatIconEnabled",
  "quickChatShortcutEnabled",
  "mobilePairingEnabled",
  "hasAttachments",
  "hasReferences",
  "remoteAccessEnabled",
  "openAiNativeConnectorsEnabled",
  "updateAvailable",
]);
const COUNT_PROPERTY_PATTERN = /Count$/;
const BOOLEAN_PROPERTY_NAMES = new Set<string>([
  "packaged",
  "productAnalyticsEnabled",
  "crashReportsEnabled",
  "aiTraceTelemetryEnabled",
  "aiTracePayloadsEnabled",
  "diagnosticsUploadEnabled",
  "cloudSyncEnabled",
  "mcpEnabled",
  "yoloEnabled",
  "quickChatIconEnabled",
  "quickChatShortcutEnabled",
  "mobilePairingEnabled",
  "hasAttachments",
  "hasReferences",
  "remoteAccessEnabled",
  "openAiNativeConnectorsEnabled",
  "updateAvailable",
]);
const STRING_PROPERTY_NAMES = new Set<string>([
  "appVersion",
  "platform",
  "arch",
  "eventSource",
  "provider",
  "model",
  "status",
  "errorCategory",
]);
const SENSITIVE_KEY_PATTERN =
  /(?:prompt|response|completion|transcript|content|contents|filename|fileName|file[_-]?name|repo|repository|path|command|stdout|stderr|api[_-]?key|apikey|provider[_-]?key|secret|token|email|username|user[_-]?name|machine|hostname)/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const URL_PATTERN = /\b(?:https?|file):\/\//i;
const SECRET_VALUE_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{12,})\b/i;
const ABSOLUTE_POSIX_PATH_PATTERN =
  /(?:^|[\s"'`])\/(?:Users|home|tmp|private|var|Volumes|Applications|opt|etc)\b/i;
const WINDOWS_PATH_PATTERN =
  /(?:^|[\s"'`])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>{}[\]]*/;
const RELATIVE_PATH_PATTERN = /(?:^|[\s"'`])(?:\.{1,2}[\\/]|~[\\/])/;
const GENERIC_PATH_WITH_EXTENSION_PATTERN =
  /(?:^|[\s"'`])[\w.-]+[\\/][^\s"'`<>{}[\]]+\.[A-Za-z0-9]{1,12}\b/;
const SAFE_ANONYMOUS_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SAFE_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const SAFE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,127}$/;
const SAFE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@/+ -]{0,127}$/;
const MAX_STRING_LENGTH = 128;
const MAX_STATUS_LENGTH = 64;
const MAX_COUNT = 1_000_000;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_QUEUE_SIZE = 100;
const SDK_SHUTDOWN_TIMEOUT_MS = 2_000;
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

let activeClient: ProductAnalyticsClient | null = null;
let activeConfig: ResolvedProductAnalyticsConfig | null = null;
let activeCommonProperties: ProductAnalyticsProperties = {};
let initPromise: Promise<ProductAnalyticsStatus> | null = null;
let lastInitContext: ProductAnalyticsInitContext | null = null;
let queue: SanitizedProductEvent[] = [];
let flushScheduled = false;
let flushing = false;

function normalizeEnvValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function resolveEnvironment(opts: {
  env: ProductAnalyticsEnv;
  explicit?: string | null;
  packaged?: boolean;
}): ProductAnalyticsEnvironment {
  const explicit = normalizeEnvValue(opts.explicit);
  if (explicit) {
    return normalizeEnvironmentValue(explicit, opts.packaged);
  }

  const fromPostHogEnv = normalizeEnvValue(opts.env.COWORK_POSTHOG_ENVIRONMENT);
  if (fromPostHogEnv) {
    return normalizeEnvironmentValue(fromPostHogEnv, opts.packaged);
  }

  const fromNodeEnv = normalizeEnvValue(opts.env.NODE_ENV);
  if (fromNodeEnv === "test") {
    return "test";
  }
  if (fromNodeEnv === "production") {
    return "production";
  }

  return opts.packaged ? "packaged" : "development";
}

function normalizeEnvironmentValue(
  value: string,
  packaged?: boolean,
): ProductAnalyticsEnvironment {
  const normalized = value.toLowerCase();
  if (
    normalized === "development" ||
    normalized === "packaged" ||
    normalized === "beta" ||
    normalized === "production" ||
    normalized === "test"
  ) {
    return normalized;
  }
  return packaged ? "packaged" : "development";
}

function normalizeHost(value: string | null | undefined): string {
  return normalizeEnvValue(value) ?? DEFAULT_POSTHOG_HOST;
}

function normalizeRelease(context: ProductAnalyticsInitContext): string | null {
  const env = context.env ?? {};
  return (
    normalizeEnvValue(context.release) ??
    normalizeEnvValue(env.COWORK_RELEASE) ??
    normalizeEnvValue(context.appVersion)
  );
}

function normalizeAnonymousId(value: string | null | undefined): string | null {
  const trimmed = normalizeEnvValue(value);
  if (!trimmed || !SAFE_ANONYMOUS_ID_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function identifyAnonymous(anonymousId?: string | null): string | null {
  const normalized = normalizeAnonymousId(anonymousId);
  if (anonymousId !== undefined && normalized) {
    activeConfig = activeConfig ? { ...activeConfig, anonymousId: normalized } : activeConfig;
  }
  return normalized ?? activeConfig?.anonymousId ?? null;
}

export function resolveProductAnalyticsConfig(
  context: Omit<ProductAnalyticsInitContext, "loadSdk">,
): ResolvedProductAnalyticsConfig {
  const env = context.env ?? {};
  const apiKey = normalizeEnvValue(context.apiKey) ?? normalizeEnvValue(env.COWORK_POSTHOG_KEY);
  const anonymousId =
    normalizeAnonymousId(context.anonymousId) ??
    normalizeAnonymousId(env.COWORK_PRODUCT_ANALYTICS_INSTALLATION_ID);
  const release = normalizeRelease(context);
  const appVersion =
    normalizeEnvValue(context.appVersion) ?? release ?? normalizeEnvValue(env.COWORK_RELEASE);
  const packaged = context.packaged === true || env.COWORK_IS_PACKAGED === "true";
  const environment = resolveEnvironment({
    env,
    explicit: typeof context.environment === "string" ? context.environment : null,
    packaged,
  });
  const eventSource =
    context.eventSource === "desktop" ||
    context.eventSource === "main" ||
    context.eventSource === "server" ||
    context.eventSource === "renderer"
      ? context.eventSource
      : "server";

  return {
    enabled: context.enabled === true && Boolean(apiKey) && Boolean(anonymousId),
    keyConfigured: Boolean(apiKey),
    apiKey,
    host: normalizeHost(context.host ?? env.COWORK_POSTHOG_HOST),
    anonymousId,
    release,
    appVersion,
    environment,
    eventSource,
    platform: normalizeEnvValue(context.platform) ?? normalizeEnvValue(env.COWORK_PLATFORM),
    arch: normalizeEnvValue(context.arch) ?? normalizeEnvValue(env.COWORK_ARCH),
    packaged,
  };
}

function toStatus(
  config: ResolvedProductAnalyticsConfig,
  initialized: boolean,
  reason: ProductAnalyticsStatus["reason"],
): ProductAnalyticsStatus {
  return { ...config, initialized, reason };
}

function buildCommonProperties(config: ResolvedProductAnalyticsConfig): ProductAnalyticsProperties {
  return {
    ...(config.appVersion ? { appVersion: config.appVersion } : {}),
    ...(config.platform ? { platform: config.platform } : {}),
    ...(config.arch ? { arch: config.arch } : {}),
    packaged: config.packaged,
    eventSource: config.eventSource,
  };
}

export async function initProductAnalytics(
  context: ProductAnalyticsInitContext,
): Promise<ProductAnalyticsStatus> {
  lastInitContext = context;
  const config = resolveProductAnalyticsConfig(context);
  activeCommonProperties = buildCommonProperties(config);

  if (!context.enabled) {
    await shutdownProductAnalytics();
    return toStatus(config, false, "disabled");
  }

  if (!config.keyConfigured) {
    await shutdownProductAnalytics();
    return toStatus(config, false, "not_configured");
  }

  if (!config.anonymousId) {
    await shutdownProductAnalytics();
    return toStatus(config, false, "missing_identity");
  }

  if (
    activeClient &&
    activeConfig?.apiKey === config.apiKey &&
    activeConfig.host === config.host &&
    activeConfig.anonymousId === config.anonymousId
  ) {
    activeConfig = config;
    activeCommonProperties = buildCommonProperties(config);
    return toStatus(config, true, "enabled");
  }

  if (initPromise) {
    return await initPromise;
  }

  initPromise = (async () => {
    try {
      await shutdownProductAnalytics();
      if (!config.apiKey) {
        return toStatus(config, false, "not_configured");
      }
      const sdk = context.loadSdk
        ? await context.loadSdk()
        : ((await import("posthog-node")) as ProductAnalyticsSdkModule);
      const client = new sdk.PostHog(config.apiKey, {
        host: config.host,
        flushAt: 10,
        flushInterval: 5_000,
        persistence: "memory",
        privacyMode: true,
        disableGeoip: true,
        enableLocalEvaluation: false,
        before_send: beforeSendProductEvent,
      });
      activeClient = client;
      activeConfig = config;
      activeCommonProperties = buildCommonProperties(config);
      return toStatus(config, true, "enabled");
    } catch {
      activeClient = null;
      activeConfig = null;
      return toStatus(config, false, "sdk_unavailable");
    } finally {
      initPromise = null;
    }
  })();

  return await initPromise;
}

export async function setProductAnalyticsEnabled(enabled: boolean): Promise<void> {
  if (!enabled) {
    await shutdownProductAnalytics();
    return;
  }
  if (lastInitContext) {
    await initProductAnalytics({ ...lastInitContext, enabled: true });
  }
}

export function captureProductEvent<Name extends ProductAnalyticsEventName>(
  name: Name,
  properties: ProductAnalyticsEventProperties<Name> = {} as ProductAnalyticsEventProperties<Name>,
): void {
  if (!activeClient || !activeConfig?.enabled || !activeConfig.anonymousId) {
    return;
  }

  const sanitized = sanitizeProductEvent(name, {
    ...activeCommonProperties,
    ...properties,
  });
  if (!sanitized.ok) {
    return;
  }

  if (queue.length >= MAX_QUEUE_SIZE) {
    queue.shift();
  }
  queue.push(sanitized.event);
  scheduleFlush();
}

export async function shutdownProductAnalytics(): Promise<void> {
  const client = activeClient;
  activeClient = null;
  activeConfig = null;
  initPromise = null;
  queue = [];
  flushScheduled = false;
  flushing = false;
  if (!client?.shutdown) {
    return;
  }
  try {
    await client.shutdown(SDK_SHUTDOWN_TIMEOUT_MS);
  } catch {
    // Product analytics must never block shutdown.
  }
}

function scheduleFlush(): void {
  if (flushScheduled) {
    return;
  }
  flushScheduled = true;
  setTimeout(() => {
    void flushProductAnalyticsQueue();
  }, 0);
}

async function flushProductAnalyticsQueue(): Promise<void> {
  if (flushing) {
    return;
  }
  flushing = true;
  flushScheduled = false;
  try {
    while (queue.length > 0) {
      const client = activeClient;
      const distinctId = activeConfig?.anonymousId;
      if (!client || !distinctId) {
        queue = [];
        return;
      }
      const event = queue.shift();
      if (!event) {
        continue;
      }
      try {
        client.capture({
          distinctId,
          event: event.name,
          properties: {
            ...event.properties,
            $process_person_profile: false,
          },
          disableGeoip: true,
          sendFeatureFlags: false,
        });
      } catch {
        // Capturing must remain best-effort and non-blocking.
      }
    }
  } finally {
    flushing = false;
    if (queue.length > 0) {
      scheduleFlush();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function beforeSendProductEvent(event: unknown): unknown | null {
  if (!isRecord(event)) {
    return null;
  }
  const eventName = typeof event.event === "string" ? event.event : "";
  if (!isProductAnalyticsEventName(eventName)) {
    return null;
  }
  const rawProperties = isRecord(event.properties) ? event.properties : {};
  const callerProperties = Object.fromEntries(
    Object.entries(rawProperties).filter(([key]) => key !== "$process_person_profile"),
  ) as ProductAnalyticsProperties;
  const sanitized = sanitizeProductEvent(eventName, callerProperties);
  if (!sanitized.ok) {
    return null;
  }
  return {
    ...event,
    event: eventName,
    properties: {
      ...sanitized.event.properties,
      $process_person_profile: false,
    },
    disableGeoip: true,
    sendFeatureFlags: false,
  };
}

function isProductAnalyticsEventName(value: string): value is ProductAnalyticsEventName {
  return PRODUCT_ANALYTICS_EVENT_NAME_SET.has(value);
}

function sanitizeProductEvent(
  name: string,
  properties: ProductAnalyticsProperties = {},
): ProductAnalyticsSanitizeResult {
  if (!isProductAnalyticsEventName(name)) {
    return { ok: false, reason: "event_not_allowed" };
  }

  const output: SanitizedProductEvent["properties"] = {};
  for (const [key, rawValue] of Object.entries(properties)) {
    const value = rawValue as ProductAnalyticsValue;
    if (value === undefined) {
      continue;
    }
    const safeKey = sanitizePropertyKey(key);
    if (!safeKey.ok) {
      return safeKey;
    }
    const safeValue = sanitizePropertyValue(safeKey.key, value);
    if (!safeValue.ok) {
      return safeValue;
    }
    if (safeValue.value !== undefined) {
      output[safeKey.key] = safeValue.value;
    }
  }

  return { ok: true, event: { name, properties: output } };
}

function sanitizePropertyKey(
  key: string,
): { ok: true; key: ProductAnalyticsPropertyName } | { ok: false; reason: string } {
  if (!PRODUCT_ANALYTICS_PROPERTY_NAMES.has(key)) {
    return { ok: false, reason: "property_not_allowed" };
  }
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return { ok: false, reason: "property_key_sensitive" };
  }
  return { ok: true, key: key as ProductAnalyticsPropertyName };
}

function sanitizePropertyValue(
  key: ProductAnalyticsPropertyName,
  value: ProductAnalyticsValue,
):
  | { ok: true; value: string | number | boolean | null | undefined }
  | { ok: false; reason: string } {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (BOOLEAN_PROPERTY_NAMES.has(key)) {
    return typeof value === "boolean"
      ? { ok: true, value }
      : { ok: false, reason: "property_type_invalid" };
  }
  if (key === "durationMs") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, reason: "property_type_invalid" };
    }
    return { ok: true, value: Math.min(MAX_DURATION_MS, Math.max(0, Math.round(value))) };
  }
  if (COUNT_PROPERTY_PATTERN.test(key)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, reason: "property_type_invalid" };
    }
    return { ok: true, value: Math.min(MAX_COUNT, Math.max(0, Math.floor(value))) };
  }
  if (!STRING_PROPERTY_NAMES.has(key) || typeof value !== "string") {
    return { ok: false, reason: "property_type_invalid" };
  }
  return sanitizeStringProperty(key, value);
}

function sanitizeStringProperty(
  key: ProductAnalyticsPropertyName,
  value: string,
): { ok: true; value: string | undefined } | { ok: false; reason: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true, value: undefined };
  }
  if (hasSensitiveStringValue(trimmed)) {
    return { ok: false, reason: "property_value_sensitive" };
  }
  if (key === "model") {
    if (!isSafeModelId(trimmed)) {
      return { ok: false, reason: "property_value_sensitive" };
    }
    return { ok: true, value: limitString(trimmed, MAX_STRING_LENGTH) };
  }
  if (looksLikePath(trimmed)) {
    return { ok: false, reason: "property_value_sensitive" };
  }
  if (key === "appVersion") {
    const limited = limitString(trimmed, MAX_STRING_LENGTH);
    return SAFE_VERSION_PATTERN.test(limited)
      ? { ok: true, value: limited }
      : { ok: false, reason: "property_value_invalid" };
  }
  const maxLength = key === "status" || key === "errorCategory" ? MAX_STATUS_LENGTH : MAX_STRING_LENGTH;
  const limited = limitString(trimmed, maxLength);
  return SAFE_SLUG_PATTERN.test(limited)
    ? { ok: true, value: limited }
    : { ok: false, reason: "property_value_invalid" };
}

function limitString(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function hasSensitiveStringValue(value: string): boolean {
  return EMAIL_PATTERN.test(value) || URL_PATTERN.test(value) || SECRET_VALUE_PATTERN.test(value);
}

function looksLikePath(value: string): boolean {
  return (
    ABSOLUTE_POSIX_PATH_PATTERN.test(value) ||
    WINDOWS_PATH_PATTERN.test(value) ||
    RELATIVE_PATH_PATTERN.test(value) ||
    GENERIC_PATH_WITH_EXTENSION_PATTERN.test(value) ||
    value.includes("\\")
  );
}

function isSafeModelId(value: string): boolean {
  if (value.length > MAX_STRING_LENGTH || !SAFE_MODEL_PATTERN.test(value)) {
    return false;
  }
  if (value.startsWith(".") || value.startsWith("~") || value.includes("..")) {
    return false;
  }
  return !looksLikeLocalModelPath(value);
}

function looksLikeLocalModelPath(value: string): boolean {
  return (
    ABSOLUTE_POSIX_PATH_PATTERN.test(value) ||
    WINDOWS_PATH_PATTERN.test(value) ||
    RELATIVE_PATH_PATTERN.test(value) ||
    URL_PATTERN.test(value) ||
    value.includes("\\")
  );
}

export const __internal = {
  beforeSendProductEvent,
  resolveEnvironment,
  sanitizeProductEvent,
  looksLikePath,
  isSafeModelId,
  async flushProductAnalyticsQueueForTests() {
    await flushProductAnalyticsQueue();
  },
  async resetProductAnalyticsForTests() {
    await shutdownProductAnalytics();
    activeCommonProperties = {};
    lastInitContext = null;
  },
};
