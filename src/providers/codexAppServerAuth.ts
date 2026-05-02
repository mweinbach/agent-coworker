import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

import { asRecord, asString } from "../runtime/piRuntimeOptions";
import { openExternalUrl, type UrlOpener } from "../utils/browser";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

type JsonRpcRequest = {
  id: number | string;
  method: string;
  params?: unknown;
};

type CodexAppServerClient = {
  request: (method: string, params?: unknown) => Promise<unknown>;
  notify: (method: string, params?: unknown) => void;
  onNotification: (listener: (notification: JsonRpcNotification) => void) => () => void;
  close: () => Promise<void>;
};

export type CodexAppServerAccount = {
  type: "apiKey" | "chatgpt";
  email?: string;
  planType?: string;
};

export type CodexAppServerRateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt?: number;
};

export type CodexAppServerRateLimits = {
  primary?: CodexAppServerRateLimitWindow | null;
  secondary?: CodexAppServerRateLimitWindow | null;
  credits?: {
    hasCredits: boolean;
    unlimited: boolean;
    balance?: string | number;
  } | null;
};

type ReadAccountOptions = {
  refreshToken?: boolean;
  log?: (line: string) => void;
};

type ReadRateLimitsOptions = {
  log?: (line: string) => void;
};

type LoginOptions = {
  openUrl?: UrlOpener;
  log?: (line: string) => void;
};

type AppServerAuthOverrides = {
  readAccount?: (
    opts: ReadAccountOptions,
  ) => Promise<{ account: CodexAppServerAccount | null; requiresOpenaiAuth: boolean }>;
  readRateLimits?: (opts: ReadRateLimitsOptions) => Promise<CodexAppServerRateLimits | null>;
  login?: (opts: LoginOptions) => Promise<{ account: CodexAppServerAccount | null }>;
};

const DEFAULT_CODEX_COMMAND = "codex";
const DEFAULT_CODEX_ARGS = ["app-server"] as const;
const appServerAuthOverrides: AppServerAuthOverrides = {};

function codexCommand(): { command: string; args: string[] } {
  return {
    command: process.env.COWORK_CODEX_APP_SERVER_COMMAND?.trim() || DEFAULT_CODEX_COMMAND,
    args: process.env.COWORK_CODEX_APP_SERVER_ARGS?.trim().split(/\s+/).filter(Boolean) ?? [
      ...DEFAULT_CODEX_ARGS,
    ],
  };
}

function startClient(log?: (line: string) => void): CodexAppServerClient {
  const { command, args } = codexCommand();
  const child = spawn(command, args, {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number | string, PendingRequest>();
  const listeners = new Set<(notification: JsonRpcNotification) => void>();
  let nextId = 1;
  let closed = false;

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
      rejectAll(
        new Error(`codex app-server exited before replying (code=${code}, signal=${signal})`),
      );
    }
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) log?.(`[codex-app-server:stderr] ${text}`);
  });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      log?.(`[codex-app-server:stdout] ${line}`);
      return;
    }
    const record = asRecord(parsed);
    if (!record) return;

    if ("id" in record && ("result" in record || "error" in record)) {
      const request = pending.get(record.id as number | string);
      if (!request) return;
      pending.delete(record.id as number | string);
      const error = asRecord(record.error);
      if (error) {
        request.reject(new Error(asString(error.message) ?? "codex app-server request failed"));
      } else {
        request.resolve(record.result);
      }
      return;
    }

    if ("id" in record && typeof record.method === "string") {
      respondToServerRequest(child, record as JsonRpcRequest);
      return;
    }

    const notification = record as JsonRpcNotification;
    for (const listener of listeners) listener(notification);
  });

  const write = (payload: unknown) => {
    if (closed || child.stdin.destroyed) throw new Error("codex app-server is not running.");
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        try {
          write({ id, method, ...(params !== undefined ? { params } : {}) });
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }),
    notify: (method, params) => {
      write({ method, ...(params !== undefined ? { params } : {}) });
    },
    onNotification: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: async () => {
      rl.close();
      await stopProcess(child);
    },
  };
}

