import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { asRecord, asString } from "../runtime/piRuntimeOptions";
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

export type CodexAppServerJsonRpcDirection =
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

export type CodexAppServerClient = {
  command: CodexAppServerCommand;
  isClosed: () => boolean;
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  notify: (method: string, params?: unknown) => void;
  interruptTurn: (params: { threadId: string; turnId?: string }) => Promise<void>;
  onNotification: (
    listener: (notification: CodexAppServerJsonRpcNotification) => void,
  ) => () => void;
  onServerRequest: (handler: CodexAppServerRequestHandler) => () => void;
  onJsonRpcMessage: (listener: (message: CodexAppServerJsonRpcRawMessage) => void) => () => void;
  close: () => Promise<void>;
};

export type CodexAppServerRequestHandler = (
  request: CodexAppServerJsonRpcRequest,
) => Promise<unknown> | unknown;

export type CodexAppServerClientOptions = {
  cwd?: string;
  codexHome?: string;
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

export function codexAppServerClientInfo(): { name: string; title: string; version: string } {
  return {
    name: "agent-coworker",
    title: "Agent Coworker",
    version: VERSION,
  };
}

export function codexAppServerInitializeParams(): {
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
  const child = spawnCodexAppServer(command, {
    cwd: opts.cwd,
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  const pending = new Map<number | string, PendingRequest>();
  const listeners = new Set<(notification: CodexAppServerJsonRpcNotification) => void>();
  const serverRequestHandlers = new Set<CodexAppServerRequestHandler>();
  const jsonRpcMessageListeners = new Set<(message: CodexAppServerJsonRpcRawMessage) => void>();
  let nextId = 1;
  let closed = false;

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
  });
  child.once("exit", (code, signal) => {
    closed = true;
    if (pending.size > 0) {
      const pendingMethods = [...pending.values()].map((request) => request.method).join(", ");
      rejectAll(
        new Error(
          `codex app-server exited before replying (code=${code}, signal=${signal}, pending=${pendingMethods}, command=${command.command}, args=${JSON.stringify(command.args)})`,
        ),
      );
    }
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) opts.log?.(`[codex-app-server:stderr] ${text}`);
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
    const handler = [...handlers].at(-1);
    if (handler) result = await handler(request);
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
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

export async function withCodexAppServerClient<T>(
  fn: (client: CodexAppServerClient) => Promise<T>,
  opts: CodexAppServerClientOptions = {},
): Promise<T> {
  const client = await startCodexAppServerClient(opts);
  let originalError: unknown;
  let result: { value: T } | undefined;
  try {
    await client.request("initialize", codexAppServerInitializeParams());
    client.notify("initialized");
    result = { value: await fn(client) };
  } catch (error) {
    originalError = error;
  }
  try {
    await client.close();
  } catch (closeError) {
    if (originalError !== undefined) {
      opts.log?.(`[codex-app-server] close failed after error: ${String(closeError)}`);
    } else {
      throw closeError;
    }
  }
  if (originalError !== undefined) {
    throw originalError;
  }
  if (!result) {
    throw new Error("Codex app-server client closed before returning a result.");
  }
  return result.value;
}

const pooledClients = new Map<string, Promise<CodexAppServerClient>>();

function pooledClientKey(cwd: string | undefined, codexHome: string): string {
  return `${cwd ? `cwd:${cwd}` : "cwd:"}|codexHome:${codexHome}`;
}

export async function getPooledCodexAppServerClient(
  opts: CodexAppServerClientOptions = {},
): Promise<CodexAppServerClient> {
  const codexHome = opts.codexHome ?? resolveCodexHome();
  const key = pooledClientKey(opts.cwd, codexHome);
  const existing = pooledClients.get(key);
  if (existing) {
    const client = await existing;
    if (!client.isClosed()) return client;
    pooledClients.delete(key);
  }

  const created = (async () => {
    const client = await startCodexAppServerClient({
      cwd: opts.cwd,
      codexHome,
      log: opts.log,
      invalidJsonLogPrefix: opts.invalidJsonLogPrefix,
    });
    try {
      await client.request("initialize", codexAppServerInitializeParams());
      client.notify("initialized");
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

export async function closePooledCodexAppServerClient(
  cwd: string | undefined,
  codexHome?: string,
): Promise<void> {
  const key = pooledClientKey(cwd, codexHome ?? resolveCodexHome());
  const clientPromise = pooledClients.get(key);
  if (!clientPromise) return;
  pooledClients.delete(key);
  try {
    const client = await clientPromise;
    await client.close();
  } catch {
    // ignore cleanup failures
  }
}

export const __internal = {
  resolveCodexHome,
  setClientFactoryForTests(
    factory: ((opts: CodexAppServerClientOptions) => Promise<CodexAppServerClient>) | undefined,
  ): void {
    clientFactoryForTests = factory;
  },
} as const;
