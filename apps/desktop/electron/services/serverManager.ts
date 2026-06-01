import { type ChildProcessByStdio, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { Readable } from "node:stream";
import { app } from "electron";
import { z } from "zod";
import {
  captureError,
  resolveCrashReportingConfig,
} from "../../../../src/telemetry/crashReporting";
import { resolveTelemetryConsent } from "../../../../src/telemetry/config";
import { captureProductEvent } from "../../../../src/telemetry/productAnalytics";
import {
  normalizePrivacyTelemetrySettings,
  type PersistedPrivacyTelemetrySettings,
  type PersistedProductAnalyticsState,
} from "../../src/app/types";
import { resolvePackagedBuiltinDistDir } from "./desktopBuiltinPaths";
import { flushLocalLogWrites, getLocalLogPath, writeLocalLog } from "./localLogs";
import type {
  MobileRelayTrustedDevicePermissionKey,
  MobileRelayTrustedPhoneDevice,
} from "./mobileRelayTypes";
import { buildDesktopProductAnalyticsEnv } from "./productAnalytics";
import {
  buildSourceEnvForAttempt,
  getServerTerminationSignal,
  getSourceStartupAttemptCount,
} from "./serverPlatform";
import {
  FOUNDATION_MODELS_SDK_DIR_NAME,
  findPackagedSidecarLaunchCommand,
  hasPackagedFoundationModelsSdk,
  hasPackagedWindowsAiElectronPackage,
  WINDOWS_AI_ELECTRON_DIR_NAME,
} from "./sidecar";
import { assertSafeId, assertWorkspaceDirectory } from "./validation";

const DEFAULT_SERVER_STARTUP_TIMEOUT_MS = 45_000;
const MIN_SERVER_STARTUP_TIMEOUT_MS = 5_000;
const MAX_SERVER_STARTUP_TIMEOUT_MS = 300_000;
const STDERR_TAIL_LIMIT = 16_384;
const SERVER_LOG_FILE_NAME = "server.log";
const DEBUG_SERVER_STDERR = process.env.COWORK_DESKTOP_DEBUG_SERVER_STDERR === "1";

const OBSERVABILITY_ENV_PREFIXES = ["AGENT_OBSERVABILITY_", "LANGFUSE_"] as const;
const CRASH_REPORTING_ENV_PREFIXES = ["COWORK_SENTRY_", "SENTRY_"] as const;
const PRODUCT_ANALYTICS_ENV_PREFIXES = ["COWORK_POSTHOG_", "POSTHOG_"] as const;

type ServerHandle = {
  child: ServerChildProcess;
  url: string;
  mobileH3: ServerListening["mobileH3"];
  cleanup: () => void;
};

type PendingServerHandle = {
  child: ServerChildProcess;
  cleanup: () => void;
};

type ServerChildProcess = ChildProcessByStdio<null, Readable, Readable>;

type ServerListening = {
  type: "server_listening";
  url: string;
  port: number;
  cwd: string;
  browserAccessToken?: string | null;
  mobileH3?: {
    url: string;
    port: number;
    hostHints: string[];
    ticket: string;
    adminToken: string;
    certSha256: string;
    spkiSha256: string;
    identityPub: string;
    nonce: string;
    expiresAt: number;
    trustedDevice: {
      deviceId: string;
      fingerprint: string;
      displayName: string | null;
      lastPairedAt: string | null;
      lastConnectedAt: string | null;
      permissions: Record<MobileRelayTrustedDevicePermissionKey, boolean>;
    } | null;
    trustedDevices: MobileRelayTrustedPhoneDevice[];
  } | null;
};

type StartWorkspaceServerOptions = {
  workspaceId: string;
  workspacePath: string;
  yolo: boolean;
  featureFlags?: { openAiNativeConnectors?: boolean };
  privacyTelemetrySettings?: PersistedPrivacyTelemetrySettings | null;
  productAnalyticsState?: PersistedProductAnalyticsState | null;
  mobileH3?: boolean;
  rotateMobileH3Tls?: boolean;
};

type ServerManagerOptions = {
  getProductAnalyticsState?: () => PersistedProductAnalyticsState | null | undefined;
};

const trustedDevicePermissionSchema = z.preprocess(
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

const trustedDeviceSchema = z.object({
  deviceId: z.string().min(1),
  fingerprint: z.string().min(1),
  displayName: z.string().nullable(),
  lastPairedAt: z.string().nullable().optional().default(null),
  lastConnectedAt: z.string().nullable().optional().default(null),
  permissions: trustedDevicePermissionSchema,
});

const trustedDevicesResponseSchema = z.object({
  trustedDevices: z.array(trustedDeviceSchema).optional().default([]),
});

const serverListeningSchema = z
  .object({
    type: z.literal("server_listening"),
    url: z.string().min(1),
    port: z.number(),
    cwd: z.string().min(1),
    browserAccessToken: z.string().min(1).nullable().optional(),
    mobileH3: z
      .object({
        url: z.string().min(1),
        port: z.number(),
        hostHints: z.array(z.string().min(1)).min(1),
        ticket: z.string().min(1),
        adminToken: z.string().min(1),
        certSha256: z.string().min(1),
        spkiSha256: z.string().min(1),
        identityPub: z.string().min(1),
        nonce: z.string().min(1),
        expiresAt: z.number(),
        trustedDevice: z
          .union([
            trustedDeviceSchema,
            z
              .object({
                deviceId: z.string().min(1),
                fingerprint: z.string().min(1),
                displayName: z.string().nullable(),
              })
              .transform((device) => ({
                ...device,
                lastPairedAt: null,
                lastConnectedAt: null,
                permissions: {
                  turns: false,
                  serverRequests: false,
                  providerAuth: false,
                  mcpAuth: false,
                  workspaceSettings: false,
                  backups: false,
                },
              })),
          ])
          .nullable()
          .optional()
          .default(null),
        trustedDevices: z.array(trustedDeviceSchema).optional().default([]),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

function resolveRepoRoot(): string {
  const fromEnv = process.env.COWORK_REPO_ROOT;
  if (fromEnv && fs.existsSync(path.join(fromEnv, "src", "server", "index.ts"))) {
    return fromEnv;
  }

  const candidates = [
    path.resolve(app.getAppPath(), "../.."),
    path.resolve(process.cwd(), "../.."),
    path.resolve(process.cwd()),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "src", "server", "index.ts"))) {
      return candidate;
    }
  }

  throw new Error("Unable to locate repository root for development server startup");
}

function getSidecarSearchDirs(): string[] {
  const fromEnv = process.env.COWORK_DESKTOP_SIDECAR_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return [path.dirname(fromEnv)];
  }

  if (app.isPackaged) {
    return [path.join(process.resourcesPath, "binaries"), process.resourcesPath];
  }

  const appRoot = app.getAppPath();
  return [path.join(appRoot, "resources", "binaries")];
}

function findSidecarLaunchCommand() {
  return findPackagedSidecarLaunchCommand(getSidecarSearchDirs(), {
    explicitPath: process.env.COWORK_DESKTOP_SIDECAR_PATH,
  });
}

function findBundledCodexPrimaryRuntimeDir(): string | null {
  const fromEnv = process.env.COWORK_BUNDLED_CODEX_PRIMARY_RUNTIME_DIR;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv;
  }

  if (!app.isPackaged) {
    try {
      const devRepoRoot = resolveRepoRoot();
      const candidate = path.join(devRepoRoot, "dist", "codex-primary-runtime");
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }

  const builtInDist = resolvePackagedBuiltinDistDir();
  if (!builtInDist) {
    return null;
  }
  const candidate = path.join(builtInDist, "codex-primary-runtime");
  return fs.existsSync(candidate) ? candidate : null;
}

function findBundledArtifactRuntimeDir(): string | null {
  const fromEnv = process.env.COWORK_BUNDLED_ARTIFACT_RUNTIME_DIR;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv;
  }

  const isUsable = (dir: string): boolean =>
    fs.existsSync(path.join(dir, "runtime.json")) ||
    fs.existsSync(path.join(dir, "node", "node_modules", "@oai", "artifact-tool"));

  if (!app.isPackaged) {
    try {
      const devRepoRoot = resolveRepoRoot();
      const candidate = path.join(devRepoRoot, "dist", "artifact-runtime");
      if (isUsable(candidate)) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }

  const builtInDist = resolvePackagedBuiltinDistDir();
  if (!builtInDist) {
    return null;
  }
  const candidate = path.join(builtInDist, "artifact-runtime");
  return isUsable(candidate) ? candidate : null;
}

function findBundledFoundationModelsSdkDir(): string | null {
  for (const dir of getSidecarSearchDirs()) {
    const candidate = path.join(dir, FOUNDATION_MODELS_SDK_DIR_NAME);
    if (hasPackagedFoundationModelsSdk(candidate)) {
      return candidate;
    }
  }
  return null;
}

function findBundledWindowsAiElectronDir(): string | null {
  for (const dir of getSidecarSearchDirs()) {
    const candidate = path.join(dir, WINDOWS_AI_ELECTRON_DIR_NAME);
    if (hasPackagedWindowsAiElectronPackage(candidate)) {
      return candidate;
    }
  }
  return null;
}

function waitForExit(child: ServerChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };

    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);

    child.once("exit", onExit);
  });
}

