#!/usr/bin/env bun

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { jsonRpcRuntimeResultSchemas } from "../src/shared/jsonrpcControlSchemas";
import { resolveWorkspaceServerBinary } from "./workspaceRustBinary";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const DEFAULT_SETUP_RUNTIME_TIMEOUT_MS = 120_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
const POLL_INTERVAL_MS = 250;

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: expected a positive integer in ms, got "${raw}"`);
  }
  return Math.floor(parsed);
}

function resolveCoworkServerBinary(): string {
  const explicitOverride = process.env.COWORK_SETUP_RUNTIME_SERVER_BIN?.trim();
  if (explicitOverride) {
    if (fs.existsSync(explicitOverride)) return path.resolve(explicitOverride);
    throw new Error(`COWORK_SETUP_RUNTIME_SERVER_BIN does not exist: ${explicitOverride}`);
  }
  return resolveWorkspaceServerBinary(REPO_ROOT);
}

const timeoutMs = parsePositiveIntEnv(
  "COWORK_SETUP_RUNTIME_TIMEOUT_MS",
  DEFAULT_SETUP_RUNTIME_TIMEOUT_MS,
);
const shutdownGraceMs = parsePositiveIntEnv(
  "COWORK_SETUP_RUNTIME_SHUTDOWN_GRACE_MS",
  DEFAULT_SHUTDOWN_GRACE_MS,
);
const bin = resolveCoworkServerBinary();
const forceReinstall = process.argv.includes("--force");
// An explicit target must be what ends up ready: the server must not satisfy it with an older
// cached runtime (it skips fallback recovery for explicit versions and --force, and this script
// double-checks the version it reports).
const requestedRuntimeVersion = process.env.COWORK_RUNTIME_VERSION?.trim() || null;
// Compiling on a clean checkout is not part of runtime bootstrap.
const deadline = Date.now() + timeoutMs;
const proc = spawn(bin, ["--host", "127.0.0.1", "--port", "0", "--json"], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    COWORK_REPO_ROOT: process.env.COWORK_REPO_ROOT?.trim() || REPO_ROOT,
    COWORK_DESKTOP_PARENT_MANAGED: "1",
    COWORK_DISABLE_RUNTIME: "0",
    COWORK_RUNTIME_ALLOW_NETWORK: "1",
    ...(forceReinstall ? { COWORK_RUNTIME_FORCE: "1" } : {}),
  },
  stdio: ["pipe", "pipe", "inherit"],
});

const childExited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
  (resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve({ code: proc.exitCode, signal: proc.signalCode });
      return;
    }
    proc.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  },
);

function waitForChildExitWithin(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void childExited.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function shutdownChildServer(): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    await childExited;
    return;
  }

  try {
    proc.stdin.end();
  } catch {
    // Child stdin may already be closed if cowork-server exited concurrently.
  }

  if (await waitForChildExitWithin(shutdownGraceMs)) {
    return;
  }

  try {
    proc.kill("SIGTERM");
  } catch {
    // Process may have exited right as the grace window elapsed.
  }

  if (await waitForChildExitWithin(Math.min(shutdownGraceMs, 2_000))) {
    return;
  }

  try {
    proc.kill("SIGKILL");
  } catch {
    // Process already exited.
  }
  await waitForChildExitWithin(1_000);
}

const rl = readline.createInterface({ input: proc.stdout });
let ws: WebSocket | null = null;

try {
  const wsUrl = await new Promise<string>((resolve, reject) => {
    const remainingMs = Math.max(1, deadline - Date.now());
    const startupTimer = setTimeout(() => {
      rl.close();
      reject(
        new Error(`Timed out after ${timeoutMs}ms waiting for cowork-server startup listener.`),
      );
    }, remainingMs);

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return;
      try {
        const evt = JSON.parse(trimmed) as { type?: string; wsUrl?: string };
        if (evt.type === "server_listening" && evt.wsUrl) {
          clearTimeout(startupTimer);
          rl.close();
          resolve(evt.wsUrl);
        }
      } catch {
        // Ignore non-event stdout lines before server_listening.
      }
    });

    void childExited.then(({ code, signal }) => {
      clearTimeout(startupTimer);
      reject(
        new Error(`cowork-server exited early (code=${String(code)}, signal=${String(signal)})`),
      );
    });
  });

  const socket = new WebSocket(wsUrl, "cowork.jsonrpc.v1");
  ws = socket;

  await new Promise<void>((resolve, reject) => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for Cowork runtime bootstrap to become ready.`,
        ),
      );
      return;
    }
    const connectTimer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms connecting to cowork-server WebSocket.`));
    }, remainingMs);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(connectTimer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(connectTimer);
        reject(new Error("WebSocket connect failed"));
      },
      { once: true },
    );
  });

  let nextId = 0;
  const request = (method: string, params?: unknown): Promise<unknown> =>
    new Promise<unknown>((resolve, reject) => {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for Cowork runtime bootstrap to become ready.`,
          ),
        );
        return;
      }

      const id = ++nextId;
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("close", onClose);
        socket.removeEventListener("error", onError);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for ${method} response from cowork-server.`,
          ),
        );
      }, remainingMs);
      const onMessage = (event: MessageEvent) => {
        const msg = JSON.parse(String(event.data)) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        };
        if (msg.id !== id) return;
        cleanup();
        if (msg.error) {
          reject(new Error(msg.error.message ?? "JSON-RPC error"));
          return;
        }
        resolve(msg.result);
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`WebSocket closed while waiting for ${method}`));
      };
      const onError = () => {
        cleanup();
        reject(new Error(`WebSocket error while waiting for ${method}`));
      };

      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", onClose);
      socket.addEventListener("error", onError);
      socket.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }));
    });

  await request("initialize", { clientInfo: { name: "setup-cowork-runtime", version: "1.0.0" } });
  socket.send(JSON.stringify({ method: "initialized", params: {} }));

  const diagnosticsSchema = jsonRpcRuntimeResultSchemas["cowork/runtime/diagnostics/read"];
  let runtimeReady = false;

  while (Date.now() < deadline) {
    const rawResult = await request("cowork/runtime/diagnostics/read", {});
    const parsed = diagnosticsSchema.parse(rawResult);
    const { startup } = parsed.diagnostics;

    if (startup.ready) {
      // `ready` alone is not proof of success: the server also reports ready when the runtime is
      // disabled or network bootstrap is off, and the resolved runtime might not be the one asked
      // for. Require the final `ready` progress event and, when a target was given, its version.
      const progress = startup.progress ?? null;
      if (!progress || progress.phase !== "ready") {
        throw new Error(
          "Cowork runtime setup did not install a runtime: startup reported ready without a resolved runtime version.",
        );
      }
      if (requestedRuntimeVersion && progress.version !== requestedRuntimeVersion) {
        throw new Error(
          `Cowork runtime setup resolved runtime ${progress.version}, but COWORK_RUNTIME_VERSION requested ${requestedRuntimeVersion}.`,
        );
      }
      console.log(JSON.stringify(parsed, null, 2));
      runtimeReady = true;
      break;
    }
    if (startup.error) {
      throw new Error(`Cowork runtime setup failed: ${startup.error}`);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remainingMs)));
  }

  if (!runtimeReady) {
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for Cowork runtime bootstrap to become ready.`,
    );
  }
} finally {
  rl.close();
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    const closed = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      ws?.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    try {
      ws.close();
    } catch {
      // Socket may already be closing.
    }
    await closed;
  }
  await shutdownChildServer();
}
