import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { StartAgentServerOptions } from "../../src/server/startServer";

export async function makeTmpProject(prefix = "agent-harness-ws-"): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(tmp, ".agent"), { recursive: true });
  return tmp;
}

export function serverOpts(
  tmpDir: string,
  overrides?: Partial<StartAgentServerOptions>,
): StartAgentServerOptions {
  const baseEnv = {
    AGENT_WORKING_DIR: tmpDir,
    AGENT_PROVIDER: "google",
    AGENT_OBSERVABILITY_ENABLED: "false",
    COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1",
  };

  return {
    cwd: tmpDir,
    hostname: "127.0.0.1",
    port: 0,
    homedir: tmpDir,
    ...overrides,
    env: {
      ...baseEnv,
      ...(overrides?.env ?? {}),
    },
  };
}

export async function stopTestServer(
  server: { stop: (closeActiveConnections?: boolean) => Promise<void> | void },
): Promise<void> {
  await server.stop(true);
}

type JsonRpcConnection = {
  sendRequest: (method: string, params?: unknown) => Promise<any>;
  sendResponse: (id: string | number, result: unknown) => void;
  close: () => void;
};

async function connectJsonRpc(
  url: string,
  onMessage: (message: any) => void,
): Promise<JsonRpcConnection> {
  const ws = new WebSocket(`${url}?protocol=jsonrpc`);
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let nextId = 0;

  ws.onmessage = (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : "");
    if (typeof message.id === "number" && pending.has(message.id)) {
      const waiter = pending.get(message.id)!;
      pending.delete(message.id);
      waiter.resolve(message);
      return;
    }
    onMessage(message);
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for websocket open")), 5_000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${event}`));
    };
  });

  const sendRequest = async (method: string, params?: unknown) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }));
    return await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  };

  const initializeResponse = await sendRequest("initialize", {
    clientInfo: {
      name: "legacy-ws-harness",
      version: "1.0.0",
    },
  });
  if (initializeResponse.error) {
    throw new Error(initializeResponse.error.message ?? "Failed to initialize JSON-RPC test connection");
  }
  ws.send(JSON.stringify({ method: "initialized" }));

  return {
    sendRequest,
    sendResponse: (id, result) => {
      ws.send(JSON.stringify({ id, result }));
    },
    close: () => ws.close(),
  };
}

