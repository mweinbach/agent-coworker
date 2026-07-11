import { redactSensitiveText } from "../diagnostics/sensitiveText";
import { isNetworkTelemetryGloballyDisabled } from "./config";

export type CrashReportingEnvironment = "development" | "packaged" | "beta" | "production";

export type CrashReportingComponent = "electron-main" | "electron-renderer" | "cowork-server";

export type CrashReportingTags = Record<string, string | number | boolean | null | undefined>;

export type CrashReportingExtras = Record<string, unknown>;

export type CrashReportingBreadcrumb = {
  category?: string;
  message?: string;
  level?: "fatal" | "error" | "warning" | "info" | "debug";
  data?: CrashReportingExtras;
};

export type CrashReportingCaptureContext = {
  tags?: CrashReportingTags;
  extra?: CrashReportingExtras;
  contexts?: Record<string, unknown>;
  level?: "fatal" | "error" | "warning" | "info" | "debug";
};

type CrashReportingIntegration = {
  name?: string;
};

type CrashReportingEvent = Record<string, unknown>;

type CrashReportingSdkOptions = {
  dsn: string;
  release?: string;
  environment: CrashReportingEnvironment;
  sendDefaultPii: false;
  maxBreadcrumbs: number;
  maxValueLength: number;
  normalizeDepth: number;
  normalizeMaxBreadth: number;
  tracesSampleRate: 0;
  enableLogs: false;
  replaysSessionSampleRate: 0;
  replaysOnErrorSampleRate: 0;
  initialScope: {
    tags: Record<string, string>;
  };
  integrations: (integrations: CrashReportingIntegration[]) => CrashReportingIntegration[];
  beforeSend: (event: CrashReportingEvent) => CrashReportingEvent | null;
  beforeBreadcrumb: (breadcrumb: CrashReportingEvent) => CrashReportingEvent | null;
};

export type CrashReportingSdk = {
  init: (options: CrashReportingSdkOptions) => void;
  captureException?: (error: unknown, context?: CrashReportingCaptureContext) => unknown;
  addBreadcrumb?: (breadcrumb: CrashReportingBreadcrumb) => void;
  setTags?: (tags: Record<string, string>) => void;
  setTag?: (key: string, value: string) => void;
  close?: (timeout?: number) => Promise<boolean> | boolean;
  flush?: (timeout?: number) => Promise<boolean> | boolean;
};

export type CrashReportingSdkLoader = () => Promise<CrashReportingSdk>;

export type CrashReportingEnv = Record<string, string | undefined>;

export type CrashReportingInitContext = {
  component: CrashReportingComponent;
  enabled: boolean;
  env?: CrashReportingEnv;
  dsn?: string | null;
  release?: string | null;
  fallbackRelease?: string | null;
  appVersion?: string | null;
  environment?: CrashReportingEnvironment | null;
  isPackaged?: boolean;
  platform?: string | null;
  arch?: string | null;
  workspacePaths?: readonly string[];
  homeDir?: string | null;
  tags?: CrashReportingTags;
  loadSdk?: CrashReportingSdkLoader;
};

export type ResolvedCrashReportingConfig = {
  enabled: boolean;
  dsnConfigured: boolean;
  dsn: string | null;
  release: string | null;
  environment: CrashReportingEnvironment;
  component: CrashReportingComponent;
  appVersion: string | null;
  platform: string | null;
  arch: string | null;
  isPackaged: boolean;
};

export type CrashReportingStatus = ResolvedCrashReportingConfig & {
  initialized: boolean;
  reason: "enabled" | "disabled" | "not_configured" | "missing_loader" | "sdk_unavailable";
  detail?: string;
};

type ScrubContext = {
  workspacePaths: readonly string[];
  homeDir: string | null;
};

const VALID_ENVIRONMENTS = new Set<CrashReportingEnvironment>([
  "development",
  "packaged",
  "beta",
  "production",
]);

const MAX_STRING_LENGTH = 1024;
const MAX_OBJECT_DEPTH = 4;
const MAX_OBJECT_KEYS = 40;
const MAX_ARRAY_LENGTH = 20;
const SDK_SHUTDOWN_TIMEOUT_MS = 2_000;

const SECRET_KEY_PATTERN =
  /(?:token|secret|authorization|api[_-]?key|apikey|cookie|password|private[_-]?key|privatekey)/i;
const PAYLOAD_KEY_PATTERN =
  /(?:prompt|completion|stdout|stderr|command|file[_-]?content|contents|transcript|messages|request[_-]?body|body|form[_-]?data|payload|response)/i;
