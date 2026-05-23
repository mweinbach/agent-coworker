import { type ChildProcessByStdio, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { Readable } from "node:stream";
import { app } from "electron";
import { z } from "zod";

import { resolvePackagedBuiltinDistDir } from "./desktopBuiltinPaths";
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
  resolvePackagedCodexAppServerFilename,
  WINDOWS_AI_ELECTRON_DIR_NAME,
} from "./sidecar";
import { assertSafeId, assertWorkspaceDirectory } from "./validation";

const DEFAULT_SERVER_STARTUP_TIMEOUT_MS = 45_000;
const MIN_SERVER_STARTUP_TIMEOUT_MS = 5_000;
const MAX_SERVER_STARTUP_TIMEOUT_MS = 300_000;
const STDERR_TAIL_LIMIT = 16_384;
const SERVER_LOG_FILE_NAME = "server.log";
const DEBUG_SERVER_STDERR = process.env.COWORK_DESKTOP_DEBUG_SERVER_STDERR === "1";

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
    } | null;
  } | null;
};

type StartWorkspaceServerOptions = {
  workspaceId: string;
  workspacePath: string;
  yolo: boolean;
  featureFlags?: { openAiNativeConnectors?: boolean };
  mobileH3?: boolean;
};

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
          .object({
            deviceId: z.string().min(1),
            fingerprint: z.string().min(1),
            displayName: z.string().nullable(),
          })
          .nullable()
          .optional()
          .default(null),
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

function findBundledCodexAppServerPath(): string | null {
  const fromEnv = process.env.COWORK_DESKTOP_CODEX_APP_SERVER_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv;
  }

  const expectedFilename = resolvePackagedCodexAppServerFilename();
  for (const dir of getSidecarSearchDirs()) {
    const candidate = path.join(dir, expectedFilename);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
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
  } = {},
): NodeJS.ProcessEnv {
  const bundledCodexAppServer = process.env.COWORK_CODEX_APP_SERVER_COMMAND
    ? null
    : findBundledCodexAppServerPath();
  const bundledCodexPrimaryRuntime = findBundledCodexPrimaryRuntimeDir();
  const bundledFoundationModelsSdk =
    opts.includeBundledFoundationModelsSdk && !process.env.COWORK_TSFMSDK_DIR
      ? findBundledFoundationModelsSdkDir()
      : null;
  const bundledWindowsAiElectron =
    opts.includeBundledWindowsAiElectron && !process.env.COWORK_WINDOWS_AI_ELECTRON_DIR
      ? findBundledWindowsAiElectronDir()
      : null;
  return {
    ...process.env,
    COWORK_BROWSER_ACCESS_TOKEN:
      process.env.COWORK_BROWSER_ACCESS_TOKEN?.trim() ||
      `${randomUUID()}${randomUUID().replaceAll("-", "")}`,
    COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: process.env.COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP ?? "1",
    ...(bundledCodexAppServer
      ? { COWORK_CODEX_APP_SERVER_COMMAND: bundledCodexAppServer, COWORK_CODEX_APP_SERVER_ARGS: "" }
      : {}),
    ...(bundledCodexPrimaryRuntime
      ? { COWORK_BUNDLED_CODEX_PRIMARY_RUNTIME_DIR: bundledCodexPrimaryRuntime }
      : {}),
    ...(bundledFoundationModelsSdk ? { COWORK_TSFMSDK_DIR: bundledFoundationModelsSdk } : {}),
    ...(bundledWindowsAiElectron
      ? { COWORK_WINDOWS_AI_ELECTRON_DIR: bundledWindowsAiElectron }
      : {}),
    ...(featureFlags?.openAiNativeConnectors
      ? { COWORK_EXPERIMENTAL_OPENAI_NATIVE_CONNECTORS: "1" }
      : {}),
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
  return path.join(app.getPath("userData"), "logs", SERVER_LOG_FILE_NAME);
}

let pendingServerLogWrite: Promise<void> = Promise.resolve();

function logServerManagerEvent(message: string): void {
  const entry = `[${new Date().toISOString()}] ${message}\n`;
  pendingServerLogWrite = pendingServerLogWrite
    .catch(() => {
      // Preserve future writes if a previous append failed.
    })
    .then(async () => {
      try {
        const logPath = getServerLogPath();
        await fsp.mkdir(path.dirname(logPath), { recursive: true });
        await fsp.appendFile(logPath, entry, "utf8");
      } catch {
        // Best effort diagnostics only.
      }
    });
}

async function flushServerManagerLogWrites(): Promise<void> {
  try {
    await pendingServerLogWrite;
  } catch {
    // Best effort diagnostics only.
  }
}

function summarizeLogChunk(chunk: string): string {
  return chunk.replace(/\s+/g, " ").trim().slice(0, 1000);
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

  async startWorkspaceServer(
    opts: StartWorkspaceServerOptions,
  ): Promise<{ url: string; mobileH3: ServerListening["mobileH3"] }> {
    const { workspaceId, workspacePath, yolo } = opts;

    assertSafeId(workspaceId, "workspaceId");
    await assertWorkspaceDirectory(workspacePath);

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

    logServerManagerEvent(
      `workspace=${workspaceId} start requested mode=${useSource ? "source" : "packaged"} workspacePath=${workspacePath}`,
    );

    const attemptCount = getSourceStartupAttemptCount(useSource);
    let previousError: unknown = null;

    for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
      const serverEnv = buildServerEnv(opts.featureFlags, {
        includeBundledFoundationModelsSdk: !useSource,
        includeBundledWindowsAiElectron: !useSource,
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
        spawnDescription = `${sidecar.command} ${sidecar.args.join(" ")}`.trim();
      }

      logServerManagerEvent(
        `workspace=${workspaceId} attempt=${attempt}/${attemptCount} spawn=${spawnDescription}`,
      );

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
        const summary = summarizeLogChunk(text);
        if (summary) {
          logServerManagerEvent(`workspace=${workspaceId} stderr=${summary}`);
        }
      });

      try {
        const listening = await waitForServerListening(child);
        const url = appendBrowserAccessToken(listening.url, listening.browserAccessToken);
        logServerManagerEvent(`workspace=${workspaceId} listening url=${listening.url}`);
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
          logServerManagerEvent(
            `workspace=${workspaceId} retrying after Bun crash attempt=${attempt} error=${toErrorMessage(error)}`,
          );
          if (DEBUG_SERVER_STDERR) {
            process.stderr.write(
              "[cowork-server] Bun crashed during startup; retrying with async transpiler disabled.\n",
            );
          }
          continue;
        }

        if (isLikelyBunSegfault(stderrTail)) {
          logServerManagerEvent(
            `workspace=${workspaceId} bun_crash error=${toErrorMessage(error)} stderrTail=${summarizeLogChunk(stderrTail)}`,
          );
          throw new Error(
            `Cowork server crashed inside Bun while starting: ${toErrorMessage(error)}. ` +
              "Try upgrading Bun and retrying.",
          );
        }

        logServerManagerEvent(
          `workspace=${workspaceId} start_failed error=${toErrorMessage(error)} stderrTail=${summarizeLogChunk(stderrTail)}`,
        );
        throw error;
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
  buildServerEnv,
  buildSourceEnvForAttempt,
  findBundledCodexAppServerPath,
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
  waitForServerListening,
};