export function withSession<T>(
  url: string,
  handler: (args: {
    ws: WebSocket;
    sessionId: string;
    message: any;
    resolve: (value: T) => void;
    reject: (error: Error) => void;
  }) => void,
  options?: {
    resumeSessionId?: string;
    timeoutMs?: number;
  },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const settled = { value: false };
    let activeSessionId = options?.resumeSessionId ?? "";
    let rpc: JsonRpcConnection | null = null;

    const timeout = setTimeout(() => {
      if (settled.value) return;
      settled.value = true;
      rpc?.close();
      reject(new Error("Timed out waiting for websocket flow"));
    }, options?.timeoutMs ?? 10_000);

    const finishResolve = (value: T) => {
      if (settled.value) return;
      settled.value = true;
      clearTimeout(timeout);
      rpc?.close();
      resolve(value);
    };
    const finishReject = (error: Error) => {
      if (settled.value) return;
      settled.value = true;
      clearTimeout(timeout);
      rpc?.close();
      reject(error);
    };

    const legacyWs = {
      send(raw: string) {
        let message: any;
        try {
          message = JSON.parse(raw);
        } catch (error) {
          finishReject(error instanceof Error ? error : new Error(String(error)));
          return;
        }

        const threadId = typeof message.sessionId === "string" && message.sessionId.trim()
          ? message.sessionId.trim()
          : activeSessionId;

        const run = async () => {
          switch (message.type) {
            case "harness_context_get": {
              const response = await rpc?.sendRequest("cowork/session/harnessContext/get", { threadId });
              if (response?.result?.event) {
                dispatch({
                  ...response.result.event,
                  sessionId: response.result.event.sessionId ?? activeSessionId,
                });
              }
              return;
            }
            case "harness_context_set":
              {
                const response = await rpc?.sendRequest("cowork/session/harnessContext/set", {
                  threadId,
                  context: message.context,
                });
                if (response?.result?.event) {
                  dispatch({
                    ...response.result.event,
                    sessionId: response.result.event.sessionId ?? activeSessionId,
                  });
                }
              }
              return;
            case "user_message":
              await rpc?.sendRequest("turn/start", {
                threadId,
                clientMessageId: "legacy-harness-msg",
                input: [{ type: "text", text: String(message.text ?? "") }],
              });
              return;
            case "ask_response":
              rpc?.sendResponse(message.requestId, { answer: message.answer });
              return;
            case "approval_response":
              rpc?.sendResponse(message.requestId, { decision: message.approved ? "accept" : "decline" });
              return;
            case "agent_spawn":
              await rpc?.sendRequest("cowork/session/agent/spawn", {
                threadId,
                message: message.message,
                ...(message.role ? { role: message.role } : {}),
                ...(message.model ? { model: message.model } : {}),
                ...(message.reasoningEffort ? { reasoningEffort: message.reasoningEffort } : {}),
                ...(message.contextMode !== undefined ? { contextMode: message.contextMode } : {}),
                ...(message.briefing !== undefined ? { briefing: message.briefing } : {}),
                ...(message.includeParentTodos !== undefined ? { includeParentTodos: message.includeParentTodos } : {}),
                ...(message.includeHarnessContext !== undefined ? { includeHarnessContext: message.includeHarnessContext } : {}),
                ...(message.forkContext !== undefined ? { forkContext: message.forkContext } : {}),
              });
              return;
            case "agent_list_get":
              await rpc?.sendRequest("cowork/session/agent/list", { threadId });
              return;
            case "agent_input_send":
              await rpc?.sendRequest("cowork/session/agent/input/send", {
                threadId,
                agentId: message.agentId,
                message: message.message,
                ...(message.interrupt !== undefined ? { interrupt: message.interrupt } : {}),
              });
              return;
            case "agent_wait":
              await rpc?.sendRequest("cowork/session/agent/wait", {
                threadId,
                agentIds: message.agentIds,
                ...(message.timeoutMs !== undefined ? { timeoutMs: message.timeoutMs } : {}),
              });
              return;
            case "agent_resume":
              await rpc?.sendRequest("cowork/session/agent/resume", { threadId, agentId: message.agentId });
              return;
            case "agent_close":
              await rpc?.sendRequest("cowork/session/agent/close", { threadId, agentId: message.agentId });
              return;
            default:
              finishReject(new Error(`Unsupported legacy test message: ${String(message.type)}`));
          }
        };

        void run().catch((error) => {
          finishReject(error instanceof Error ? error : new Error(String(error)));
        });
      },
      close() {
        rpc?.close();
      },
    } as unknown as WebSocket;

    const dispatch = (message: any) => {
      if (settled.value || !activeSessionId) return;
      handler({
        ws: legacyWs,
        sessionId: activeSessionId,
        message,
        resolve: finishResolve,
        reject: finishReject,
      });
    };

    const translateIncomingMessage = (message: any) => {
      if (settled.value) return;

      if (message.method === "item/tool/requestUserInput") {
        dispatch({
          type: "ask",
          sessionId: activeSessionId,
          requestId: String(message.id),
          question: message.params?.question ?? "",
          options: Array.isArray(message.params?.options) ? message.params.options : undefined,
        });
        return;
      }

      if (message.method === "item/commandExecution/requestApproval") {
        dispatch({
          type: "approval",
          sessionId: activeSessionId,
          requestId: String(message.id),
          command: message.params?.command ?? "",
          dangerous: message.params?.dangerous === true,
          reasonCode: message.params?.reason ?? "requires_manual_review",
        });
        return;
      }

      if (message.method === "item/completed" && message.params?.item?.type === "agentMessage") {
        dispatch({
          type: "assistant_message",
          sessionId: activeSessionId,
          text: message.params.item.text ?? "",
        });
        return;
      }

      if (message.method === "cowork/session/harnessContext") {
        dispatch({
          ...(message.params ?? {}),
          type: "harness_context",
          sessionId: message.params?.sessionId ?? activeSessionId,
        });
        return;
      }

      if (message.method === "cowork/session/agentSpawned") {
        dispatch({
          ...(message.params ?? {}),
          type: "agent_spawned",
          sessionId: message.params?.sessionId ?? activeSessionId,
        });
        return;
      }

      if (message.method === "cowork/session/agentList") {
        dispatch({
          ...(message.params ?? {}),
          type: "agent_list",
          sessionId: message.params?.sessionId ?? activeSessionId,
        });
        return;
      }

      if (message.method === "cowork/session/agentStatus") {
        dispatch({
          ...(message.params ?? {}),
          type: "agent_status",
          sessionId: message.params?.sessionId ?? activeSessionId,
        });
        return;
      }

      if (message.method === "cowork/session/agentWaitResult") {
        dispatch({
          ...(message.params ?? {}),
          type: "agent_wait_result",
          sessionId: message.params?.sessionId ?? activeSessionId,
        });
        return;
      }

      if (message.method === "error") {
        finishReject(new Error(message.params?.message ?? "JSON-RPC test session error"));
      }
    };

    void (async () => {
      rpc = await connectJsonRpc(url, translateIncomingMessage);
      const response = options?.resumeSessionId
        ? await rpc.sendRequest("thread/resume", { threadId: options.resumeSessionId })
        : await rpc.sendRequest("thread/start");

      if (response.error) {
        throw new Error(response.error.message ?? "Failed to start JSON-RPC test thread");
      }

      activeSessionId = response.result.thread.id;
      dispatch({
        type: "server_hello",
        sessionId: activeSessionId,
        ...(options?.resumeSessionId ? { isResume: true } : {}),
      });
    })().catch((error) => {
      finishReject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