function respondToServerRequest(child: ChildProcessWithoutNullStreams, request: JsonRpcRequest) {
  child.stdin.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 500);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function withClient<T>(
  fn: (client: CodexAppServerClient) => Promise<T>,
  log?: (line: string) => void,
): Promise<T> {
  const client = startClient(log);
  try {
    await client.request("initialize", {
      clientInfo: {
        name: "agent-coworker",
        title: "Agent Coworker",
        version: "0.1.0",
      },
    });
    client.notify("initialized");
    return await fn(client);
  } finally {
    await client.close();
  }
}

function normalizeAccount(value: unknown): CodexAppServerAccount | null {
  const account = asRecord(value);
  const type = asString(account?.type);
  if (type === "apiKey") return { type };
  if (type === "chatgpt") {
    const email = asString(account?.email);
    const planType = asString(account?.planType);
    return {
      type,
      ...(email ? { email } : {}),
      ...(planType ? { planType } : {}),
    };
  }
  return null;
}

export async function readCodexAppServerAccount(
  opts: ReadAccountOptions,
): Promise<{ account: CodexAppServerAccount | null; requiresOpenaiAuth: boolean }> {
  if (appServerAuthOverrides.readAccount) return await appServerAuthOverrides.readAccount(opts);
  return await withClient(async (client) => {
    const result = asRecord(
      await client.request("account/read", { refreshToken: opts.refreshToken ?? false }),
    );
    return {
      account: normalizeAccount(result?.account),
      requiresOpenaiAuth: result?.requiresOpenaiAuth === true,
    };
  }, opts.log);
}

export async function readCodexAppServerRateLimits(
  opts: ReadRateLimitsOptions,
): Promise<CodexAppServerRateLimits | null> {
  if (appServerAuthOverrides.readRateLimits) {
    return await appServerAuthOverrides.readRateLimits(opts);
  }
  return await withClient(async (client) => {
    const result = asRecord(await client.request("account/rateLimits/read"));
    return (asRecord(result?.rateLimits) as CodexAppServerRateLimits | null) ?? null;
  }, opts.log);
}

export async function loginCodexAppServerChatGpt(
  opts: LoginOptions,
): Promise<{ account: CodexAppServerAccount | null }> {
  if (appServerAuthOverrides.login) return await appServerAuthOverrides.login(opts);
  return await withClient(async (client) => {
    const started = asRecord(await client.request("account/login/start", { type: "chatgpt" }));
    const authUrl = asString(started?.authUrl);
    const loginId = asString(started?.loginId);
    if (!authUrl || !loginId) {
      throw new Error("codex app-server did not return a ChatGPT login URL.");
    }
    opts.log?.("[auth] opening Codex app-server ChatGPT login URL.");
    await (opts.openUrl ?? openExternalUrl)(authUrl);
    await waitForLogin(client, loginId);
    const result = asRecord(await client.request("account/read", { refreshToken: true }));
    return {
      account: normalizeAccount(result?.account),
    };
  }, opts.log);
}

export const __internal = {
  setAuthOverridesForTests(overrides: AppServerAuthOverrides): void {
    appServerAuthOverrides.readAccount = overrides.readAccount;
    appServerAuthOverrides.readRateLimits = overrides.readRateLimits;
    appServerAuthOverrides.login = overrides.login;
  },
  resetAuthOverridesForTests(): void {
    delete appServerAuthOverrides.readAccount;
    delete appServerAuthOverrides.readRateLimits;
    delete appServerAuthOverrides.login;
  },
} as const;

async function waitForLogin(client: CodexAppServerClient, loginId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        dispose();
        reject(new Error("Timed out waiting for Codex app-server login."));
      },
      10 * 60 * 1000,
    );
    const dispose = client.onNotification((notification) => {
      if (notification.method !== "account/login/completed") return;
      const params = asRecord(notification.params);
      if (asString(params?.loginId) !== loginId) return;
      clearTimeout(timeout);
      dispose();
      if (params?.success === true) {
        resolve();
      } else {
        reject(new Error(asString(params?.error) ?? "Codex app-server login failed."));
      }
    });
  });
}
