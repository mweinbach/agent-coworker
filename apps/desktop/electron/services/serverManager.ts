import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { app } from "electron";

import { assertSafeId, assertWorkspaceDirectory } from "./validation";

const SERVER_STARTUP_TIMEOUT_MS = 15_000;
const SIDECAR_BASE_NAME = "cowork-server";

type ServerHandle = {
  child: ChildProcessWithoutNullStreams;
  url: string;
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

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Server exited before startup JSON (code=${code ?? "null"}, signal=${signal ?? "null"})`));
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Server startup timed out after ${SERVER_STARTUP_TIMEOUT_MS / 1000} seconds`));
    }, SERVER_STARTUP_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      rl.off("line", onLine);
      rl.close();
      child.off("error", onError);
      child.off("exit", onExit);
    };

    const onLine = (line: string) => {
      cleanup();
      try {
        const parsed = JSON.parse(line.trim()) as ServerListening;
        if (!parsed?.url || parsed.type !== "server_listening") {
          reject(new Error("Server startup output missing server_listening payload"));
          return;
        }
        resolve(parsed);
      } catch (error) {
        reject(new Error(`Failed to parse server startup JSON: ${String(error)}`));
      }
    };

    rl.once("line", onLine);
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

function buildServerEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
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
    }

    const useSource = !app.isPackaged || process.env.COWORK_DESKTOP_USE_SOURCE === "1";
    const spawnArgs = buildSpawnArgs(workspacePath, yolo);
    const repoRoot = resolveRepoRoot();
    const serverEnv = buildServerEnv();

    let child: ChildProcessWithoutNullStreams;
    if (useSource) {
      const entry = path.join(repoRoot, "src", "server", "index.ts");
      if (!fs.existsSync(entry)) {
        throw new Error(`Server entrypoint not found: ${entry}`);
      }

      child = spawn("bun", [entry, ...spawnArgs], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: serverEnv,
      });
    } else {
      const builtInDir = path.join(process.resourcesPath, "dist");
      if (!fs.existsSync(builtInDir)) {
        throw new Error(`Bundled dist directory not found: ${builtInDir}`);
      }

      const sidecar = findSidecarBinary();
      child = spawn(sidecar, spawnArgs, {
        cwd: process.resourcesPath,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...serverEnv,
          COWORK_BUILTIN_DIR: builtInDir,
          COWORK_DESKTOP_BUNDLE: "1",
        },
      });
    }

    child.stderr.on("data", (chunk) => {
      process.stderr.write(`[cowork-server] ${chunk.toString()}`);
    });

    try {
      const listening = await waitForServerListening(child);
      const url = listening.url;
      this.servers.set(workspaceId, { child, url });

      child.once("exit", () => {
        const handle = this.servers.get(workspaceId);
        if (handle?.child === child) {
          this.servers.delete(workspaceId);
        }
      });

      return { url };
    } catch (error) {
      await gracefulKill(child);
      throw error;
    }
  }

  async stopWorkspaceServer(workspaceId: string): Promise<void> {
    assertSafeId(workspaceId, "workspaceId");

    const handle = this.servers.get(workspaceId);
    if (!handle) {
      return;
    }

    this.servers.delete(workspaceId);
    await gracefulKill(handle.child);
  }

  async stopAll(): Promise<void> {
    const entries = [...this.servers.entries()];
    this.servers.clear();

    for (const [, handle] of entries) {
      await gracefulKill(handle.child);
    }
  }
}