async function gracefulKill(child: ServerChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    const signal = getServerTerminationSignal();
    if (signal) {
      child.kill(signal);
    } else {
      child.kill();
    }
  } catch {
    // ignore; process may already be gone
  }

  const exited = await waitForExit(child, 3_000);
  if (exited) {
    return;
  }

  try {
    child.kill("SIGKILL");
  } catch {
    // ignore
  }

  await waitForExit(child, 1_000);
}

function getServerStartupTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.COWORK_DESKTOP_SERVER_STARTUP_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SERVER_STARTUP_TIMEOUT_MS;
  }
  return Math.min(
    MAX_SERVER_STARTUP_TIMEOUT_MS,
    Math.max(MIN_SERVER_STARTUP_TIMEOUT_MS, Math.floor(parsed)),
  );
}

function waitForServerListening(
  child: ServerChildProcess,
  timeoutMs = getServerStartupTimeoutMs(),
): Promise<ServerListening> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: child.stdout });
    const recentLines: string[] = [];

    const recordLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      recentLines.push(trimmed);
      if (recentLines.length > 5) {
        recentLines.shift();
      }
    };

    const withRecentOutput = (message: string) => {
      if (recentLines.length === 0) {
        return message;
      }
      return `${message}; output=${recentLines.join(" | ")}`;
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          withRecentOutput(
            `Server exited before startup JSON (code=${code ?? "null"}, signal=${signal ?? "null"})`,
          ),
        ),
      );
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(withRecentOutput(`Server startup timed out after ${timeoutMs / 1000} seconds`)),
      );
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      rl.off("line", onLine);
      rl.close();
      child.off("error", onError);
      child.off("exit", onExit);
    };

    const onLine = (line: string) => {
      recordLine(line);
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      try {
        const parsed = serverListeningSchema.safeParse(JSON.parse(trimmed));
        if (!parsed.success) return;
        cleanup();
        resolve(parsed.data);
      } catch {
        // Ignore non-JSON lines while waiting for the startup event.
      }
    };

    rl.on("line", onLine);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function buildSpawnArgs(workspacePath: string, yolo: boolean, mobileH3 = false): string[] {
  const args = ["--dir", workspacePath, "--port", "0", "--json"];
  if (mobileH3) {
    args.push("--mobile-h3");
  }
  if (yolo) {
    args.push("--yolo");
  }
  return args;
}

