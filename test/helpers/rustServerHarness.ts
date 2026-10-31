import { type ChildProcessByStdio, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";

import { hostPlatform } from "../../src/platform/host";
import { scratchRoots } from "../../src/platform/sandbox/policy";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const builtBinaries = new Set<string>();

export function resolveRustBinaryPath(binName: "cowork-server" | "cowork"): string {
  const exe = hostPlatform() === "win32" ? `${binName}.exe` : binName;
  const debugCandidate = path.join(REPO_ROOT, "target", "debug", exe);
  const releaseCandidate = path.join(REPO_ROOT, "target", "release", exe);

  if (fs.existsSync(debugCandidate)) return debugCandidate;
  if (fs.existsSync(releaseCandidate)) return releaseCandidate;

  if (!builtBinaries.has(binName)) {
    const pkg = binName === "cowork-server" ? "cowork-server" : "cowork-cli";
    execFileSync("cargo", ["build", "-p", pkg, "--bin", binName], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    builtBinaries.add(binName);
  }

  if (fs.existsSync(debugCandidate)) return debugCandidate;
  if (fs.existsSync(releaseCandidate)) return releaseCandidate;
  throw new Error(`Unable to locate compiled Rust binary ${binName}`);
}

export type RustListeningEvent = {
  type: "server_listening";
  url: string;
  wsUrl: string;
  rpcUrl: string;
  host: string;
  hostHints?: string[];
  port: number;
  cwd: string;
  browserAccessToken?: string | null;
  mobileH3?: {
    url: string;
    host: string;
    port: number;
    certSha256Base64Url: string;
    pairingToken: string;
    ticket: string;
    protocol: string;
  } | null;
};

export type SpawnedRustServer = {
  proc: ChildProcessByStdio<Writable, Readable, Readable>;
  listening: RustListeningEvent;
  httpBaseUrl: string;
  wsUrl: string;
  rpcUrl: string;
  homeDir: string;
  coworkHomeDir: string;
  workspaceDir: string;
  stderrLines: string[];
  stop: () => Promise<void>;
};

export async function startRustTestServer(opts?: {
  workspaceDir?: string;
  homeDir?: string;
  host?: string;
  port?: number;
  yolo?: boolean;
  mobileH3?: boolean;
  extraArgs?: string[];
  env?: Record<string, string | undefined>;
}): Promise<SpawnedRustServer> {
  const rawScratch = scratchRoots()[0] ?? "/tmp";
  const scratchBase = fs.existsSync(rawScratch) ? fs.realpathSync(rawScratch) : rawScratch;
  const ownedRoot =
    opts?.homeDir && opts?.workspaceDir
      ? null
      : await fsp.mkdtemp(path.join(scratchBase, "cowork-rust-srv-"));

  const homeDir = opts?.homeDir ?? path.join(ownedRoot!, "home");
  const workspaceDir = opts?.workspaceDir ?? path.join(ownedRoot!, "workspace");
  const coworkHomeDir = path.join(homeDir, ".cowork");

  await fsp.mkdir(coworkHomeDir, { recursive: true });
  await fsp.mkdir(workspaceDir, { recursive: true });

  const binPath = resolveRustBinaryPath("cowork-server");
  const args = [
    "--dir",
    workspaceDir,
    "--host",
    opts?.host ?? "127.0.0.1",
    "--port",
    String(opts?.port ?? 0),
    "--json",
  ];
  if (opts?.yolo ?? true) args.push("--yolo");
  if (opts?.mobileH3) {
    args.push("--mobile-h3", "--mobile-h3-host", "127.0.0.1", "--mobile-h3-port", "0");
  }
  if (opts?.extraArgs) args.push(...opts.extraArgs);

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    COWORK_HOME_OVERRIDE: coworkHomeDir,
    COWORK_DESKTOP_PARENT_MANAGED: "1",
    COWORK_NETWORK_TELEMETRY_DISABLED: "1",
    ...opts?.env,
  };

  const proc = spawn(binPath, args, {
    cwd: workspaceDir,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderrLines: string[] = [];
  const stderrReader = readline.createInterface({ input: proc.stderr });
  stderrReader.on("line", (line) => {
    stderrLines.push(line);
  });

  const stdoutReader = readline.createInterface({ input: proc.stdout });
  const listening = await new Promise<RustListeningEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for cowork-server startup. stderr:\n${stderrLines.join("\n")}`,
        ),
      );
    }, 15_000);

    stdoutReader.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return;
      try {
        const parsed = JSON.parse(trimmed) as { type?: string };
        if (parsed.type === "server_listening") {
          clearTimeout(timer);
          resolve(parsed as RustListeningEvent);
        }
      } catch {
        // ignore non-JSON lines
      }
    });

    proc.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `cowork-server exited early (code=${String(code)}, signal=${String(signal)}). stderr:\n${stderrLines.join("\n")}`,
        ),
      );
    });
  });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      stdoutReader.close();
      stderrReader.close();
      proc.stdin.end();
    } catch {
      // ignore closed stream
    }
    if (proc.exitCode === null && proc.signalCode === null) {
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          try {
            if (proc.exitCode === null && proc.signalCode === null) {
              proc.kill("SIGTERM");
            }
          } catch {
            // already exited
          }
          resolve();
        }, 5_000);
        proc.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
    }
    if (ownedRoot) {
      await fsp.rm(ownedRoot, { recursive: true, force: true });
    }
  };

  return {
    proc,
    listening,
    httpBaseUrl: `http://127.0.0.1:${listening.port}`,
    wsUrl: listening.wsUrl,
    rpcUrl: listening.rpcUrl,
    homeDir,
    coworkHomeDir,
    workspaceDir,
    stderrLines,
    stop,
  };
}

export type JsonRpcTestClient = {
  ws: WebSocket;
  notifications: Array<{ method: string; params: any }>;
  serverRequests: Array<{ id: string | number; method: string; params: any }>;
  request: <T = any>(method: string, params?: unknown) => Promise<T>;
  requestRaw: (
    method: string,
    params?: unknown,
  ) => Promise<{ id: number; result?: any; error?: { code: number; message: string; data?: any } }>;
  notify: (method: string, params?: unknown) => void;
  respond: (id: string | number, result: unknown) => void;
  waitForNotification: (
    predicate: (msg: { method: string; params: any }) => boolean,
    timeoutMs?: number,
  ) => Promise<{ method: string; params: any }>;
  waitForServerRequest: (
    predicate: (msg: { id: string | number; method: string; params: any }) => boolean,
    timeoutMs?: number,
  ) => Promise<{ id: string | number; method: string; params: any }>;
  close: () => void;
};

export async function connectRustJsonRpc(
  wsUrl: string,
  opts?: {
    skipInitialize?: boolean;
    experimentalApi?: boolean;
    toolRetryLineage?: boolean;
    optOutNotificationMethods?: string[];
  },
): Promise<JsonRpcTestClient> {
  const ws = new WebSocket(wsUrl, "cowork.jsonrpc.v1");
  const notifications: Array<{ method: string; params: any }> = [];
  const serverRequests: Array<{ id: string | number; method: string; params: any }> = [];
  const pending = new Map<
    string | number,
    { resolve: (msg: any) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const notifWaiters = new Set<{
    predicate: (msg: { method: string; params: any }) => boolean;
    resolve: (msg: { method: string; params: any }) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const reqWaiters = new Set<{
    predicate: (msg: { id: string | number; method: string; params: any }) => boolean;
    resolve: (msg: { id: string | number; method: string; params: any }) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  ws.onmessage = (event) => {
    const raw = typeof event.data === "string" ? event.data : String(event.data);
    const parsed = JSON.parse(raw);
    if ("id" in parsed && !("method" in parsed)) {
      const waiter = pending.get(parsed.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        pending.delete(parsed.id);
        waiter.resolve(parsed);
      }
      return;
    }
    if ("id" in parsed && typeof parsed.method === "string") {
      const entry = { id: parsed.id, method: parsed.method, params: parsed.params };
      for (const w of [...reqWaiters]) {
        if (w.predicate(entry)) {
          clearTimeout(w.timer);
          reqWaiters.delete(w);
          w.resolve(entry);
          return;
        }
      }
      serverRequests.push(entry);
      return;
    }
    if (typeof parsed.method === "string") {
      const entry = { method: parsed.method, params: parsed.params };
      for (const w of [...notifWaiters]) {
        if (w.predicate(entry)) {
          clearTimeout(w.timer);
          notifWaiters.delete(w);
          w.resolve(entry);
          return;
        }
      }
      notifications.push(entry);
    }
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket connect timeout")), 5_000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("WebSocket connect failed"));
    };
  });

  let nextId = 0;
  const requestRaw = async (method: string, params?: unknown) => {
    const id = ++nextId;
    const responsePromise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`JSON-RPC request ${method} timed out`));
      }, 15_000);
      pending.set(id, { resolve, timer });
    });
    ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }));
    return await responsePromise;
  };

  const request = async <T = any>(method: string, params?: unknown): Promise<T> => {
    const response = await requestRaw(method, params);
    if (response.error) {
      const err = new Error(
        `JSON-RPC error (${response.error.code}): ${response.error.message}`,
      ) as Error & { code?: number; data?: unknown };
      err.code = response.error.code;
      err.data = response.error.data;
      throw err;
    }
    return response.result as T;
  };

  const notify = (method: string, params?: unknown) => {
    ws.send(JSON.stringify({ method, ...(params !== undefined ? { params } : {}) }));
  };

  const respond = (id: string | number, result: unknown) => {
    ws.send(JSON.stringify({ id, result }));
  };

  const waitForNotification = async (
    predicate: (msg: { method: string; params: any }) => boolean,
    timeoutMs = 10_000,
  ) => {
    const idx = notifications.findIndex(predicate);
    if (idx >= 0) {
      return notifications.splice(idx, 1)[0]!;
    }
    return await new Promise<{ method: string; params: any }>((resolve, reject) => {
      const timer = setTimeout(() => {
        notifWaiters.delete(waiter);
        reject(new Error("Timed out waiting for JSON-RPC notification"));
      }, timeoutMs);
      const waiter = { predicate, resolve, timer };
      notifWaiters.add(waiter);
    });
  };

  const waitForServerRequest = async (
    predicate: (msg: { id: string | number; method: string; params: any }) => boolean,
    timeoutMs = 10_000,
  ) => {
    const idx = serverRequests.findIndex(predicate);
    if (idx >= 0) {
      return serverRequests.splice(idx, 1)[0]!;
    }
    return await new Promise<{ id: string | number; method: string; params: any }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          reqWaiters.delete(waiter);
          reject(new Error("Timed out waiting for JSON-RPC server request"));
        }, timeoutMs);
        const waiter = { predicate, resolve, timer };
        reqWaiters.add(waiter);
      },
    );
  };

  if (!opts?.skipInitialize) {
    await request("initialize", {
      clientInfo: { name: "rust-wire-test", version: "1.0.0" },
      capabilities: {
        experimentalApi: opts?.experimentalApi ?? true,
        toolRetryLineage: opts?.toolRetryLineage ?? true,
        ...(opts?.optOutNotificationMethods
          ? { optOutNotificationMethods: opts.optOutNotificationMethods }
          : {}),
      },
    });
    notify("initialized", {});
  }

  return {
    ws,
    notifications,
    serverRequests,
    request,
    requestRaw,
    notify,
    respond,
    waitForNotification,
    waitForServerRequest,
    close: () => ws.close(),
  };
}
