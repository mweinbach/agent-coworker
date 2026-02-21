import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { app } from "electron";

import { assertSafeId, assertWorkspaceDirectory } from "./validation";

const SERVER_STARTUP_TIMEOUT_MS = 15_000;
const SIDECAR_BASE_NAME = "cowork-server";
const STDERR_TAIL_LIMIT = 16_384;
const WINDOWS_SOURCE_START_ATTEMPTS = 2;

type ServerHandle = {
  child: ChildProcessWithoutNullStreams;
  url: string;
  cleanup: () => void;
};

type ServerListening = {
  type: string;
  url: string;
  port: number;
  cwd: string;
};

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

function matchesSidecarFilename(name: string): boolean {
  if (process.platform === "win32") {
    return name.startsWith(`${SIDECAR_BASE_NAME}-`) && name.endsWith(".exe");
  }
  return name === SIDECAR_BASE_NAME || name.startsWith(`${SIDECAR_BASE_NAME}-`);
}

function findSidecarBinary(): string {
  const explicit = process.env.COWORK_DESKTOP_SIDECAR_PATH;
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  for (const dir of getSidecarSearchDirs()) {
    if (!fs.existsSync(dir)) {
      continue;
    }

    const entries = fs.readdirSync(dir);
    const match = entries.find((entry) => matchesSidecarFilename(entry));
    if (match) {
      return path.join(dir, match);
    }
  }

  throw new Error("Server sidecar binary not found");
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
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

async function gracefulKill(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    if (process.platform === "win32") {
      child.kill();
    } else {
      child.kill("SIGTERM");
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

function waitForServerListening(child: ChildProcessWithoutNullStreams): Promise<ServerListening> {
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
        const parsed = JSON.parse(trimmed) as ServerListening;
        if (!parsed?.url || parsed.type !== "server_listening") {
          return;
        }
        cleanup();
        resolve(parsed);
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
  return { ...process.env };
}

function buildSourceEnvForAttempt(baseEnv: NodeJS.ProcessEnv, attempt: number): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  if (process.platform !== "win32") {
    return { env: baseEnv, cleanup: () => {} };
  }

  const tempRoot = path.join(app.getPath("temp"), "cowork-bun-transpiler-cache");
  fs.mkdirSync(tempRoot, { recursive: true });
  const cacheDir = fs.mkdtempSync(path.join(tempRoot, "run-"));

  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: cacheDir,
  };

  // If Bun crashes during startup, retry once with async transpilation disabled.
  if (attempt > 1) {
    env.BUN_FEATURE_FLAG_DISABLE_ASYNC_TRANSPILER = "1";
  }

  return {
    env,
    cleanup: () => {
      try {
        fs.rmSync(cacheDir, { recursive: true, force: true });
      } catch {
        // Best effort cleanup.
      }
    },
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

export class ServerManager {
  private readonly servers = new Map<string, ServerHandle>();

  async startWorkspaceServer(opts: { workspaceId: string; workspacePath: string; yolo: boolean }): Promise<{ url: string }> {
    const { workspaceId, workspacePath, yolo } = opts;

    assertSafeId(workspaceId, "workspaceId");
    assertWorkspaceDirectory(workspacePath);

    const existing = this.servers.get(workspaceId);
    if (existing) {
      if (existing.child.exitCode === null && existing.child.signalCode === null) {
        return { url: existing.url };
      }
      this.servers.delete(workspaceId);
      existing.cleanup();
    }

    const useSource = !app.isPackaged || process.env.COWORK_DESKTOP_USE_SOURCE === "1";
    const spawnArgs = buildSpawnArgs(workspacePath, yolo);
    const { repoRoot, sourceEntry } = resolveSourceStartup(useSource);

    const sidecar = !useSource ? findSidecarBinary() : null;
    const builtInDir = !useSource ? path.join(process.resourcesPath, "dist") : null;
    if (!useSource && builtInDir && !fs.existsSync(builtInDir)) {
      throw new Error(`Bundled dist directory not found: ${builtInDir}`);
    }

    const attemptCount = useSource && process.platform === "win32" ? WINDOWS_SOURCE_START_ATTEMPTS : 1;
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
        : spawn(sidecar!, spawnArgs, {
            cwd: process.resourcesPath,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...serverEnv,
              COWORK_BUILTIN_DIR: builtInDir!,
              COWORK_DESKTOP_BUNDLE: "1",
            },
          });

      let stderrTail = "";
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderrTail += text;
        if (stderrTail.length > STDERR_TAIL_LIMIT) {
          stderrTail = stderrTail.slice(-STDERR_TAIL_LIMIT);
        }
        process.stderr.write(`[cowork-server] ${text}`);
      });

      try {
        const listening = await waitForServerListening(child);
        const url = listening.url;

        let cleaned = false;
        const cleanupOnce = () => {
          if (cleaned) {
            return;
          }
          cleaned = true;
          cleanup();
        };

        this.servers.set(workspaceId, { child, url, cleanup: cleanupOnce });

        child.once("exit", () => {
          cleanupOnce();
          const handle = this.servers.get(workspaceId);
          if (handle?.child === child) {
            this.servers.delete(workspaceId);
          }
        });

        return { url };
      } catch (error) {
        await gracefulKill(child);
        cleanup();

        const shouldRetry =
          useSource &&
          process.platform === "win32" &&
          attempt < attemptCount &&
          isLikelyBunSegfault(stderrTail);

        if (shouldRetry) {
          previousError = error;
          process.stderr.write(
            "[cowork-server] Bun crashed during startup; retrying with async transpiler disabled.\n"
          );
          continue;
        }

        if (isLikelyBunSegfault(stderrTail)) {
          throw new Error(
            `Cowork server crashed inside Bun while starting: ${toErrorMessage(error)}. ` +
              "Try upgrading Bun and retrying."
          );
        }

        throw error;
      }
    }

    throw (previousError as Error) ?? new Error("Failed to start workspace server");
  }

  async stopWorkspaceServer(workspaceId: string): Promise<void> {
    assertSafeId(workspaceId, "workspaceId");

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

    for (const [, handle] of entries) {
      await gracefulKill(handle.child);
      handle.cleanup();
    }
  }
}

export const __internal = {
  buildSourceEnvForAttempt,
  isLikelyBunSegfault,
  resolveSourceStartup,
  waitForServerListening,
};
