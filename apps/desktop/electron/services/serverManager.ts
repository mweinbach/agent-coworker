import { type ChildProcessByStdio, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { Readable } from "node:stream";
import { app } from "electron";
import { z } from "zod";
import {
  COWORK_RUNTIME_BOOTSTRAP_PHASES,
  type CoworkRuntimeBootstrapProgress,
} from "../../../../src/coworkRuntime/types";
import { findWindowsHelper } from "../../../../src/platform/sandbox/detect";
import {
  WINDOWS_SANDBOX_COMMAND_RUNNER_NAME,
  WINDOWS_SANDBOX_HASH_MANIFEST_NAME,
  WINDOWS_SANDBOX_HELPER_NAME,
  WINDOWS_SANDBOX_SETUP_NAME,
} from "../../../../src/platform/sandbox/windows";
import {
  COWORK_RUNTIME_STARTUP_COMPONENT,
  SERVER_STARTUP_PROGRESS_TYPE,
} from "../../../../src/server/startupProgress";
import { resolveTelemetryConsent } from "../../../../src/telemetry/config";
import {
  captureError,
  resolveCrashReportingConfig,
} from "../../../../src/telemetry/crashReporting";
import { captureProductEvent } from "../../../../src/telemetry/productAnalytics";
import type {
  normalizePrivacyTelemetrySettings,
  PersistedPrivacyTelemetrySettings,
  PersistedProductAnalyticsState,
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
import { writeWindowsSandboxReadiness } from "./windowsSandboxReadiness";

const DEFAULT_SERVER_STARTUP_TIMEOUT_MS = 45_000;
const PACKAGED_SERVER_STARTUP_TIMEOUT_MS = 300_000;
const MIN_SERVER_STARTUP_TIMEOUT_MS = 5_000;
const MAX_SERVER_STARTUP_TIMEOUT_MS = 300_000;
const SERVER_HEALTH_TIMEOUT_MS = 1_500;
const STDERR_TAIL_LIMIT = 16_384;
const SERVER_LOG_FILE_NAME = "server.log";
const MIRROR_SERVER_OUTPUT_PREFIX = "[cowork-server";
let windowsSandboxSetupAttempted = false;

const OBSERVABILITY_ENV_PREFIXES = ["AGENT_OBSERVABILITY_", "LANGFUSE_"] as const;
const CRASH_REPORTING_ENV_PREFIXES = ["COWORK_SENTRY_", "SENTRY_"] as const;
const PRODUCT_ANALYTICS_ENV_PREFIXES = ["COWORK_POSTHOG_", "POSTHOG_"] as const;
const TELEMETRY_CONSENT_ENV_KEYS = [
  "COWORK_CRASH_REPORTS_ENABLED",
  "COWORK_PRODUCT_ANALYTICS_ENABLED",
  "AGENT_OBSERVABILITY_ENABLED",
  "AGENT_OBSERVABILITY_RECORD_INPUTS",
  "AGENT_OBSERVABILITY_RECORD_OUTPUTS",
  "AGENT_OBSERVABILITY_RECORD_PAYLOADS",
  "COWORK_CLOUD_SYNC_ENABLED",
] as const;

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

type ServerOutputSource = "stdout" | "stderr";

type ServerOutputMirror = {
  flush: () => void;
  writeChunk: (source: ServerOutputSource, chunk: string) => void;
  writeLine: (source: ServerOutputSource, line: string) => void;
};

type WaitForServerListeningOptions = {
  timeoutMs?: number;
  bootstrapTimeoutMs?: number;
  onStdoutLine?: (line: string) => void;
  onCoworkRuntimeBootstrapProgress?: (progress: CoworkRuntimeBootstrapProgress) => void;
};

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
  forceRestart?: boolean;
  featureFlags?: { openAiNativeConnectors?: boolean; tasks?: boolean };
  privacyTelemetrySettings?: PersistedPrivacyTelemetrySettings | null;
  productAnalyticsState?: PersistedProductAnalyticsState | null;
  mobileH3?: boolean;
  rotateMobileH3Tls?: boolean;
  onCoworkRuntimeBootstrapProgress?: (progress: CoworkRuntimeBootstrapProgress) => void;
};

type ServerManagerOptions = {
  getProductAnalyticsState?: () => PersistedProductAnalyticsState | null | undefined;
  fetch?: typeof fetch;
  onWorkspaceServerExited?: (event: {
    workspaceId: string;
    url: string | null;
    code: number | null;
    signal: string | null;
  }) => void;
};

type WorkspaceServerStatus = {
  workspaceId: string;
  running: boolean;
  url: string | null;
  reason: "running" | "starting" | "not_found" | "exited" | "health_failed";
  error?: string;
};

export type ServerManagerDiagnostics = {
  workspaces: Array<{
    workspaceId: string;
    running: boolean;
    starting: boolean;
    currentServerUrl: string | null;
    restartCount: number;
    lastChildExit: {
      url: string | null;
      code: number | null;
      signal: string | null;
      exitedAt: string;
    } | null;
  }>;
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
    conversations: z.boolean().optional().default(false),
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
                  conversations: false,
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

const coworkRuntimeBootstrapProgressSchema: z.ZodType<CoworkRuntimeBootstrapProgress> = z
  .object({
    phase: z.enum(COWORK_RUNTIME_BOOTSTRAP_PHASES),
    version: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/),
    transferredBytes: z.number().finite().nonnegative().nullable(),
    totalBytes: z.number().finite().nonnegative().nullable(),
    percent: z.number().finite().min(0).max(100).nullable(),
  })
  .strict();

const coworkRuntimeStartupProgressEventSchema = z
  .object({
    type: z.literal(SERVER_STARTUP_PROGRESS_TYPE),
    component: z.literal(COWORK_RUNTIME_STARTUP_COMPONENT),
    progress: coworkRuntimeBootstrapProgressSchema,
  })
  .strict();

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

function findBundledWindowsSandboxHelper(): string | null {
  return findWindowsHelper(getSidecarSearchDirs(), process.env);
}

const windowsSandboxHashManifestSchema = z.object({
  schemaVersion: z.literal(1),
  files: z.object({
    [WINDOWS_SANDBOX_HELPER_NAME]: z.string().regex(/^[a-f0-9]{64}$/),
    [WINDOWS_SANDBOX_SETUP_NAME]: z.string().regex(/^[a-f0-9]{64}$/),
    [WINDOWS_SANDBOX_COMMAND_RUNNER_NAME]: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});

function findBundledWindowsSandboxBundle(): {
  helperPath: string;
  helperSha256: string;
  setupPath: string;
  setupSha256: string;
  commandRunnerPath: string;
  commandRunnerSha256: string;
} | null {
  for (const dir of getSidecarSearchDirs()) {
    const manifestPath = path.join(dir, WINDOWS_SANDBOX_HASH_MANIFEST_NAME);
    try {
      const manifest = windowsSandboxHashManifestSchema.parse(
        JSON.parse(fs.readFileSync(manifestPath, "utf8")),
      );
      const helperPath = path.join(dir, WINDOWS_SANDBOX_HELPER_NAME);
      const setupPath = path.join(dir, WINDOWS_SANDBOX_SETUP_NAME);
      const commandRunnerPath = path.join(dir, WINDOWS_SANDBOX_COMMAND_RUNNER_NAME);
      if (
        ![helperPath, setupPath, commandRunnerPath].every((candidate) => fs.existsSync(candidate))
      ) {
        continue;
      }
      const binaries = [
        [helperPath, manifest.files[WINDOWS_SANDBOX_HELPER_NAME]],
        [setupPath, manifest.files[WINDOWS_SANDBOX_SETUP_NAME]],
        [commandRunnerPath, manifest.files[WINDOWS_SANDBOX_COMMAND_RUNNER_NAME]],
      ] as const;
      if (
        binaries.some(
          ([filePath, expected]) =>
            createHash("sha256").update(fs.readFileSync(filePath)).digest("hex") !== expected,
        )
      ) {
        continue;
      }
      if (
        app.isPackaged &&
        binaries.some(([filePath]) => {
          const signature = spawnSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "$signature = Get-AuthenticodeSignature -LiteralPath $args[0]; if ($signature.Status -eq 'Valid') { exit 0 }; exit 1",
              filePath,
            ],
            { windowsHide: true, stdio: "ignore", timeout: 15_000 },
          );
          return signature.status !== 0;
        })
      ) {
        continue;
      }
      return {
        helperPath,
        helperSha256: manifest.files[WINDOWS_SANDBOX_HELPER_NAME],
        setupPath,
        setupSha256: manifest.files[WINDOWS_SANDBOX_SETUP_NAME],
        commandRunnerPath,
        commandRunnerSha256: manifest.files[WINDOWS_SANDBOX_COMMAND_RUNNER_NAME],
      };
    } catch {
      // A missing or malformed manifest is never a trusted helper bundle.
    }
  }
  return null;
}

function runWindowsSandboxHelper(
  helperPath: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(helperPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => resolve({ code: null, stdout, stderr: error.message }));
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function ensureWindowsSandboxReady(
  workspacePath: string,
  overrides: {
    platform?: NodeJS.Platform;
    userDataDir?: string;
    resolveBundle?: typeof findBundledWindowsSandboxBundle;
    runHelper?: typeof runWindowsSandboxHelper;
  } = {},
): Promise<void> {
  if ((overrides.platform ?? process.platform) !== "win32") return;
  const userDataDir = overrides.userDataDir ?? app.getPath("userData");
  const runHelper = overrides.runHelper ?? runWindowsSandboxHelper;
  const noEnforcement = {
    filesystem: false,
    network: false,
    process: false,
    integrity: false,
  };
  const bundle = (overrides.resolveBundle ?? findBundledWindowsSandboxBundle)();
  if (!bundle) {
    logServerManagerEvent("windows sandbox bundle missing or failed integrity verification");
    await writeWindowsSandboxReadiness(userDataDir, {
      state: "bundle-untrusted",
      bundleTrusted: false,
      setupRequired: true,
      enforcement: noEnforcement,
      message:
        "Sandbox helper bundle is missing or failed integrity verification. Reinstall or repair Cowork.",
    });
    return;
  }
  const sandboxHome = path.join(userDataDir, "windows-sandbox");
  const commonArgs = ["--sandbox-home", sandboxHome, "--cwd", path.resolve(workspacePath)];
  const probe = await runHelper(bundle.helperPath, ["probe", ...commonArgs]);
  const parseEnforcement = (stdout: string) => {
    try {
      const value = JSON.parse(stdout) as Record<string, unknown>;
      return {
        filesystem: value.filesystem === true,
        network: value.network === true,
        process: value.process === true,
        integrity: value.integrity === true,
      };
    } catch {
      return noEnforcement;
    }
  };
  if (probe.code === 0) {
    await writeWindowsSandboxReadiness(userDataDir, {
      state: "ready",
      bundleTrusted: true,
      setupRequired: false,
      enforcement: parseEnforcement(probe.stdout),
      message: "Windows sandbox integrity and enforcement probes passed.",
    });
    return;
  }

  await writeWindowsSandboxReadiness(userDataDir, {
    state: "setup-required",
    bundleTrusted: true,
    setupRequired: true,
    enforcement: parseEnforcement(probe.stdout),
    message: "Windows sandbox needs one-time administrator setup or repair.",
  });

  logServerManagerEvent("windows sandbox requires one-time setup or repair", {
    probeCode: probe.code,
    probeError: probe.stderr.trim().slice(0, 500),
  });
  if (windowsSandboxSetupAttempted) return;
  windowsSandboxSetupAttempted = true;
  const setup = await runHelper(bundle.helperPath, [
    "setup",
    ...commonArgs,
    "--mode",
    "workspace-write",
    "--writable-root",
    path.resolve(workspacePath),
  ]);
  if (setup.code !== 0) {
    logServerManagerEvent("windows sandbox setup was cancelled or failed", {
      setupCode: setup.code,
      setupError: setup.stderr.trim().slice(0, 500),
    });
    await writeWindowsSandboxReadiness(userDataDir, {
      state: "setup-failed",
      bundleTrusted: true,
      setupRequired: true,
      enforcement: parseEnforcement(setup.stdout),
      message: "Windows sandbox setup was cancelled or failed. Restricted commands remain blocked.",
    });
    return;
  }
  await writeWindowsSandboxReadiness(userDataDir, {
    state: "ready",
    bundleTrusted: true,
    setupRequired: false,
    enforcement: parseEnforcement(setup.stdout),
    message: "Windows sandbox setup and enforcement probes passed.",
  });
  logServerManagerEvent("windows sandbox setup and enforcement probe completed");
}

function findSidecarLaunchCommand() {
  return findPackagedSidecarLaunchCommand(getSidecarSearchDirs(), {
    explicitPath: process.env.COWORK_DESKTOP_SIDECAR_PATH,
  });
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

function getServerStartupTimeoutMs(
  env: Record<string, string | undefined> = process.env,
  isPackaged = app.isPackaged,
): number {
  const parsed = Number(env.COWORK_DESKTOP_SERVER_STARTUP_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return isPackaged ? PACKAGED_SERVER_STARTUP_TIMEOUT_MS : DEFAULT_SERVER_STARTUP_TIMEOUT_MS;
  }
  return Math.min(
    MAX_SERVER_STARTUP_TIMEOUT_MS,
    Math.max(MIN_SERVER_STARTUP_TIMEOUT_MS, Math.floor(parsed)),
  );
}

function shouldMirrorServerOutput(
  env: Record<string, string | undefined> = process.env,
  isPackaged = app.isPackaged,
): boolean {
  const override = env.COWORK_DESKTOP_MIRROR_SERVER_LOGS?.trim();
  if (override === "1") {
    return true;
  }
  if (override === "0") {
    return false;
  }
  return !isPackaged || env.COWORK_DESKTOP_DEBUG_SERVER_STDERR === "1";
}

function buildHarnessTerminalLogsEnv(
  baseEnv: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const inherited = baseEnv.COWORK_HARNESS_TERMINAL_LOGS?.trim();
  if (inherited) {
    return { COWORK_HARNESS_TERMINAL_LOGS: inherited };
  }
  return shouldMirrorServerOutput(baseEnv) ? { COWORK_HARNESS_TERMINAL_LOGS: "1" } : {};
}

function createServerOutputMirror(
  opts: { stdoutWrite?: (chunk: string) => void; stderrWrite?: (chunk: string) => void } = {},
): ServerOutputMirror {
  const stdoutWrite = opts.stdoutWrite ?? ((chunk) => process.stdout.write(chunk));
  const stderrWrite = opts.stderrWrite ?? ((chunk) => process.stderr.write(chunk));
  const buffers: Record<ServerOutputSource, string> = {
    stdout: "",
    stderr: "",
  };

  const writerFor = (source: ServerOutputSource) =>
    source === "stderr" ? stderrWrite : stdoutWrite;

  const writeLine = (source: ServerOutputSource, line: string) => {
    if (!line) {
      return;
    }
    writerFor(source)(`${MIRROR_SERVER_OUTPUT_PREFIX}:${source}] ${line}\n`);
  };

  const writeChunk = (source: ServerOutputSource, chunk: string) => {
    if (!chunk) {
      return;
    }
    const parts = (buffers[source] + chunk).split(/\r?\n/);
    buffers[source] = parts.pop() ?? "";
    for (const line of parts) {
      writeLine(source, line);
    }
  };

  const flush = () => {
    for (const source of ["stdout", "stderr"] as const) {
      const remainder = buffers[source];
      buffers[source] = "";
      writeLine(source, remainder);
    }
  };

  return { flush, writeChunk, writeLine };
}

function waitForServerListening(
  child: ServerChildProcess,
  opts: WaitForServerListeningOptions = {},
): Promise<ServerListening> {
  const timeoutMs = opts.timeoutMs ?? getServerStartupTimeoutMs();
  const bootstrapTimeoutMs = opts.bootstrapTimeoutMs ?? PACKAGED_SERVER_STARTUP_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: child.stdout });
    const recentLines: string[] = [];
    let readySeen = false;
    let finished = false;
    let readySettled = false;
    let timeout: ReturnType<typeof setTimeout>;
    let activeTimeoutMs = timeoutMs;

    const settleReadyResolve = (value: ServerListening) => {
      if (readySettled) {
        return;
      }
      readySettled = true;
      resolve(value);
    };

    const settleReadyReject = (error: Error) => {
      if (readySettled) {
        return;
      }
      readySettled = true;
      reject(error);
    };

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

    const onTimeout = () => {
      cleanup();
      settleReadyReject(
        new Error(
          withRecentOutput(`Server startup timed out after ${activeTimeoutMs / 1000} seconds`),
        ),
      );
    };

    const resetTimeout = (delayMs: number) => {
      if (readySeen || finished) {
        return;
      }
      clearTimeout(timeout);
      activeTimeoutMs = delayMs;
      timeout = setTimeout(onTimeout, delayMs);
    };

    const onError = (error: Error) => {
      cleanup();
      if (!readySeen) {
        settleReadyReject(error);
      }
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      if (!readySeen) {
        settleReadyReject(
          new Error(
            withRecentOutput(
              `Server exited before startup JSON (code=${code ?? "null"}, signal=${signal ?? "null"})`,
            ),
          ),
        );
      }
    };

    const cleanup = () => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      rl.off("line", onLine);
      rl.close();
      child.off("error", onError);
      child.off("exit", onExit);
    };

    const onLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      try {
        const payload = JSON.parse(trimmed);
        const progress = coworkRuntimeStartupProgressEventSchema.safeParse(payload);
        if (progress.success && !readySeen) {
          const startupProgress = progress.data.progress;
          opts.onCoworkRuntimeBootstrapProgress?.(startupProgress);
          resetTimeout(
            startupProgress.phase === "waiting" || startupProgress.phase === "installing"
              ? Math.max(timeoutMs, bootstrapTimeoutMs)
              : timeoutMs,
          );
          return;
        }
        const listening = serverListeningSchema.safeParse(payload);
        if (listening.success && !readySeen) {
          readySeen = true;
          clearTimeout(timeout);
          settleReadyResolve(listening.data);
          return;
        }
      } catch {
        // Non-JSON lines are human-readable server logs. Keep them visible.
      }
      recordLine(trimmed);
      opts.onStdoutLine?.(trimmed);
    };

    timeout = setTimeout(onTimeout, timeoutMs);
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
  featureFlags?: { openAiNativeConnectors?: boolean; tasks?: boolean },
  opts: {
    includeBundledFoundationModelsSdk?: boolean;
    includeBundledWindowsAiElectron?: boolean;
    rotateMobileH3Tls?: boolean;
    privacyTelemetrySettings?: PersistedPrivacyTelemetrySettings | null;
    productAnalyticsState?: PersistedProductAnalyticsState | null;
  } = {},
): NodeJS.ProcessEnv {
  const bundledFoundationModelsSdk =
    opts.includeBundledFoundationModelsSdk && !process.env.COWORK_TSFMSDK_DIR
      ? findBundledFoundationModelsSdkDir()
      : null;
  const bundledWindowsAiElectron =
    opts.includeBundledWindowsAiElectron && !process.env.COWORK_WINDOWS_AI_ELECTRON_DIR
      ? findBundledWindowsAiElectronDir()
      : null;
  const bundledWindowsSandbox =
    process.platform === "win32" ? findBundledWindowsSandboxBundle() : null;
  const telemetryConsentEnv = withoutInheritedTelemetryConsentEnv(process.env);
  const privacyTelemetrySettings = resolveTelemetryConsent({
    settings: opts.privacyTelemetrySettings,
    env: telemetryConsentEnv,
    isPackaged: app.isPackaged,
  });
  const inheritedEnv = privacyTelemetrySettings.aiTraceTelemetryEnabled
    ? { ...process.env }
    : withoutInheritedObservabilityEnv(process.env);
  const processEnv = withoutInheritedProductAnalyticsEnv(
    withoutInheritedCrashReportingEnv(inheritedEnv),
  );
  delete processEnv.COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP;
  return {
    ...processEnv,
    COWORK_WEB_DESKTOP_SERVICE: "1",
    COWORK_DESKTOP_STARTUP_EVENTS: "1",
    COWORK_DESKTOP_USER_DATA_DIR: app.getPath("userData"),
    COWORK_BROWSER_ACCESS_TOKEN:
      process.env.COWORK_BROWSER_ACCESS_TOKEN?.trim() ||
      `${randomUUID()}${randomUUID().replaceAll("-", "")}`,
    COWORK_BOOTSTRAP_DEFAULT_SKILLS: process.env.COWORK_BOOTSTRAP_DEFAULT_SKILLS ?? "1",
    COWORK_RUNTIME_ALLOW_NETWORK: process.env.COWORK_RUNTIME_ALLOW_NETWORK ?? "1",
    ...(bundledFoundationModelsSdk ? { COWORK_TSFMSDK_DIR: bundledFoundationModelsSdk } : {}),
    ...(bundledWindowsAiElectron
      ? { COWORK_WINDOWS_AI_ELECTRON_DIR: bundledWindowsAiElectron }
      : {}),
    ...(bundledWindowsSandbox
      ? {
          COWORK_WIN_SANDBOX_HELPER: bundledWindowsSandbox.helperPath,
          COWORK_WIN_SANDBOX_HELPER_SHA256: bundledWindowsSandbox.helperSha256,
          COWORK_WIN_SANDBOX_SETUP: bundledWindowsSandbox.setupPath,
          COWORK_WIN_SANDBOX_SETUP_SHA256: bundledWindowsSandbox.setupSha256,
          COWORK_WIN_SANDBOX_COMMAND_RUNNER: bundledWindowsSandbox.commandRunnerPath,
          COWORK_WIN_SANDBOX_COMMAND_RUNNER_SHA256: bundledWindowsSandbox.commandRunnerSha256,
          COWORK_WIN_SANDBOX_HOME: path.join(app.getPath("userData"), "windows-sandbox"),
          COWORK_WIN_SANDBOX_REQUIRE_AUTHENTICODE: app.isPackaged ? "1" : "0",
        }
      : {}),
    ...(featureFlags?.openAiNativeConnectors
      ? { COWORK_EXPERIMENTAL_OPENAI_NATIVE_CONNECTORS: "1" }
      : {}),
    ...(featureFlags?.tasks ? { COWORK_ENABLE_TASKS: "1" } : {}),
    ...(opts.rotateMobileH3Tls ? { COWORK_H3_ROTATE_TLS: "1" } : {}),
    ...buildHarnessTerminalLogsEnv(processEnv),
    ...buildDesktopObservabilityEnv(privacyTelemetrySettings),
    ...buildDesktopCrashReportingEnv(privacyTelemetrySettings),
    ...buildDesktopProductAnalyticsEnv(
      privacyTelemetrySettings,
      opts.productAnalyticsState,
      telemetryConsentEnv,
    ),
  };
}

function withoutInheritedTelemetryConsentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of TELEMETRY_CONSENT_ENV_KEYS) {
    delete next[key];
  }
  return next;
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

function toHttpServerRequestUrl(websocketUrl: string, pathname: string): string {
  const url = new URL(websocketUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = pathname;
  return url.toString();
}

function stripUrlSecrets(rawUrl: string | null): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return rawUrl.split("?")[0] ?? rawUrl;
  }
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

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
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

function shouldReuseExistingWorkspaceServer(
  opts: Pick<StartWorkspaceServerOptions, "forceRestart" | "mobileH3">,
  existing: ServerHandle,
): boolean {
  return (
    opts.forceRestart !== true && !shouldReplaceForMobileH3Request(opts.mobileH3, existing.mobileH3)
  );
}

export class ServerManager {
  private readonly servers = new Map<string, ServerHandle>();
  private readonly pendingStarts = new Map<string, PendingServerHandle>();
  private readonly suppressedExitNotifications = new WeakSet<ServerChildProcess>();
  private readonly startCountsByWorkspace = new Map<string, number>();
  private readonly lastExitByWorkspace = new Map<
    string,
    ServerManagerDiagnostics["workspaces"][number]["lastChildExit"]
  >();

  constructor(private readonly options: ServerManagerOptions = {}) {}

