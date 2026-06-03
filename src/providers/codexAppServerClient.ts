import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { asRecord, asString } from "../shared/recordParsing";
import { resolveAuthHomeDir } from "../utils/authHome";
import { VERSION } from "../version";
import {
  type CodexAppServerCommand,
  resolveCodexAppServerCommand,
  spawnCodexAppServer,
} from "./codexAppServerResolver";

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type CodexAppServerJsonRpcDirection =
  | "client_request"
  | "client_notification"
  | "client_response"
  | "server_request"
  | "server_notification"
  | "server_response";

export type CodexAppServerJsonRpcRawMessage = {
  direction: CodexAppServerJsonRpcDirection;
  message: Record<string, unknown>;
};

export type CodexAppServerJsonRpcNotification = {
  method: string;
  params?: unknown;
};

export type CodexAppServerJsonRpcRequest = {
  id: number | string;
  method: string;
  params?: unknown;
};

export type CodexAppServerCloseInfo = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrBytes: number;
  closedAt: string;
};

export type CodexAppServerClient = {
  command: CodexAppServerCommand;
  isClosed: () => boolean;
  getLastCloseInfo?: () => CodexAppServerCloseInfo | null;
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  notify: (method: string, params?: unknown) => void;
  interruptTurn: (params: { threadId: string; turnId?: string }) => Promise<void>;
  onNotification: (
    listener: (notification: CodexAppServerJsonRpcNotification) => void,
  ) => () => void;
  onServerRequest: (handler: CodexAppServerRequestHandler) => () => void;
  onJsonRpcMessage: (listener: (message: CodexAppServerJsonRpcRawMessage) => void) => () => void;
  onClose?: (listener: (code: number | null, signal: NodeJS.Signals | null) => void) => () => void;
  onError?: (listener: (err: Error) => void) => () => void;
  close: () => Promise<void>;
};

type CodexAppServerRequestHandler = (
  request: CodexAppServerJsonRpcRequest,
) => Promise<unknown> | unknown;

export const UNHANDLED_CODEX_APP_SERVER_REQUEST = Symbol("unhandled codex app-server request");

export type CodexAppServerClientOptions = {
  cwd?: string;
  codexHome?: string;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  invalidJsonLogPrefix?: string;
  onServerRequest?: CodexAppServerRequestHandler;
  onJsonRpcMessage?: (message: CodexAppServerJsonRpcRawMessage) => void;
};

let clientFactoryForTests:
  | ((opts: CodexAppServerClientOptions) => Promise<CodexAppServerClient>)
  | undefined;

function resolveCodexHome(authHomeDir = resolveAuthHomeDir()): string {
  return path.join(authHomeDir, ".cowork", "auth", "codex-cli");
}

function codexAppServerClientInfo(): { name: string; title: string; version: string } {
  return {
    name: "agent-coworker",
    title: "Agent Coworker",
    version: VERSION,
  };
}

function codexAppServerInitializeParams(): {
  clientInfo: ReturnType<typeof codexAppServerClientInfo>;
  capabilities: { experimentalApi: boolean };
} {
  return {
    clientInfo: codexAppServerClientInfo(),
    capabilities: { experimentalApi: true },
  };
}

