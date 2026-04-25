import { WebSocket } from "ws";

type DesktopSmokeJsonRpcMessage = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
};

type DesktopSmokeWaitOptions = {
  timeoutMs?: number;
  label: string;
};

type TimerHandle = ReturnType<typeof setTimeout>;

type DesktopSmokeSocket = {
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(event: "close", listener: (code?: number, reason?: Buffer) => void): unknown;
  once(event: "open", listener: () => void): unknown;
  once(event: "error", listener: (error: unknown) => void): unknown;
  once(event: "close", listener: (code?: number, reason?: Buffer) => void): unknown;
  send(data: string): void;
  close(): void;
};

type DesktopSmokeTimerFns = {
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

type DesktopSmokeWaiter = {
  predicate: (message: DesktopSmokeJsonRpcMessage) => boolean;
  resolve: (message: DesktopSmokeJsonRpcMessage) => void;
  reject: (error: Error) => void;
  timer: TimerHandle;
};

export type DesktopSmokeJsonRpcConnection = {
  sendRequest: (method: string, params?: unknown) => Promise<DesktopSmokeJsonRpcMessage>;
  waitFor: (
    predicate: (message: DesktopSmokeJsonRpcMessage) => boolean,
    options: DesktopSmokeWaitOptions,
  ) => Promise<DesktopSmokeJsonRpcMessage>;
  close: () => void;
};

export type ConnectDesktopSmokeJsonRpcOptions = DesktopSmokeTimerFns & {
  url: string;
  clientVersion: string;
  createWebSocket?: (url: string, protocols?: string | string[]) => DesktopSmokeSocket;
};

export type RunDesktopSmokePromptLoadCheckOptions = {
  url: string;
  workspacePath: string;
  clientVersion: string;
  connectJsonRpc?: (
    options: ConnectDesktopSmokeJsonRpcOptions,
  ) => Promise<DesktopSmokeJsonRpcConnection>;
  now?: () => number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const TURN_COMPLETION_TIMEOUT_MS = 30_000;
const DESKTOP_SMOKE_CLIENT_NAME = "desktop-smoke";
const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);

function formatUnknownError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function connectDesktopSmokeJsonRpc(
  options: ConnectDesktopSmokeJsonRpcOptions,
): Promise<DesktopSmokeJsonRpcConnection> {
  const createWebSocket =
    options.createWebSocket ??
    ((url: string) =>
      new WebSocket(url, "cowork.jsonrpc.v1") as unknown as DesktopSmokeSocket);
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

  const ws = createWebSocket(options.url, "cowork.jsonrpc.v1");
  const queue: DesktopSmokeJsonRpcMessage[] = [];
  const waiters = new Set<DesktopSmokeWaiter>();
  let terminalError: Error | null = null;

  const failAllWaiters = (error: Error) => {
    if (terminalError) {
      return;
    }
    terminalError = error;
    for (const waiter of [...waiters]) {
      clearTimeoutFn(waiter.timer);
      waiters.delete(waiter);
      waiter.reject(error);
    }
  };

  const resolveWaiters = (message: DesktopSmokeJsonRpcMessage) => {
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) {
        continue;
      }
      clearTimeoutFn(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(message);
      return true;
    }
    return false;
  };

  ws.on("message", (data) => {
    const raw =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : String(data);
    let message: DesktopSmokeJsonRpcMessage;
    try {
      message = JSON.parse(raw) as DesktopSmokeJsonRpcMessage;
    } catch (error) {
      failAllWaiters(
        new Error(`Desktop smoke received malformed JSON-RPC message: ${String(error)}`),
      );
      ws.close();
      return;
    }

    // Notifications may arrive before a waiter is registered, so unmatched messages stay queued.
    if (!resolveWaiters(message)) {
      queue.push(message);
    }
  });

  ws.on("error", (error) => {
    failAllWaiters(formatUnknownError(error));
  });
  ws.on("close", (_code, reason) => {
    const reasonText = reason && reason.length > 0 ? `: ${reason.toString("utf8")}` : "";
    failAllWaiters(new Error(`Desktop smoke websocket closed${reasonText}`));
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeoutFn(
      () => reject(new Error("Timed out waiting for desktop smoke websocket open")),
      DEFAULT_TIMEOUT_MS,
    );
    ws.once("open", () => {
      clearTimeoutFn(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeoutFn(timer);
      reject(formatUnknownError(error));
    });
    ws.once("close", (_code, reason) => {
      clearTimeoutFn(timer);
      const reasonText = reason && reason.length > 0 ? `: ${reason.toString("utf8")}` : "";
      reject(new Error(`Desktop smoke websocket closed before open${reasonText}`));
    });
  });

  const waitFor = async (
    predicate: (message: DesktopSmokeJsonRpcMessage) => boolean,
    waitOptions: DesktopSmokeWaitOptions,
  ): Promise<DesktopSmokeJsonRpcMessage> => {
    const existingIndex = queue.findIndex(predicate);
    if (existingIndex >= 0) {
      const existing = queue.splice(existingIndex, 1)[0];
      if (existing) {
        return existing;
      }
    }
    if (terminalError) {
      throw terminalError;
    }

    return await new Promise((resolve, reject) => {
      const timer = setTimeoutFn(() => {
        waiters.delete(waiter);
        reject(new Error(`Timed out waiting for desktop smoke ${waitOptions.label}`));
      }, waitOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const waiter: DesktopSmokeWaiter = { predicate, resolve, reject, timer };
      waiters.add(waiter);
    });
  };

  let nextId = 0;
  const sendRequest = async (method: string, params?: unknown) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }));
    const response = await waitFor((message) => message.id === id, {
      label: `response to ${method}`,
    });
    if (response.error) {
      const code = typeof response.error.code === "number" ? ` (${response.error.code})` : "";
      throw new Error(`${method} failed${code}: ${response.error.message ?? "unknown_error"}`);
    }
    return response;
  };

  let initialized = false;
  try {
    const initializeResponse = await sendRequest("initialize", {
      clientInfo: {
        name: DESKTOP_SMOKE_CLIENT_NAME,
        version: options.clientVersion,
      },
    });
    if (
      (initializeResponse.result as { protocolVersion?: string } | undefined)?.protocolVersion !==
      "0.1"
    ) {
      throw new Error("Desktop smoke initialize returned an unexpected protocol version");
    }
    // JSON-RPC startup is a two-step handshake: initialize request, then initialized notification.
    ws.send(JSON.stringify({ method: "initialized" }));
    initialized = true;
  } finally {
    if (!initialized) {
      ws.close();
    }
  }

  return {
    sendRequest,
    waitFor,
    close: () => ws.close(),
  };
}