  private finishWorkspaceServerExit(
    workspaceId: string,
    child: ServerChildProcess,
    url: string | null,
    cleanup: () => void,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const pendingExit = this.pendingStarts.get(workspaceId);
    if (pendingExit?.child === child) {
      this.pendingStarts.delete(workspaceId);
    }
    cleanup();
    const handle = this.servers.get(workspaceId);
    if (handle?.child === child) {
      this.servers.delete(workspaceId);
    }
    if (!this.suppressedExitNotifications.has(child)) {
      this.lastExitByWorkspace.set(workspaceId, {
        url: stripUrlSecrets(url),
        code,
        signal,
        exitedAt: new Date().toISOString(),
      });
      this.options.onWorkspaceServerExited?.({
        workspaceId,
        url,
        code,
        signal,
      });
    }
  }

  async getWorkspaceServerStatus(workspaceId: string): Promise<WorkspaceServerStatus> {
    assertSafeId(workspaceId, "workspaceId");
    const pending = this.pendingStarts.get(workspaceId);
    if (pending) {
      if (pending.child.exitCode === null && pending.child.signalCode === null) {
        return { workspaceId, running: false, url: null, reason: "starting" };
      }
      this.pendingStarts.delete(workspaceId);
      pending.cleanup();
      return { workspaceId, running: false, url: null, reason: "exited" };
    }

    const handle = this.servers.get(workspaceId);
    if (!handle) {
      return { workspaceId, running: false, url: null, reason: "not_found" };
    }

    if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
      this.servers.delete(workspaceId);
      handle.cleanup();
      return { workspaceId, running: false, url: handle.url, reason: "exited" };
    }