export async function startCodexAppServerClient(
  opts: CodexAppServerClientOptions = {},
): Promise<CodexAppServerClient> {
  if (clientFactoryForTests) return await clientFactoryForTests(opts);

  const command = await resolveCodexAppServerCommand();
  const codexHome = opts.codexHome ?? resolveCodexHome();
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  const baseEnv = opts.env ?? process.env;
  const child = spawnCodexAppServer(command, {
    cwd: opts.cwd,
    env: { ...baseEnv, CODEX_HOME: codexHome },
  });
  const pending = new Map<number | string, PendingRequest>();
  const listeners = new Set<(notification: CodexAppServerJsonRpcNotification) => void>();
  const serverRequestHandlers = new Set<CodexAppServerRequestHandler>();
  const jsonRpcMessageListeners = new Set<(message: CodexAppServerJsonRpcRawMessage) => void>();
  const closeListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  const errorListeners = new Set<(err: Error) => void>();
  let nextId = 1;
  let closed = false;
  let stderrBytes = 0;
  let lastCloseInfo: CodexAppServerCloseInfo | null = null;

  if (opts.onServerRequest) serverRequestHandlers.add(opts.onServerRequest);

  const emitJsonRpcMessage = (message: CodexAppServerJsonRpcRawMessage) => {
    opts.onJsonRpcMessage?.(message);
    for (const listener of jsonRpcMessageListeners) listener(message);
  };

  const rejectAll = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };

  child.once("error", (error) => {
    rejectAll(new Error(`Failed to start codex app-server: ${error.message}`));
    for (const listener of errorListeners) listener(error);
  });
  child.stdin.on("error", (error) => {
    opts.log?.(`[codex-app-server:stdin:error] ${error.message}`);
  });
  child.once("exit", (code, signal) => {
    closed = true;
    lastCloseInfo = {
      code,
      signal,
      stderrBytes,
      closedAt: new Date().toISOString(),
    };
    opts.log?.(
      `[codex-app-server] process exited code=${code ?? "null"} signal=${signal ?? "null"} stderrBytes=${stderrBytes}`,
    );
    if (pending.size > 0) {
      const pendingMethods = [...pending.values()].map((request) => request.method).join(", ");
      rejectAll(
        new Error(
          `codex app-server exited before replying (code=${code}, signal=${signal}, pending=${pendingMethods}, command=${command.command}, args=${JSON.stringify(command.args)})`,
        ),
      );
    }
    for (const listener of closeListeners) listener(code, signal);
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    stderrBytes += Buffer.byteLength(text);
    const trimmed = text.trim();
    if (trimmed) opts.log?.(`[codex-app-server:stderr] ${trimmed}`);
  });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (opts.invalidJsonLogPrefix) {
        opts.log?.(`${opts.invalidJsonLogPrefix}: ${String(error)}`);
      } else {
        opts.log?.(`[codex-app-server:stdout] ${line}`);
      }
      return;
    }

    const record = asRecord(parsed);
    if (!record) return;
    if ("id" in record && ("result" in record || "error" in record)) {
      emitJsonRpcMessage({ direction: "server_response", message: record });
      const id = record.id as number | string;
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      const error = asRecord(record.error);
      if (error) {
        const rpcError = new Error(asString(error.message) ?? "codex app-server request failed");
        Object.assign(rpcError, {
          ...(error.code !== undefined ? { code: error.code } : {}),
          ...(error.data !== undefined ? { data: error.data } : {}),
        });
        request.reject(rpcError);
      } else {
        request.resolve(record.result);
      }
      return;
    }

    if ("id" in record && typeof record.method === "string") {
      emitJsonRpcMessage({ direction: "server_request", message: record });
      void respondToServerRequest(
        child,
        record as CodexAppServerJsonRpcRequest,
        serverRequestHandlers,
        emitJsonRpcMessage,
      );
      return;
    }

    const notification = record as CodexAppServerJsonRpcNotification;
    emitJsonRpcMessage({ direction: "server_notification", message: record });
    for (const listener of listeners) listener(notification);
  });

  const write = (payload: Record<string, unknown>, direction: CodexAppServerJsonRpcDirection) => {
    if (closed || child.stdin.destroyed) throw new Error("codex app-server is not running.");
    emitJsonRpcMessage({ direction, message: payload });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  const request = (method: string, params?: unknown, timeoutMs?: number): Promise<unknown> => {
    const id = nextId++;
    const requestPromise = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { method, resolve, reject });
      try {
        write({ id, method, ...(params !== undefined ? { params } : {}) }, "client_request");
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    if (!timeoutMs || timeoutMs <= 0) return requestPromise;
    const timeoutPromise = new Promise<unknown>((_, reject) => {
      const timer = setTimeout(() => {
        const pendingRequest = pending.get(id);
        if (pendingRequest) {
          pending.delete(id);
          reject(new Error(`codex app-server request '${method}' timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      requestPromise.then(() => clearTimeout(timer)).catch(() => clearTimeout(timer));
    });
    return Promise.race([requestPromise, timeoutPromise]);
  };

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  return {
    command,
    isClosed: () => closed,
    getLastCloseInfo: () => lastCloseInfo,
    request,
    notify: (method, params) => {
      write({ method, ...(params !== undefined ? { params } : {}) }, "client_notification");
    },
    interruptTurn: async (params) => {
      const payload = {
        threadId: params.threadId,
        ...(params.turnId ? { turnId: params.turnId } : {}),
      };
      try {
        await request("turn/cancel", payload);
      } catch (firstError) {
        try {
          await request("turn/interrupt", payload);
        } catch {
          throw firstError instanceof Error ? firstError : new Error(String(firstError));
        }
      }
    },
    onNotification: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onServerRequest: (handler) => {
      serverRequestHandlers.add(handler);
      return () => {
        serverRequestHandlers.delete(handler);
      };
    },
    onJsonRpcMessage: (listener) => {
      jsonRpcMessageListeners.add(listener);
      return () => {
        jsonRpcMessageListeners.delete(listener);
      };
    },
    onClose: (listener) => {
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },
    onError: (listener) => {
      errorListeners.add(listener);
      return () => {
        errorListeners.delete(listener);
      };
    },
    close: async () => {
      rl.close();
      await stopProcess(child);
    },
  };
}

async function respondToServerRequest(
  child: ChildProcessWithoutNullStreams,
  request: CodexAppServerJsonRpcRequest,
  handlers: ReadonlySet<CodexAppServerRequestHandler>,
  onJsonRpcMessage: (message: CodexAppServerJsonRpcRawMessage) => void,
) {
  const writeResponse = (response: Record<string, unknown>) => {
    onJsonRpcMessage({ direction: "client_response", message: response });
    try {
      child.stdin.write(`${JSON.stringify(response)}\n`);
    } catch {
      // The app-server may have exited after issuing a request. There is no
      // live peer to receive the response, so keep the client shutdown local.
    }
  };
  try {
    let result: unknown = {};
    for (const handler of [...handlers].reverse()) {
      const handlerResult = await handler(request);
      if (handlerResult === UNHANDLED_CODEX_APP_SERVER_REQUEST) continue;
      result = handlerResult;
      break;
    }
    const response = { id: request.id, result: result ?? {} };
    writeResponse(response);
  } catch (error) {
    const response = {
      id: request.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    };
    writeResponse(response);
  }
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (process.platform === "win32") {
        child.kill(); // Windows uses default termination
      } else {
        child.kill("SIGKILL");
      }
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    if (process.platform === "win32") {
      child.kill(); // Windows uses default termination
    } else {
      child.kill("SIGTERM");
    }
  });
}

const pooledClients = new Map<string, Promise<CodexAppServerClient>>();

const POOLED_ENV_KEYS = [
  "PATH",
  "NODE_PATH",
  "NODE_OPTIONS",
  "COWORK_ARTIFACT_RUNTIME_DIR",
  "COWORK_ARTIFACT_RUNTIME_NODE",
  "COWORK_ARTIFACT_RUNTIME_PYTHON",
  "COWORK_ARTIFACT_RUNTIME_NODE_MODULES",
  "COWORK_ARTIFACT_RUNTIME_NODE_RESOLVER",
  "COWORK_SOFFICE",
  "COWORK_MANAGED_SOFFICE_ROOT",
  "COWORK_MANAGED_SOFFICE_SHIM_DIR",
  "COWORK_MANAGED_SOFFICE_SHIM",
] as const;

function envValue(env: Record<string, string | undefined> | undefined, key: string): string {
  if (!env) return "";
  const actualKey = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return actualKey ? (env[actualKey] ?? "") : "";
}

function pooledEnvFingerprint(env: Record<string, string | undefined> | undefined): string {
  return POOLED_ENV_KEYS.map((key) => `${key}=${JSON.stringify(envValue(env, key))}`).join("|");
}

function pooledClientKey(
  cwd: string | undefined,
  codexHome: string,
  env?: Record<string, string | undefined>,
): string {
  return `${cwd ? `cwd:${cwd}` : "cwd:"}|codexHome:${codexHome}|env:${pooledEnvFingerprint(env)}`;
}

function pooledClientMatches(key: string, cwd: string | undefined, codexHome: string): boolean {
  const prefix = `${cwd ? `cwd:${cwd}` : "cwd:"}|codexHome:${codexHome}|`;
  return key.startsWith(prefix);
}

export async function getPooledCodexAppServerClient(
  opts: CodexAppServerClientOptions = {},
): Promise<CodexAppServerClient> {
  const codexHome = opts.codexHome ?? resolveCodexHome();
  const key = pooledClientKey(opts.cwd, codexHome, opts.env);
  const existing = pooledClients.get(key);
  if (existing) {
    try {
      const client = await existing;
      if (!client.isClosed()) return client;
    } catch (error) {
      opts.log?.(`[codex-app-server] Discarding failed pooled client: ${String(error)}`);
    }
    pooledClients.delete(key);
  }

  const created = (async () => {
    const client = await startCodexAppServerClient({
      cwd: opts.cwd,
      codexHome,
      env: opts.env,
      log: opts.log,
      invalidJsonLogPrefix: opts.invalidJsonLogPrefix,
    });
    try {
      await client.request("initialize", codexAppServerInitializeParams());
      client.notify("initialized");
      client.onClose?.((code, signal) => {
        if (pooledClients.get(key) === created) {
          pooledClients.delete(key);
        }
        opts.log?.(
          `[codex-app-server] pooled client closed; evicted=true code=${code ?? "null"} signal=${signal ?? "null"}`,
        );
      });
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  })();
  pooledClients.set(key, created);
  try {
    return await created;
  } catch (error) {
    pooledClients.delete(key);
    throw error;
  }
}

export async function closePooledCodexAppServerClients(): Promise<void> {
  const clients = [...pooledClients.values()];
  pooledClients.clear();
  await Promise.all(
    clients.map(async (clientPromise) => {
      try {
        const client = await clientPromise;
        await client.close();
      } catch {
        // ignore cleanup failures
      }
    }),
  );
}

export async function closePooledCodexAppServerClientsForHome(
  codexHome = resolveCodexHome(),
): Promise<void> {
  const clients: Promise<CodexAppServerClient>[] = [];
  const keyNeedle = `|codexHome:${codexHome}|`;
  for (const [key, clientPromise] of pooledClients) {
    if (!key.includes(keyNeedle)) continue;
    pooledClients.delete(key);
    clients.push(clientPromise);
  }
  await Promise.all(
    clients.map(async (clientPromise) => {
      try {
        const client = await clientPromise;
        await client.close();
      } catch {
        // ignore cleanup failures
      }
    }),
  );
}

export async function closePooledCodexAppServerClient(
  cwd: string | undefined,
  codexHome?: string,
): Promise<void> {
  const resolvedCodexHome = codexHome ?? resolveCodexHome();
  const clients: Promise<CodexAppServerClient>[] = [];
  for (const [key, clientPromise] of pooledClients) {
    if (!pooledClientMatches(key, cwd, resolvedCodexHome)) continue;
    pooledClients.delete(key);
    clients.push(clientPromise);
  }
  await Promise.all(
    clients.map(async (clientPromise) => {
      try {
        const client = await clientPromise;
        await client.close();
      } catch {
        // ignore cleanup failures
      }
    }),
  );
}

export const __internal = {
  resolveCodexHome,
  respondToServerRequest,
  setClientFactoryForTests(
    factory: ((opts: CodexAppServerClientOptions) => Promise<CodexAppServerClient>) | undefined,
  ): void {
    clientFactoryForTests = factory;
  },
  pooledEnvFingerprint,
} as const;