function resolveSourceStartup(
  useSource: boolean,
  resolveRepoRootImpl: () => string = resolveRepoRoot,
): { repoRoot: string | null; sourceEntry: string | null } {
  if (!useSource) {
    return { repoRoot: null, sourceEntry: null };
  }

  const repoRoot = resolveRepoRootImpl();
  const sourceEntry = path.join(repoRoot, "src", "server", "index.ts");
  if (!fs.existsSync(sourceEntry)) {
    throw new Error(`Server entrypoint not found: ${sourceEntry}`);
  }

  return { repoRoot, sourceEntry };
}

function buildServerEnv(
  featureFlags?: { openAiNativeConnectors?: boolean },
  opts: {
    includeBundledFoundationModelsSdk?: boolean;
    includeBundledWindowsAiElectron?: boolean;
    rotateMobileH3Tls?: boolean;
    privacyTelemetrySettings?: PersistedPrivacyTelemetrySettings | null;
    productAnalyticsState?: PersistedProductAnalyticsState | null;
  } = {},
): NodeJS.ProcessEnv {
  const bundledCodexPrimaryRuntime = findBundledCodexPrimaryRuntimeDir();
  const bundledArtifactRuntime = findBundledArtifactRuntimeDir();
  const bundledFoundationModelsSdk =
    opts.includeBundledFoundationModelsSdk && !process.env.COWORK_TSFMSDK_DIR
      ? findBundledFoundationModelsSdkDir()
      : null;
  const bundledWindowsAiElectron =
    opts.includeBundledWindowsAiElectron && !process.env.COWORK_WINDOWS_AI_ELECTRON_DIR
      ? findBundledWindowsAiElectronDir()
      : null;
  const privacyTelemetrySettings = resolveTelemetryConsent({
    settings: opts.privacyTelemetrySettings,
    env: process.env,
    isPackaged: app.isPackaged,
  });
  const inheritedEnv = privacyTelemetrySettings.aiTraceTelemetryEnabled
    ? { ...process.env }
    : withoutInheritedObservabilityEnv(process.env);
  const processEnv = withoutInheritedProductAnalyticsEnv(
    withoutInheritedCrashReportingEnv(inheritedEnv),
  );
  return {
    ...processEnv,
    COWORK_WEB_DESKTOP_SERVICE: "1",
    COWORK_DESKTOP_USER_DATA_DIR: app.getPath("userData"),
    COWORK_BROWSER_ACCESS_TOKEN:
      process.env.COWORK_BROWSER_ACCESS_TOKEN?.trim() ||
      `${randomUUID()}${randomUUID().replaceAll("-", "")}`,
    COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: process.env.COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP ?? "1",
    ...(bundledCodexPrimaryRuntime
      ? { COWORK_BUNDLED_CODEX_PRIMARY_RUNTIME_DIR: bundledCodexPrimaryRuntime }
      : {}),
    ...(bundledArtifactRuntime
      ? { COWORK_BUNDLED_ARTIFACT_RUNTIME_DIR: bundledArtifactRuntime }
      : {}),
    ...(bundledFoundationModelsSdk ? { COWORK_TSFMSDK_DIR: bundledFoundationModelsSdk } : {}),
    ...(bundledWindowsAiElectron
      ? { COWORK_WINDOWS_AI_ELECTRON_DIR: bundledWindowsAiElectron }
      : {}),
    ...(featureFlags?.openAiNativeConnectors
      ? { COWORK_EXPERIMENTAL_OPENAI_NATIVE_CONNECTORS: "1" }
      : {}),
    ...(opts.rotateMobileH3Tls ? { COWORK_H3_ROTATE_TLS: "1" } : {}),
    ...buildDesktopObservabilityEnv(privacyTelemetrySettings),
    ...buildDesktopCrashReportingEnv(privacyTelemetrySettings),
    ...buildDesktopProductAnalyticsEnv(privacyTelemetrySettings, opts.productAnalyticsState),
  };
}

function withoutInheritedObservabilityEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (OBSERVABILITY_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete next[key];
    }
  }
  return next;
}

function withoutInheritedCrashReportingEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (
      key === "COWORK_CRASH_REPORTS_ENABLED" ||
      CRASH_REPORTING_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      delete next[key];
    }
  }
  return next;
}

function withoutInheritedProductAnalyticsEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (
      key === "COWORK_PRODUCT_ANALYTICS_ENABLED" ||
      key === "COWORK_PRODUCT_ANALYTICS_INSTALLATION_ID" ||
      PRODUCT_ANALYTICS_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      delete next[key];
    }
  }
  return next;
}

function resolveAppRelease(): string {
  const version = (app as { getVersion?: () => string }).getVersion?.().trim();
  return version || "unknown";
}

function buildDesktopObservabilityEnv(
  privacyTelemetrySettings: ReturnType<typeof normalizePrivacyTelemetrySettings>,
): NodeJS.ProcessEnv {
  if (!privacyTelemetrySettings.aiTraceTelemetryEnabled) {
    return {
      AGENT_OBSERVABILITY_ENABLED: "false",
      AGENT_OBSERVABILITY_RECORD_INPUTS: "false",
      AGENT_OBSERVABILITY_RECORD_OUTPUTS: "false",
      AGENT_OBSERVABILITY_RECORD_PAYLOADS: "false",
    };
  }

  const recordPayloads = privacyTelemetrySettings.aiTracePayloadsEnabled ? "true" : "false";
  return {
    AGENT_OBSERVABILITY_ENABLED: "true",
    AGENT_OBSERVABILITY_RECORD_INPUTS: recordPayloads,
    AGENT_OBSERVABILITY_RECORD_OUTPUTS: recordPayloads,
    AGENT_OBSERVABILITY_RECORD_PAYLOADS: recordPayloads,
    LANGFUSE_TRACING_ENVIRONMENT: app.isPackaged ? "desktop-packaged" : "desktop-dev",
    LANGFUSE_RELEASE: resolveAppRelease(),
  };
}