    try {
      const response = await fetchWithTimeout(
        this.options.fetch ?? fetch,
        toHttpServerRequestUrl(handle.url, "/cowork/health"),
        SERVER_HEALTH_TIMEOUT_MS,
      );
      if (!response.ok) {
        return {
          workspaceId,
          running: false,
          url: handle.url,
          reason: "health_failed",
          error: `HTTP ${response.status}`,
        };
      }
      return { workspaceId, running: true, url: handle.url, reason: "running" };
    } catch (error) {
      return {
        workspaceId,
        running: false,
        url: handle.url,
        reason: "health_failed",
        error: toErrorMessage(error),
      };
    }
  }

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
        if (!shouldReuseExistingWorkspaceServer(opts, existing)) {
          const replacementPending = { child: existing.child, cleanup: existing.cleanup };
          this.pendingStarts.set(workspaceId, replacementPending);
          this.servers.delete(workspaceId);
          this.suppressedExitNotifications.add(existing.child);
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

    this.startCountsByWorkspace.set(
      workspaceId,
      (this.startCountsByWorkspace.get(workspaceId) ?? 0) + 1,
    );

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

    await ensureWindowsSandboxReady(workspacePath);

    const attemptCount = getSourceStartupAttemptCount(useSource);
    let previousError: unknown = null;
    const outputMirror = shouldMirrorServerOutput() ? createServerOutputMirror() : null;

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
        outputMirror?.writeChunk("stderr", text);
        logServerManagerEvent("workspace server stderr emitted", {
          workspaceId,
          bytes: Buffer.byteLength(text),
          bunCrash: isLikelyBunSegfault(text),
        });
      });

      try {
        const listening = await waitForServerListening(child, {
          onCoworkRuntimeBootstrapProgress: opts.onCoworkRuntimeBootstrapProgress,
          onStdoutLine: outputMirror
            ? (line) => {
                outputMirror.writeLine("stdout", line);
              }
            : undefined,
        });
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

        child.once("exit", (code, signal) => {
          outputMirror?.flush();
          this.finishWorkspaceServerExit(workspaceId, child, url, cleanupOnce, code, signal);
        });

        return { url, mobileH3: listening.mobileH3 ?? null };
      } catch (error) {
        await gracefulKill(child);
        outputMirror?.flush();
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
          outputMirror?.writeLine(
            "stderr",
            "Bun crashed during startup; retrying with async transpiler disabled.",
          );
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
      this.suppressedExitNotifications.add(pending.child);
      await gracefulKill(pending.child);
      pending.cleanup();
    }

    const handle = this.servers.get(workspaceId);
    if (!handle) {
      return;
    }

    this.servers.delete(workspaceId);
    this.suppressedExitNotifications.add(handle.child);
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
        this.suppressedExitNotifications.add(handle.child);
        await gracefulKill(handle.child);
        handle.cleanup();
      }),
      ...pendingEntries.map(async ([, handle]) => {
        this.suppressedExitNotifications.add(handle.child);
        await gracefulKill(handle.child);
        handle.cleanup();
      }),
    ];

    await Promise.all(killPromises);
  }

  getDiagnostics(): ServerManagerDiagnostics {
    const workspaceIds = new Set<string>([
      ...this.servers.keys(),
      ...this.pendingStarts.keys(),
      ...this.startCountsByWorkspace.keys(),
      ...this.lastExitByWorkspace.keys(),
    ]);
    return {
      workspaces: [...workspaceIds].sort().map((workspaceId) => {
        const handle = this.servers.get(workspaceId);
        const pending = this.pendingStarts.get(workspaceId);
        return {
          workspaceId,
          running:
            Boolean(handle) && handle?.child.exitCode === null && handle.child.signalCode === null,
          starting:
            Boolean(pending) &&
            pending?.child.exitCode === null &&
            pending.child.signalCode === null,
          currentServerUrl: stripUrlSecrets(handle?.url ?? null),
          restartCount: Math.max(0, (this.startCountsByWorkspace.get(workspaceId) ?? 0) - 1),
          lastChildExit: this.lastExitByWorkspace.get(workspaceId) ?? null,
        };
      }),
    };
  }
}

export const __internal = {
  buildDesktopCrashReportingEnv,
  buildServerEnv,
  buildSourceEnvForAttempt,
  findBundledFoundationModelsSdkDir,
  findBundledWindowsSandboxBundle,
  findBundledWindowsSandboxHelper,
  findBundledWindowsAiElectronDir,
  findSidecarLaunchCommand,
  getServerTerminationSignal,
  getServerLogPath,
  getServerStartupTimeoutMs,
  appendBrowserAccessToken,
  buildHarnessTerminalLogsEnv,
  createServerOutputMirror,
  ensureWindowsSandboxReady,
  resetWindowsSandboxSetupAttemptForTests: () => {
    windowsSandboxSetupAttempted = false;
  },
  getSourceStartupAttemptCount,
  isLikelyBunSegfault,
  logServerManagerEvent,
  flushServerManagerLogWrites,
  resolveSourceStartup,
  shouldMirrorServerOutput,
  shouldReplaceForMobileH3Request,
  shouldReuseExistingWorkspaceServer,
  summarizeLogChunk,
  withStderrTail,
  waitForServerListening,
  withoutInheritedCrashReportingEnv,
  withoutInheritedObservabilityEnv,
  withoutInheritedProductAnalyticsEnv,
};
