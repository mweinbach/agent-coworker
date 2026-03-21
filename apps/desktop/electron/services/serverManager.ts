import { spawn, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { Readable } from "node:stream";
import { z } from "zod";

import { app } from "electron";

import { resolvePackagedBuiltinDistDir } from "./desktopBuiltinPaths";
import {
  buildSourceEnvForAttempt,
  getServerTerminationSignal,
  getSourceStartupAttemptCount,
} from "./serverPlatform";
import { assertSafeId, assertWorkspaceDirectory } from "./validation";
import { findPackagedSidecarLaunchCommand } from "./sidecar";

const SERVER_STARTUP_TIMEOUT_MS = 15_000;
const STDERR_TAIL_LIMIT = 16_384;
const SERVER_LOG_FILE_NAME = "server.log";
const DEBUG_SERVER_STDERR = process.env.COWORK_DESKTOP_DEBUG_SERVER_STDERR === "1";

type ServerHandle = {
  child: ServerChildProcess;
  url: string;
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
};

const serverListeningSchema = z.object({
  type: z.literal("server_listening"),
  url: z.string().min(1),
  port: z.number(),
  cwd: z.string().min(1),
}).passthrough();

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

function waitForServerListening(child: ServerChildProcess): Promise<ServerListening> {
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
        new Error(withRecentOutput(`Server exited before startup JSON (code=${code ?? "null"}, signal=${signal ?? "null"})`))
      );
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(withRecentOutput(`Server startup timed out after ${SERVER_STARTUP_TIMEOUT_MS / 1000} seconds`)));
    }, SERVER_STARTUP_TIMEOUT_MS);

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

function buildSpawnArgs(workspacePath: string, yolo: boolean): string[] {
  const args = ["--dir", workspacePath, "--port", "0", "--json"];
  if (yolo) {
    args.push("--yolo");
  }
  return args;
}

function resolveSourceStartup(
  useSource: boolean,
  resolveRepoRootImpl: () => string = resolveRepoRoot
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

function buildServerEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: process.env.COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP ?? "1",
  };
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

export class ServerManager {
  private readonly servers = new Map<string, ServerHandle>();
  private readonly pendingStarts = new Map<string, PendingServerHandle>();

  async startWorkspaceServer(opts: { workspaceId: string; workspacePath: string; yolo: boolean }): Promise<{ url: string }> {
    const { workspaceId, workspacePath, yolo } = opts;

    assertSafeId(workspaceId, "workspaceId");
    await assertWorkspaceDirectory(workspacePath);

    const existing = this.servers.get(workspaceId);
    if (existing) {
      if (existing.child.exitCode === null && existing.child.signalCode === null) {
        return { url: existing.url };
      }
      this.servers.delete(workspaceId);
      existing.cleanup();
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
    const spawnArgs = buildSpawnArgs(workspacePath, yolo);
    const { repoRoot, sourceEntry } = resolveSourceStartup(useSource);

    const sidecar = !useSource ? findSidecarLaunchCommand() : null;
    const builtInDir = !useSource ? resolvePackagedBuiltinDistDir() : null;
    if (!useSource && !builtInDir) {
      throw new Error(`Bundled dist directory not found: ${path.join(process.resourcesPath, "dist")}`);
    }

    logServerManagerEvent(
      `workspace=${workspaceId} start requested mode=${useSource ? "source" : "packaged"} workspacePath=${workspacePath}`
    );

    const attemptCount = getSourceStartupAttemptCount(useSource);
    let previousError: unknown = null;

    for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
      const serverEnv = buildServerEnv();
      const sourceEnvForAttempt = useSource ? buildSourceEnvForAttempt(serverEnv, attempt) : null;
      const cleanup = sourceEnvForAttempt?.cleanup ?? (() => {});

      const child = useSource
        ? spawn("bun", [sourceEntry!, ...spawnArgs], {
            cwd: repoRoot!,
            stdio: ["ignore", "pipe", "pipe"],
            env: sourceEnvForAttempt!.env,
          })
        : spawn(sidecar!.command, [...sidecar!.args, ...spawnArgs], {
            cwd: process.resourcesPath,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...serverEnv,
              COWORK_BUILTIN_DIR: builtInDir!,
              COWORK_DESKTOP_BUNDLE: "1",
            },
          });

      logServerManagerEvent(
        `workspace=${workspaceId} attempt=${attempt}/${attemptCount} spawn=${useSource ? "bun" : `${sidecar!.command} ${sidecar!.args.join(" ")}`.trim()}`
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
        const url = listening.url;
        logServerManagerEvent(`workspace=${workspaceId} listening url=${url}`);
        const pendingHandle = this.pendingStarts.get(workspaceId);
        if (pendingHandle?.child === child) {
          this.pendingStarts.delete(workspaceId);
        }

        this.servers.set(workspaceId, { child, url, cleanup: cleanupOnce });

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

        return { url };
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
            `workspace=${workspaceId} retrying after Bun crash attempt=${attempt} error=${toErrorMessage(error)}`
          );
          if (DEBUG_SERVER_STDERR) {
            process.stderr.write(
              "[cowork-server] Bun crashed during startup; retrying with async transpiler disabled.\n"
            );
          }
          continue;
        }

        if (isLikelyBunSegfault(stderrTail)) {
          logServerManagerEvent(
            `workspace=${workspaceId} bun_crash error=${toErrorMessage(error)} stderrTail=${summarizeLogChunk(stderrTail)}`
          );
          throw new Error(
            `Cowork server crashed inside Bun while starting: ${toErrorMessage(error)}. ` +
              "Try upgrading Bun and retrying."
          );
        }

        logServerManagerEvent(
          `workspace=${workspaceId} start_failed error=${toErrorMessage(error)} stderrTail=${summarizeLogChunk(stderrTail)}`
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

  async stopAll(): Promise<void> {
    const entries = [...this.servers.entries()];
    this.servers.clear();
    const pendingEntries = [...this.pendingStarts.entries()];
    this.pendingStarts.clear();

    for (const [, handle] of entries) {
      await gracefulKill(handle.child);
      handle.cleanup();
    }

    for (const [, handle] of pendingEntries) {
      await gracefulKill(handle.child);
      handle.cleanup();
    }
  }
}

export const __internal = {
  buildServerEnv,
  buildSourceEnvForAttempt,
  findSidecarLaunchCommand,
  getServerTerminationSignal,
  getServerLogPath,
  getSourceStartupAttemptCount,
  isLikelyBunSegfault,
  logServerManagerEvent,
  flushServerManagerLogWrites,
  resolveSourceStartup,
  summarizeLogChunk,
  waitForServerListening,
};
