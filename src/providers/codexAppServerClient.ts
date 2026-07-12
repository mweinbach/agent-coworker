import fs from "node:fs/promises";
import path from "node:path";

import { asRecord, asString } from "../shared/recordParsing";
import { resolveAuthHomeDir } from "../utils/authHome";
import { type StreamingSubprocess, subscribeLines } from "../utils/subprocess";
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

/**
 * Build the spawn environment for the managed Codex app-server. Strips every
 * inherited `CODEX_*` variable before pinning `CODEX_HOME` so state from a
 * standalone Codex install (`~/.codex`) can never leak into the Cowork-managed
 * runtime: Windows environment names are case-insensitive, so a differently
 * cased `Codex_Home` from a shell profile would otherwise ride along and can
 * shadow the pinned value, and markers like `CODEX_SANDBOX` /
 * `CODEX_COMPANION_SESSION_ID` from external Codex tooling would change the
 * server's behavior.
 */
function buildCodexSpawnEnv(
  baseEnv: Record<string, string | undefined>,
  codexHome: string,
): Record<string, string | undefined> {
  const spawnEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (/^CODEX_/i.test(key)) continue;
    spawnEnv[key] = value;
  }
  spawnEnv.CODEX_HOME = codexHome;
  return spawnEnv;
}

export async function startCodexAppServerClient(
  opts: CodexAppServerClientOptions = {},
): Promise<CodexAppServerClient> {
  if (clientFactoryForTests) return await clientFactoryForTests(opts);

  const command = await resolveCodexAppServerCommand();
  const codexHome = opts.codexHome ?? resolveCodexHome();
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  const baseEnv = opts.env ?? process.env;
  let child: StreamingSubprocess;
  try {
    child = spawnCodexAppServer(command, {
      cwd: opts.cwd,
      env: buildCodexSpawnEnv(baseEnv, codexHome),
    });
  } catch (error) {
    throw new Error(
      `Failed to start codex app-server: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

  void child.exited.then(({ exitCode, signalCode }) => {
    const code = exitCode;
    const signal = (signalCode ?? null) as NodeJS.Signals | null;
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
  const stderrSubscription = subscribeLines(child.stderr, (line) => {
    stderrBytes += Buffer.byteLength(`${line}\n`);
    const trimmed = line.trim();
    if (trimmed) opts.log?.(`[codex-app-server:stderr] ${trimmed}`);
  });
  void stderrSubscription.done;

  const stdoutSubscription = subscribeLines(child.stdout, (line) => {
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
    if (closed || !child.writeStdin) throw new Error("codex app-server is not running.");
    emitJsonRpcMessage({ direction, message: payload });
    try {
      child.writeStdin(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      opts.log?.(
        `[codex-app-server:stdin:error] ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new Error("codex app-server is not running.");
    }
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
      stdoutSubscription.close();
      stderrSubscription.close();
      await stopProcess(child);
    },
  };
}

async function respondToServerRequest(
  child: StreamingSubprocess,
  request: CodexAppServerJsonRpcRequest,
  handlers: ReadonlySet<CodexAppServerRequestHandler>,
  onJsonRpcMessage: (message: CodexAppServerJsonRpcRawMessage) => void,
) {
  const writeResponse = (response: Record<string, unknown>) => {
    onJsonRpcMessage({ direction: "client_response", message: response });
    try {
      child.writeStdin?.(`${JSON.stringify(response)}\n`);
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

async function stopProcess(child: StreamingSubprocess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    child.kill(); // Windows uses default termination
  } else {
    child.kill("SIGTERM");
  }
  const exited = await Promise.race([
    child.exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (exited) return;
  if (process.platform === "win32") {
    child.kill(); // Windows uses default termination
  } else {
    child.kill("SIGKILL");
  }
}

const pooledClients = new Map<string, Promise<CodexAppServerClient>>();

const POOLED_ENV_KEYS = [
  "PATH",
  "NODE_PATH",
  "NODE_OPTIONS",
  "COWORK_RUNTIME_DIR",
  "COWORK_RUNTIME_VERSION",
  "COWORK_RUNTIME_ASSET",
  "COWORK_RUNTIME_NODE",
  "COWORK_RUNTIME_PYTHON",
  "COWORK_RUNTIME_NODE_MODULES",
  "COWORK_RUNTIME_NODE_RESOLVER",
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
  buildCodexSpawnEnv,
  respondToServerRequest,
  setClientFactoryForTests(
    factory: ((opts: CodexAppServerClientOptions) => Promise<CodexAppServerClient>) | undefined,
  ): void {
    clientFactoryForTests = factory;
  },
  pooledEnvFingerprint,
} as const;