function buildDesktopCrashReportingEnv(
  privacyTelemetrySettings: ReturnType<typeof normalizePrivacyTelemetrySettings>,
): NodeJS.ProcessEnv {
  const release = resolveAppRelease();
  const config = resolveCrashReportingConfig({
    component: "cowork-server",
    enabled: privacyTelemetrySettings.crashReportsEnabled,
    env: process.env,
    fallbackRelease: release,
    appVersion: release,
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
  });

  if (!config.enabled || !config.dsn) {
    return {
      COWORK_CRASH_REPORTS_ENABLED: "false",
    };
  }

  return {
    COWORK_CRASH_REPORTS_ENABLED: "true",
    COWORK_SENTRY_DSN: config.dsn,
    COWORK_RELEASE: config.release ?? release,
    COWORK_SENTRY_ENVIRONMENT: config.environment,
  };
}

function appendBrowserAccessToken(websocketUrl: string, token?: string | null): string {
  const trimmed = token?.trim();
  if (!trimmed) return websocketUrl;
  try {
    const url = new URL(websocketUrl);
    url.searchParams.set("coworkBrowserToken", trimmed);
    return url.toString();
  } catch {
    return websocketUrl;
  }
}

function isLikelyBunSegfault(stderrOutput: string): boolean {
  const normalized = stderrOutput.toLowerCase();
  return (
    normalized.includes("panic(main thread)") ||
    normalized.includes("segmentation fault") ||
    normalized.includes("bun has crashed")
  );
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function toHttpServerUrl(websocketUrl: string): string {
  const url = new URL(websocketUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}

function getServerLogPath(): string {
  return getLocalLogPath(SERVER_LOG_FILE_NAME);
}

function logServerManagerEvent(message: string, meta?: unknown): void {
  writeLocalLog(SERVER_LOG_FILE_NAME, "info", "server-manager", message, meta);
}

async function flushServerManagerLogWrites(): Promise<void> {
  await flushLocalLogWrites(SERVER_LOG_FILE_NAME);
}

function summarizeLogChunk(chunk: string): string {
  return chunk.replace(/\s+/g, " ").trim().slice(0, 1000);
}

function withStderrTail(message: string, stderrTail: string): string {
  const summary = summarizeLogChunk(stderrTail);
  return summary ? `${message}; stderr=${summary}` : message;
}

function captureWorkspaceServerStartupFailure(input: {
  error: unknown;
  workspaceId: string;
  mode: "source" | "packaged";
  attempt: number;
}): void {
  captureError(input.error, {
    tags: {
      operation: "workspace_server_start",
      mode: input.mode,
      attempt: input.attempt,
    },
    extra: {
      workspaceId: input.workspaceId,
    },
  });
}

function shouldReplaceForMobileH3Request(
  requestedMobileH3: boolean | undefined,
  existingMobileH3: ServerListening["mobileH3"],
): boolean {
  return requestedMobileH3 !== undefined && requestedMobileH3 !== Boolean(existingMobileH3);
}

export class ServerManager {
  private readonly servers = new Map<string, ServerHandle>();
  private readonly pendingStarts = new Map<string, PendingServerHandle>();

  constructor(private readonly options: ServerManagerOptions = {}) {}

  async startWorkspaceServer(
    opts: StartWorkspaceServerOptions,
  ): Promise<{ url: string; mobileH3: ServerListening["mobileH3"] }> {
    const { workspaceId, workspacePath, yolo } = opts;

    assertSafeId(workspaceId, "workspaceId");
    await assertWorkspaceDirectory(workspacePath);
    const startedAt = Date.now();
    const productAnalyticsState =
      opts.productAnalyticsState ?? this.options.getProductAnalyticsState?.() ?? null;

    const existing = this.servers.get(workspaceId);
    if (existing) {
      if (existing.child.exitCode === null && existing.child.signalCode === null) {
        if (shouldReplaceForMobileH3Request(opts.mobileH3, existing.mobileH3)) {
          const replacementPending = { child: existing.child, cleanup: existing.cleanup };
          this.pendingStarts.set(workspaceId, replacementPending);
          this.servers.delete(workspaceId);
          await gracefulKill(existing.child);
          if (this.pendingStarts.get(workspaceId) === replacementPending) {
            this.pendingStarts.delete(workspaceId);
          }
          existing.cleanup();
        } else {
          captureProductEvent("workspace_server_started", {
            eventSource: "main",
            status: "reused",
            durationMs: Date.now() - startedAt,
            yoloEnabled: yolo,
          });
          return { url: existing.url, mobileH3: existing.mobileH3 };
        }
      }
      if (this.servers.get(workspaceId) === existing) {
        this.servers.delete(workspaceId);
        existing.cleanup();
      }
    }

    const pending = this.pendingStarts.get(workspaceId);
    if (pending) {
      if (pending.child.exitCode === null && pending.child.signalCode === null) {
        throw new Error("Workspace server startup already in progress");
      }
      this.pendingStarts.delete(workspaceId);
      pending.cleanup();
    }

    const useSource = !app.isPackaged || process.env.COWORK_DESKTOP_USE_SOURCE === "1";
    const spawnArgs = buildSpawnArgs(workspacePath, yolo, opts.mobileH3 === true);
    const { repoRoot, sourceEntry } = resolveSourceStartup(useSource);

    const sidecar = !useSource ? findSidecarLaunchCommand() : null;
    const builtInDir = !useSource ? resolvePackagedBuiltinDistDir() : null;
    if (!useSource && !builtInDir) {
      throw new Error(
        `Bundled dist directory not found: ${path.join(process.resourcesPath, "dist")}`,
      );
    }

    logServerManagerEvent("workspace server start requested", {
      workspaceId,
      mode: useSource ? "source" : "packaged",
      workspacePath,
      yolo,
    });

    const attemptCount = getSourceStartupAttemptCount(useSource);
    let previousError: unknown = null;

    for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
      const serverEnv = buildServerEnv(opts.featureFlags, {
        includeBundledFoundationModelsSdk: !useSource,
        includeBundledWindowsAiElectron: !useSource,
        rotateMobileH3Tls: opts.rotateMobileH3Tls === true,
        privacyTelemetrySettings: opts.privacyTelemetrySettings,
        productAnalyticsState,
      });
      const sourceEnvForAttempt = useSource ? buildSourceEnvForAttempt(serverEnv, attempt) : null;
      const cleanup = sourceEnvForAttempt?.cleanup ?? (() => {});

      let child: ServerChildProcess;
      let spawnDescription: string;
      if (useSource) {
        if (!sourceEntry || !repoRoot || !sourceEnvForAttempt) {
          throw new Error("Source server startup configuration is incomplete.");
        }
        child = spawn("bun", [sourceEntry, ...spawnArgs], {
          cwd: repoRoot,
          stdio: ["ignore", "pipe", "pipe"],
          env: sourceEnvForAttempt.env,
        });
        spawnDescription = "bun";
      } else {
        if (!sidecar || !builtInDir) {
          throw new Error("Packaged server startup configuration is incomplete.");
        }
        child = spawn(sidecar.command, [...sidecar.args, ...spawnArgs], {
          cwd: process.resourcesPath,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...serverEnv,
            COWORK_BUILTIN_DIR: builtInDir,
            COWORK_DESKTOP_BUNDLE: "1",
          },
        });
        spawnDescription = `${path.basename(sidecar.command)} ${sidecar.args.join(" ")}`.trim();
      }

      logServerManagerEvent("workspace server spawn attempt", {
        workspaceId,
        attempt,
        attemptCount,
        spawn: spawnDescription,
      });

      let cleaned = false;
      const cleanupOnce = () => {
        if (cleaned) {
          return;
        }
        cleaned = true;
        cleanup();
      };

      this.pendingStarts.set(workspaceId, { child, cleanup: cleanupOnce });

      let stderrTail = "";
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderrTail += text;
        if (stderrTail.length > STDERR_TAIL_LIMIT) {
          stderrTail = stderrTail.slice(-STDERR_TAIL_LIMIT);
        }
        if (DEBUG_SERVER_STDERR) {
          process.stderr.write(`[cowork-server] ${text}`);
        }
        logServerManagerEvent("workspace server stderr emitted", {
          workspaceId,
          bytes: Buffer.byteLength(text),
          bunCrash: isLikelyBunSegfault(text),
        });
      });

      try {
        const listening = await waitForServerListening(child);
        const url = appendBrowserAccessToken(listening.url, listening.browserAccessToken);
        logServerManagerEvent("workspace server listening", {
          workspaceId,
          url: listening.url,
        });
        const pendingHandle = this.pendingStarts.get(workspaceId);
        if (pendingHandle?.child === child) {
          this.pendingStarts.delete(workspaceId);
        }

        this.servers.set(workspaceId, {
          child,
          url,
          mobileH3: listening.mobileH3 ?? null,
          cleanup: cleanupOnce,
        });

        captureProductEvent("workspace_server_started", {
          eventSource: "main",
          status: "started",
          durationMs: Date.now() - startedAt,
          yoloEnabled: yolo,
        });

        child.once("exit", () => {
          const pendingExit = this.pendingStarts.get(workspaceId);
          if (pendingExit?.child === child) {
            this.pendingStarts.delete(workspaceId);
          }
          cleanupOnce();
          const handle = this.servers.get(workspaceId);
          if (handle?.child === child) {
            this.servers.delete(workspaceId);
          }
        });

        return { url, mobileH3: listening.mobileH3 ?? null };
      } catch (error) {
        await gracefulKill(child);
        const pendingHandle = this.pendingStarts.get(workspaceId);
        if (pendingHandle?.child === child) {
          this.pendingStarts.delete(workspaceId);
        }
        cleanupOnce();

        const shouldRetry =
          useSource &&
          process.platform === "win32" &&
          attempt < attemptCount &&
          isLikelyBunSegfault(stderrTail);

        if (shouldRetry) {
          previousError = error;
          logServerManagerEvent("workspace server retrying after Bun crash", {
            workspaceId,
            attempt,
            error: toErrorMessage(error),
          });
          if (DEBUG_SERVER_STDERR) {
            process.stderr.write(
              "[cowork-server] Bun crashed during startup; retrying with async transpiler disabled.\n",
            );
          }
          continue;
        }

        if (isLikelyBunSegfault(stderrTail)) {
          captureWorkspaceServerStartupFailure({
            error,
            workspaceId,
            mode: useSource ? "source" : "packaged",
            attempt,
          });
          logServerManagerEvent("workspace server Bun crash", {
            workspaceId,
            error: toErrorMessage(error),
            stderrBytes: Buffer.byteLength(stderrTail),
          });
          captureProductEvent("workspace_server_failed", {
            eventSource: "main",
            status: "failed",
            errorCategory: "bun_crash",
            durationMs: Date.now() - startedAt,
          });
          throw new Error(
            withStderrTail(
              `Cowork server crashed inside Bun while starting: ${toErrorMessage(error)}. ` +
                "Try upgrading Bun and retrying.",
              stderrTail,
            ),
          );
        }

        captureWorkspaceServerStartupFailure({
          error,
          workspaceId,
          mode: useSource ? "source" : "packaged",
          attempt,
        });
        logServerManagerEvent("workspace server start failed", {
          workspaceId,
          error: toErrorMessage(error),
          stderrBytes: Buffer.byteLength(stderrTail),
        });
        captureProductEvent("workspace_server_failed", {
          eventSource: "main",
          status: "failed",
          errorCategory: "startup_failed",
          durationMs: Date.now() - startedAt,
        });
        const message = withStderrTail(toErrorMessage(error), stderrTail);
        throw error instanceof Error ? new Error(message, { cause: error }) : new Error(message);
      }
    }

    throw (previousError as Error) ?? new Error("Failed to start workspace server");
  }

  async stopWorkspaceServer(workspaceId: string): Promise<void> {
    assertSafeId(workspaceId, "workspaceId");

    const pending = this.pendingStarts.get(workspaceId);
    if (pending) {
      this.pendingStarts.delete(workspaceId);
      await gracefulKill(pending.child);
      pending.cleanup();
    }

    const handle = this.servers.get(workspaceId);
    if (!handle) {
      return;
    }

    this.servers.delete(workspaceId);
    await gracefulKill(handle.child);
    handle.cleanup();
  }

  async restartWorkspaceServer(
    opts: StartWorkspaceServerOptions,
  ): Promise<{ url: string; mobileH3: ServerListening["mobileH3"] }> {
    await this.stopWorkspaceServer(opts.workspaceId);
    return await this.startWorkspaceServer(opts);
  }

  async listMobileH3TrustedDevices(workspaceId: string): Promise<MobileRelayTrustedPhoneDevice[]> {
    assertSafeId(workspaceId, "workspaceId");
    const handle = this.servers.get(workspaceId);
    if (!handle?.mobileH3) {
      throw new Error("Mobile H3 endpoint is not running.");
    }
    const response = await fetch(`${toHttpServerUrl(handle.url)}/mobile-h3/trusted`, {
      headers: {
        authorization: `Bearer ${handle.mobileH3.adminToken}`,
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to list mobile trust records: HTTP ${response.status}.`);
    }
    const payload = trustedDevicesResponseSchema.parse(await response.json());
    handle.mobileH3 = {
      ...handle.mobileH3,
      trustedDevice: payload.trustedDevices[0] ?? null,
      trustedDevices: payload.trustedDevices,
    };
    return payload.trustedDevices;
  }

  async revokeMobileH3TrustedDevice(workspaceId: string, deviceId: string): Promise<void> {
    assertSafeId(workspaceId, "workspaceId");
    const handle = this.servers.get(workspaceId);
    if (!handle?.mobileH3) {
      throw new Error("Mobile H3 endpoint is not running.");
    }
    const response = await fetch(
      `${toHttpServerUrl(handle.url)}/mobile-h3/trusted/${encodeURIComponent(deviceId)}`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${handle.mobileH3.adminToken}`,
        },
      },
    );
    if (!response.ok) {
      throw new Error(`Failed to revoke mobile trust record: HTTP ${response.status}.`);
    }
    handle.mobileH3 = {
      ...handle.mobileH3,
      trustedDevice:
        handle.mobileH3.trustedDevice?.deviceId === deviceId ? null : handle.mobileH3.trustedDevice,
      trustedDevices: handle.mobileH3.trustedDevices.filter(
        (device) => device.deviceId !== deviceId,
      ),
    };
  }

  async updateMobileH3TrustedDevicePermissions(
    workspaceId: string,
    deviceId: string,
    permissions: Partial<Record<MobileRelayTrustedDevicePermissionKey, boolean>>,
  ): Promise<MobileRelayTrustedPhoneDevice> {
    assertSafeId(workspaceId, "workspaceId");
    const handle = this.servers.get(workspaceId);
    if (!handle?.mobileH3) {
      throw new Error("Mobile H3 endpoint is not running.");
    }
    const response = await fetch(
      `${toHttpServerUrl(handle.url)}/mobile-h3/trusted/${encodeURIComponent(deviceId)}/permissions`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${handle.mobileH3.adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ permissions }),
      },
    );
    if (!response.ok) {
      throw new Error(`Failed to update mobile trust permissions: HTTP ${response.status}.`);
    }
    const payload = (await response.json()) as { trustedDevice?: MobileRelayTrustedPhoneDevice };
    if (!payload.trustedDevice) {
      throw new Error("Mobile H3 endpoint returned an invalid trust record.");
    }
    const trustedDevices = handle.mobileH3.trustedDevices.filter(
      (device) => device.deviceId !== payload.trustedDevice?.deviceId,
    );
    trustedDevices.unshift(payload.trustedDevice);
    handle.mobileH3 = {
      ...handle.mobileH3,
      trustedDevice:
        handle.mobileH3.trustedDevice?.deviceId === payload.trustedDevice.deviceId
          ? payload.trustedDevice
          : handle.mobileH3.trustedDevice,
      trustedDevices,
    };
    return payload.trustedDevice;
  }

  async revokeMobileH3TrustedDevices(workspaceId: string): Promise<void> {
    assertSafeId(workspaceId, "workspaceId");
    const handle = this.servers.get(workspaceId);
    if (!handle?.mobileH3) {
      throw new Error("Mobile H3 endpoint is not running.");
    }
    const response = await fetch(`${toHttpServerUrl(handle.url)}/mobile-h3/trusted`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${handle.mobileH3.adminToken}`,
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to revoke mobile trust records: HTTP ${response.status}.`);
    }
    handle.mobileH3 = {
      ...handle.mobileH3,
      trustedDevice: null,
      trustedDevices: [],
    };
  }

  async stopAll(): Promise<void> {
    const entries = [...this.servers.entries()];
    this.servers.clear();
    const pendingEntries = [...this.pendingStarts.entries()];
    this.pendingStarts.clear();

    const killPromises = [
      ...entries.map(async ([, handle]) => {
        await gracefulKill(handle.child);
        handle.cleanup();
      }),
      ...pendingEntries.map(async ([, handle]) => {
        await gracefulKill(handle.child);
        handle.cleanup();
      }),
    ];

    await Promise.all(killPromises);
  }
}

export const __internal = {
  buildDesktopCrashReportingEnv,
  buildServerEnv,
  buildSourceEnvForAttempt,
  findBundledFoundationModelsSdkDir,
  findBundledWindowsAiElectronDir,
  findSidecarLaunchCommand,
  getServerTerminationSignal,
  getServerLogPath,
  getServerStartupTimeoutMs,
  appendBrowserAccessToken,
  getSourceStartupAttemptCount,
  isLikelyBunSegfault,
  logServerManagerEvent,
  flushServerManagerLogWrites,
  resolveSourceStartup,
  shouldReplaceForMobileH3Request,
  summarizeLogChunk,
  withStderrTail,
  waitForServerListening,
  withoutInheritedCrashReportingEnv,
  withoutInheritedObservabilityEnv,
  withoutInheritedProductAnalyticsEnv,
};