const REQUEST_CONTAINER_KEY_PATTERN = /^(?:request|req)$/i;
const REQUEST_PAYLOAD_KEY_PATTERN = /^(?:body|data|formData|form_data|cookies)$/i;
const DROPPED_BREADCRUMB_CATEGORY_PATTERN = /^(?:console|ui\.|dom\.|navigation)/i;
const BLOCKED_INTEGRATION_PATTERN =
  /(?:replay|profil|console|captureconsole|openai|anthropic|googlegenai|vercelai|langchain|langgraph|minidump|localvariables)/i;

let activeSdk: CrashReportingSdk | null = null;
let activeConfig: ResolvedCrashReportingConfig | null = null;
let activeScrubContext: ScrubContext = { workspacePaths: [], homeDir: null };
let initPromise: Promise<CrashReportingStatus> | null = null;
let recentCrashReportIds: string[] = [];

function normalizeEnvValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeReleaseChannel(env: CrashReportingEnv): string | null {
  return (
    normalizeEnvValue(env.COWORK_RELEASE_CHANNEL) ??
    normalizeEnvValue(env.COWORK_UPDATE_CHANNEL) ??
    normalizeEnvValue(env.RELEASE_CHANNEL) ??
    normalizeEnvValue(env.SENTRY_RELEASE_CHANNEL)
  );
}

function resolveEnvironment(opts: {
  env: CrashReportingEnv;
  explicit?: CrashReportingEnvironment | null;
  isPackaged?: boolean;
}): CrashReportingEnvironment {
  if (opts.explicit && VALID_ENVIRONMENTS.has(opts.explicit)) {
    return opts.explicit;
  }

  const fromEnv = normalizeEnvValue(opts.env.COWORK_SENTRY_ENVIRONMENT);
  if (fromEnv && VALID_ENVIRONMENTS.has(fromEnv as CrashReportingEnvironment)) {
    return fromEnv as CrashReportingEnvironment;
  }

  const releaseChannel = normalizeReleaseChannel(opts.env)?.toLowerCase();
  if (releaseChannel === "beta") {
    return "beta";
  }

  return opts.isPackaged ? "packaged" : "development";
}

export function resolveCrashReportingConfig(
  context: Omit<CrashReportingInitContext, "loadSdk" | "tags" | "workspacePaths" | "homeDir">,
): ResolvedCrashReportingConfig {
  const env = context.env ?? {};
  const networkTelemetryDisabled = isNetworkTelemetryGloballyDisabled(env);
  const dsn =
    normalizeEnvValue(context.dsn) ??
    normalizeEnvValue(env.COWORK_SENTRY_DSN) ??
    normalizeEnvValue(env.SENTRY_DSN);
  const release =
    normalizeEnvValue(context.release) ??
    normalizeEnvValue(env.COWORK_RELEASE) ??
    normalizeEnvValue(env.SENTRY_RELEASE) ??
    normalizeEnvValue(context.fallbackRelease) ??
    normalizeEnvValue(context.appVersion);
  const environment = resolveEnvironment({
    env,
    explicit: context.environment,
    isPackaged: context.isPackaged,
  });
  const isPackaged = context.isPackaged === true;

  return {
    enabled: !networkTelemetryDisabled && context.enabled === true && Boolean(dsn),
    dsnConfigured: Boolean(dsn),
    dsn,
    release,
    environment,
    component: context.component,
    appVersion: normalizeEnvValue(context.appVersion),
    platform: normalizeEnvValue(context.platform),
    arch: normalizeEnvValue(context.arch),
    isPackaged,
  };
}

function toStatus(
  config: ResolvedCrashReportingConfig,
  initialized: boolean,
  reason: CrashReportingStatus["reason"],
  detail?: string,
): CrashReportingStatus {
  return { ...config, initialized, reason, ...(detail ? { detail } : {}) };
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    return scrubString(`${error.name}: ${error.message}`, activeScrubContext);
  }
  return scrubString(String(error), activeScrubContext);
}

function buildScrubContext(context: CrashReportingInitContext): ScrubContext {
  return {
    workspacePaths: context.workspacePaths ?? [],
    homeDir: normalizeEnvValue(context.homeDir),
  };
}

function tagValue(value: string | number | boolean | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return scrubString(String(value), activeScrubContext);
}

function buildTags(
  config: ResolvedCrashReportingConfig,
  tags?: CrashReportingTags,
): Record<string, string> {
  const next: Record<string, string> = {
    component: config.component,
    environment: config.environment,
    packaged: String(config.isPackaged),
  };
  const appVersion = tagValue(config.appVersion);
  const platform = tagValue(config.platform);
  const arch = tagValue(config.arch);
  if (appVersion) next.appVersion = appVersion;
  if (platform) next.platform = platform;
  if (arch) next.arch = arch;
  for (const [key, value] of Object.entries(tags ?? {})) {
    const safeValue = tagValue(value);
    if (safeValue) {
      next[scrubString(key, activeScrubContext)] = safeValue;
    }
  }
  return next;
}