export async function runDesktopSmokePromptLoadCheck(
  options: RunDesktopSmokePromptLoadCheckOptions,
): Promise<void> {
  const connectJsonRpc = options.connectJsonRpc ?? connectDesktopSmokeJsonRpc;
  const rpc = await connectJsonRpc({
    url: options.url,
    clientVersion: options.clientVersion,
  });

  try {
    const started = await rpc.sendRequest("thread/start", { cwd: options.workspacePath });
    const threadId = (started.result as { thread?: { id?: string } } | undefined)?.thread?.id;
    if (!threadId) {
      throw new Error("Desktop smoke thread/start did not return a thread id");
    }

    await rpc.waitFor(
      (message) =>
        message.method === "thread/started" &&
        (message.params as { thread?: { id?: string } } | undefined)?.thread?.id === threadId,
      { label: `thread/started for ${threadId}` },
    );

    await rpc.sendRequest("cowork/session/config/set", {
      threadId,
      config: {
        userName: `Desktop Smoke ${(options.now ?? Date.now)()}`,
      },
    });

    const turnStartedResponse = await rpc.sendRequest("turn/start", {
      threadId,
      input: "Desktop smoke packaged turn check",
    });
    const turnId = (turnStartedResponse.result as { turn?: { id?: string } } | undefined)?.turn?.id;
    if (!turnId) {
      throw new Error("Desktop smoke turn/start did not return a turn id");
    }

    const completed = await rpc.waitFor(
      (message) =>
        message.method === "turn/completed" &&
        (message.params as { turn?: { id?: string } } | undefined)?.turn?.id === turnId,
      { timeoutMs: TURN_COMPLETION_TIMEOUT_MS, label: `turn/completed for ${turnId}` },
    );
    const status = (completed.params as { turn?: { status?: string } } | undefined)?.turn?.status;
    if (typeof status !== "string" || !TERMINAL_TURN_STATUSES.has(status)) {
      throw new Error(
        `Desktop smoke turn/completed reported an invalid status: ${status ?? "unknown"}`,
      );
    }
  } finally {
    rpc.close();
  }
}