function filterIntegrations(
  integrations: CrashReportingIntegration[],
): CrashReportingIntegration[] {
  return integrations.filter((integration) => {
    const name = integration.name ?? "";
    return !BLOCKED_INTEGRATION_PATTERN.test(name.replace(/[^a-z0-9]/gi, ""));
  });
}

export function buildSentryOptions(
  config: ResolvedCrashReportingConfig,
  context: CrashReportingInitContext,
): CrashReportingSdkOptions {
  if (!config.dsn) {
    throw new Error("Crash reporting DSN is required before initializing Sentry.");
  }

  activeScrubContext = buildScrubContext(context);
  return {
    dsn: config.dsn,
    ...(config.release ? { release: config.release } : {}),
    environment: config.environment,
    sendDefaultPii: false,
    maxBreadcrumbs: 20,
    maxValueLength: MAX_STRING_LENGTH,
    normalizeDepth: 3,
    normalizeMaxBreadth: 40,
    tracesSampleRate: 0,
    enableLogs: false,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    initialScope: {
      tags: buildTags(config, context.tags),
    },
    integrations: filterIntegrations,
    beforeSend: (event) => scrubSentryEvent(event, activeScrubContext),
    beforeBreadcrumb: (breadcrumb) => scrubSentryBreadcrumb(breadcrumb, activeScrubContext),
  };
}

export async function initCrashReporting(
  context: CrashReportingInitContext,
): Promise<CrashReportingStatus> {
  const config = resolveCrashReportingConfig(context);
  activeScrubContext = buildScrubContext(context);

  if (!context.enabled || isNetworkTelemetryGloballyDisabled(context.env ?? {})) {
    await shutdownCrashReporting();
    return toStatus(config, false, "disabled");
  }

  if (!config.dsnConfigured) {
    await shutdownCrashReporting();
    return toStatus(config, false, "not_configured");
  }

  if (!context.loadSdk) {
    return toStatus(config, false, "missing_loader");
  }

  if (
    activeSdk &&
    activeConfig?.dsn === config.dsn &&
    activeConfig.component === config.component
  ) {
    return toStatus(config, true, "enabled");
  }

  if (initPromise) {
    return await initPromise;
  }

  initPromise = (async () => {
    try {
      const sdk = await context.loadSdk?.();
      if (!sdk) {
        return toStatus(config, false, "sdk_unavailable");
      }
      const options = buildSentryOptions(config, context);
      sdk.init(options);
      const tags = buildTags(config, context.tags);
      sdk.setTags?.(tags);
      activeSdk = sdk;
      activeConfig = config;
      return toStatus(config, true, "enabled");
    } catch (error) {
      activeSdk = null;
      activeConfig = null;
      return toStatus(config, false, "sdk_unavailable", errorDetail(error));
    } finally {
      initPromise = null;
    }
  })();

  return await initPromise;
}

export function captureError(error: unknown, context: CrashReportingCaptureContext = {}): void {
  if (!activeSdk?.captureException) {
    return;
  }

  const captureContext = scrubCaptureContext(context, activeScrubContext);
  const eventId = activeSdk.captureException(error, captureContext);
  if (typeof eventId === "string" && eventId.trim()) {
    recentCrashReportIds = [eventId.trim(), ...recentCrashReportIds].slice(0, 10);
  }
}

export function addBreadcrumb(breadcrumb: CrashReportingBreadcrumb): void {
  if (!activeSdk?.addBreadcrumb) {
    return;
  }
  const scrubbed = scrubSentryBreadcrumb(breadcrumb as Record<string, unknown>, activeScrubContext);
  if (!scrubbed) {
    return;
  }
  activeSdk.addBreadcrumb(scrubbed as CrashReportingBreadcrumb);
}

export async function setCrashReportingEnabled(enabled: boolean): Promise<void> {
  if (!enabled) {
    await shutdownCrashReporting();
  }
}

export async function shutdownCrashReporting(): Promise<void> {
  const sdk = activeSdk;
  activeSdk = null;
  activeConfig = null;
  initPromise = null;
  if (!sdk) {
    return;
  }

  try {
    if (sdk.close) {
      await sdk.close(SDK_SHUTDOWN_TIMEOUT_MS);
      return;
    }
    await sdk.flush?.(SDK_SHUTDOWN_TIMEOUT_MS);
  } catch {
    // Crash reporting must never block app shutdown.
  }
}

export function getRecentCrashReportIds(): string[] {
  return [...recentCrashReportIds];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

function isPayloadKey(key: string): boolean {
  return PAYLOAD_KEY_PATTERN.test(key);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactKnownPath(value: string, pathValue: string): string {
  const normalized = normalizeEnvValue(pathValue);
  if (!normalized) {
    return value;
  }
  let next = value;
  const variants = new Set([normalized, normalized.replaceAll("\\", "/")]);
  if (normalized.includes("/")) {
    variants.add(normalized.replaceAll("/", "\\"));
  }
  for (const variant of variants) {
    if (variant) {
      next = next.replace(new RegExp(escapeRegExp(variant), "g"), "[LOCAL_PATH]");
    }
  }
  return next;
}

function redactLocalUsername(value: string, homeDir: string | null): string {
  if (!homeDir) {
    return value;
  }
  const parts = homeDir.split(/[\\/]+/).filter(Boolean);
  const username = parts.at(-1);
  if (!username || username.length < 3) {
    return value;
  }
  return value.replace(new RegExp(`\\b${escapeRegExp(username)}\\b`, "g"), "[LOCAL_USER]");
}

function scrubString(value: string, context: ScrubContext): string {
  let next = redactSensitiveText(value);
  for (const workspacePath of context.workspacePaths) {
    next = redactKnownPath(next, workspacePath);
  }
  if (context.homeDir) {
    next = redactKnownPath(next, context.homeDir);
  }
  next = next.replace(
    /(?:file:\/\/)?\/(?:Users|home|private|tmp|var|Volumes)[^\s"'`<>{}[\]]*/g,
    "[LOCAL_PATH]",
  );
  next = next.replace(
    /\b[A-Za-z]:\\(?:Users|Documents and Settings|ProgramData|Temp|tmp)[^\s"'`<>{}[\]]*/g,
    "[LOCAL_PATH]",
  );
  next = redactLocalUsername(next, context.homeDir);
  if (next.length <= MAX_STRING_LENGTH) {
    return next;
  }
  return `${next.slice(0, MAX_STRING_LENGTH - 15)}[TRUNCATED]`;
}

function scrubUnknown(
  value: unknown,
  context: ScrubContext,
  opts: {
    key?: string;
    depth?: number;
    seen?: WeakSet<object>;
  } = {},
): unknown {
  const key = opts.key ?? "";
  if (key && isSensitiveKey(key)) {
    return "[REDACTED]";
  }
  if (key && isPayloadKey(key)) {
    return "[REDACTED]";
  }

  if (typeof value === "string") {
    return scrubString(value, context);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === undefined || typeof value === "bigint" || typeof value === "symbol") {
    return undefined;
  }
  if (typeof value === "function") {
    return "[Function]";
  }

  const depth = opts.depth ?? 0;
  if (depth >= MAX_OBJECT_DEPTH) {
    return Array.isArray(value) ? "[Array]" : "[Object]";
  }

  const seen = opts.seen ?? new WeakSet<object>();
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((entry) => scrubUnknown(entry, context, { depth: depth + 1, seen }));
  }

  if (!isRecord(value)) {
    return "[Object]";
  }

  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    if (REQUEST_CONTAINER_KEY_PATTERN.test(key) && REQUEST_PAYLOAD_KEY_PATTERN.test(entryKey)) {
      output[scrubString(entryKey, context)] = "[REDACTED]";
      continue;
    }
    const scrubbed = scrubUnknown(entryValue, context, {
      key: entryKey,
      depth: depth + 1,
      seen,
    });
    if (scrubbed !== undefined) {
      output[scrubString(entryKey, context)] = scrubbed;
    }
  }
  return output;
}

function scrubCaptureContext(
  context: CrashReportingCaptureContext,
  scrubContext: ScrubContext,
): CrashReportingCaptureContext {
  const scrubbed = scrubUnknown(context, scrubContext);
  return isRecord(scrubbed) ? (scrubbed as CrashReportingCaptureContext) : {};
}

export function scrubSentryEvent(
  event: CrashReportingEvent,
  context: ScrubContext = activeScrubContext,
): CrashReportingEvent | null {
  const scrubbed = scrubUnknown(event, context);
  return isRecord(scrubbed) ? scrubbed : null;
}

export function scrubSentryBreadcrumb(
  breadcrumb: CrashReportingEvent,
  context: ScrubContext = activeScrubContext,
): CrashReportingEvent | null {
  const category = typeof breadcrumb.category === "string" ? breadcrumb.category : "";
  if (DROPPED_BREADCRUMB_CATEGORY_PATTERN.test(category)) {
    return null;
  }

  const scrubbed = scrubUnknown(breadcrumb, context);
  return isRecord(scrubbed) ? scrubbed : null;
}

export const __internal = {
  buildSentryOptions,
  resolveEnvironment,
  scrubString,
  scrubSentryEvent,
  scrubSentryBreadcrumb,
  filterIntegrations,
  async resetCrashReportingForTests() {
    await shutdownCrashReporting();
    activeScrubContext = { workspacePaths: [], homeDir: null };
    recentCrashReportIds = [];
  },
};
