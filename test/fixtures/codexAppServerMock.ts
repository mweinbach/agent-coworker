import fs from "node:fs/promises";
import path from "node:path";

import type {
  CodexAppServerClient,
  CodexAppServerJsonRpcNotification,
  CodexAppServerJsonRpcRawMessage,
} from "../../src/providers/codexAppServerClient";

export const mockInterrupts: Array<{ threadId: string; turnId?: string }> = [];

export async function writeMockAppServer(dir: string): Promise<string> {
  const script = path.join(dir, "mock-codex-app-server.js");
  await fs.writeFile(
    script,
    `
const readline = require("node:readline");
const fs = require("node:fs");
const rl = readline.createInterface({ input: process.stdin });
process.stdin.resume();
setInterval(() => {}, 1000);
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function capture(msg) {
  if (!process.env.CODEX_APP_SERVER_CAPTURE_PATH) return;
  if (msg.method === "initialize" || msg.method === "thread/start" || msg.method === "thread/resume" || msg.method === "turn/start" || msg.method === "turn/steer") {
    fs.appendFileSync(process.env.CODEX_APP_SERVER_CAPTURE_PATH, JSON.stringify({ method: msg.method, params: msg.params }) + "\\n");
  }
}
function completeTurn(extraItems = []) {
  send({ method: "item/started", params: { threadId: "thread_1", turnId: "turn_1", item: { type: "agentMessage", id: "item_1", text: "", phase: null, memoryCitation: null } } });
  send({ method: "item/agentMessage/delta", params: { threadId: "thread_1", turnId: "turn_1", itemId: "item_1", delta: "hello from app-server" } });
  send({ method: "item/completed", params: { threadId: "thread_1", turnId: "turn_1", item: { type: "agentMessage", id: "item_1", text: "hello from app-server", phase: null, memoryCitation: null } } });
  send({ method: "thread/tokenUsage/updated", params: { threadId: "thread_1", turnId: "turn_1", tokenUsage: { total: { totalTokens: 7, inputTokens: 3, cachedInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 2 }, last: { totalTokens: 7, inputTokens: 3, cachedInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 2 }, modelContextWindow: 272000 } } });
  send({ method: "turn/completed", params: { turn: { id: "turn_1", status: "completed", items: [...extraItems, { type: "agentMessage", id: "item_1", text: "hello from app-server", phase: null, memoryCitation: null }], error: null } } });
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  capture(msg);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { userAgent: "mock" } });
    return;
  }
  if (msg.method === "initialized") return;
  if (msg.method === "model/list") {
    send({ id: msg.id, result: { data: [{ id: "gpt-5.4", model: "gpt-5.4", displayName: "GPT-5.4", isDefault: true }], nextCursor: null } });
    return;
  }
  if (msg.method === "thread/start") {
    send({ id: msg.id, result: { thread: { id: "thread_1", modelProvider: "openai", turns: [] }, model: "gpt-5.4", modelProvider: "openai", cwd: process.cwd(), approvalPolicy: msg.params.approvalPolicy, sandbox: msg.params.sandbox, reasoningEffort: "high" } });
    return;
  }
  if (msg.method === "thread/resume") {
    send({ id: msg.id, result: { thread: { id: msg.params.threadId, modelProvider: "openai", turns: [] }, model: "gpt-5.4", modelProvider: "openai", cwd: process.cwd(), approvalPolicy: msg.params.approvalPolicy, sandbox: msg.params.sandbox, reasoningEffort: "high" } });
    return;
  }
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn_1", status: "inProgress", items: [], error: null } } });
    if (process.env.CODEX_APP_SERVER_DELAY_COMPLETION !== "1") completeTurn();
    return;
  }
  if (msg.method === "turn/steer") {
    send({ id: msg.id, result: { turnId: msg.params.expectedTurnId } });
    completeTurn([{ type: "userMessage", id: "steer_user_1", content: msg.params.input }]);
  }
});
`,
    "utf-8",
  );
  return script;
}

export function createMockClient(): CodexAppServerClient {
  const notificationListeners = new Set<
    (notification: CodexAppServerJsonRpcNotification) => void
  >();
  const rawListeners = new Set<(message: CodexAppServerJsonRpcRawMessage) => void>();
  const serverRequestHandlers = new Set<
    (request: { id: number; method: string; params?: unknown }) => unknown
  >();
  let closed = false;
  let nextTurnId = 1;

  const emitRaw = (message: CodexAppServerJsonRpcRawMessage) => {
    for (const listener of rawListeners) listener(message);
  };
  const sendNotification = (notification: CodexAppServerJsonRpcNotification) => {
    emitRaw({ direction: "server_notification", message: notification as Record<string, unknown> });
    for (const listener of notificationListeners) listener(notification);
  };
  const sendServerRequest = async (method: string, params?: unknown): Promise<unknown> => {
    const id = nextTurnId++;
    const request = { id, method, ...(params !== undefined ? { params } : {}) };
    emitRaw({ direction: "server_request", message: request });
    const handler = [...serverRequestHandlers].at(-1);
    const result = handler ? await handler(request) : {};
    emitRaw({ direction: "client_response", message: { id, result } });
    return result;
  };
  const capture = async (method: string, params: unknown) => {
    if (!process.env.CODEX_APP_SERVER_CAPTURE_PATH) return;
    if (
      method === "initialize" ||
      method === "thread/start" ||
      method === "thread/resume" ||
      method === "turn/start" ||
      method === "turn/steer"
    ) {
      await fs.appendFile(
        process.env.CODEX_APP_SERVER_CAPTURE_PATH,
        `${JSON.stringify({ method, params })}\n`,
        "utf-8",
      );
    }
  };
  const completeTurn = (
    threadId: string,
    turnId: string,
    text: string,
    extraItems: unknown[] = [],
    options: { emitUsage?: boolean } = {},
  ) => {
    sendNotification({
      method: "item/started",
      params: {
        threadId,
        turnId,
        item: { type: "agentMessage", id: "item_1", text: "", phase: null, memoryCitation: null },
      },
    });
    sendNotification({
      method: "item/agentMessage/delta",
      params: { threadId, turnId, itemId: "item_1", delta: text },
    });
    sendNotification({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { type: "agentMessage", id: "item_1", text, phase: null, memoryCitation: null },
      },
    });
    if (options.emitUsage !== false) {
      const tokenUsage = process.env.COWORK_CODEX_APP_SERVER_ARGS?.includes("openai-usage-details")
        ? {
            total: {
              total_tokens: 33,
              input_tokens: 20,
              input_tokens_details: { cached_tokens: 6, cache_creation_tokens: 4 },
              output_tokens: 13,
              output_tokens_details: { reasoning_tokens: 5 },
            },
            last: {
              total_tokens: 33,
              input_tokens: 20,
              input_tokens_details: { cached_tokens: 6, cache_creation_tokens: 4 },
              output_tokens: 13,
              output_tokens_details: { reasoning_tokens: 5 },
            },
            modelContextWindow: 272000,
          }
        : {
            total: {
              totalTokens: 7,
              inputTokens: 3,
              cachedInputTokens: 0,
              outputTokens: 4,
              reasoningOutputTokens: 2,
            },
            last: {
              totalTokens: 7,
              inputTokens: 3,
              cachedInputTokens: 0,
              outputTokens: 4,
              reasoningOutputTokens: 2,
            },
            modelContextWindow: 272000,
          };
      sendNotification({
        method: "thread/tokenUsage/updated",
        params: {
          threadId,
          turnId,
          tokenUsage,
        },
      });
    }
    sendNotification({
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: turnId,
          threadId,
          status: "completed",
          items: [
            ...extraItems,
            { type: "agentMessage", id: "item_1", text, phase: null, memoryCitation: null },
          ],
          error: null,
        },
      },
    });
  };

  const request = async (method: string, params?: unknown): Promise<unknown> => {
    const requestId = nextTurnId;
    emitRaw({
      direction: "client_request",
      message: { id: requestId, method, ...(params !== undefined ? { params } : {}) },
    });
    await capture(method, params);
    let result: unknown = {};
    if (method === "initialize") {
      result = { userAgent: "mock" };
    } else if (method === "model/list") {
      if (process.env.COWORK_CODEX_APP_SERVER_ARGS?.includes("model-gated")) {
        result = {
          data: [
            {
              id: "gpt-5.3-codex-spark",
              model: "gpt-5.3-codex-spark",
              displayName: "Spark",
              isDefault: true,
            },
          ],
          nextCursor: null,
        };
      } else {
        result = {
          data: [{ id: "gpt-5.4", model: "gpt-5.4", displayName: "GPT-5.4", isDefault: true }],
          nextCursor: null,
        };
      }
    } else if (method === "thread/start") {
      const record = params as { model?: string; approvalPolicy?: string; sandbox?: string };
      if (
        process.env.COWORK_CODEX_APP_SERVER_ARGS?.includes("model-gated") &&
        record.model !== "gpt-5.3-codex-spark"
      ) {
        throw new Error(
          `The '${record.model}' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.`,
        );
      }
      result = {
        thread: { id: "thread_1", modelProvider: "openai", turns: [] },
        model: record.model ?? "gpt-5.4",
        modelProvider: "openai",
        cwd: process.cwd(),
        approvalPolicy: record.approvalPolicy,
        sandbox: record.sandbox,
        reasoningEffort: "high",
      };
    } else if (method === "thread/resume") {
      const record = params as {
        threadId?: string;
        model?: string;
        approvalPolicy?: string;
        sandbox?: string;
      };
      if (process.env.COWORK_CODEX_APP_SERVER_ARGS?.includes("stale-resume")) {
        throw new Error(`thread ${record.threadId ?? "unknown"} not found`);
      }
      result = {
        thread: { id: record.threadId ?? "thread_1", modelProvider: "openai", turns: [] },
        model: record.model ?? "gpt-5.4",
        modelProvider: "openai",
        cwd: process.cwd(),
        approvalPolicy: record.approvalPolicy,
        sandbox: record.sandbox,
        reasoningEffort: "high",
      };
    } else if (method === "turn/start") {
      const record = params as { threadId?: string };
      const threadId = record.threadId ?? "thread_1";
      const turnId = `turn_${nextTurnId++}`;
      if (process.env.COWORK_CODEX_APP_SERVER_ARGS?.includes("early-token-usage-wrong")) {
        sendNotification({
          method: "thread/tokenUsage/updated",
          params: {
            threadId,
            turnId: "turn_from_another_request",
            tokenUsage: {
              total: {
                totalTokens: 999,
                inputTokens: 400,
                cachedInputTokens: 0,
                outputTokens: 599,
                reasoningOutputTokens: 11,
              },
              last: {
                totalTokens: 999,
                inputTokens: 400,
                cachedInputTokens: 0,
                outputTokens: 599,
                reasoningOutputTokens: 11,
              },
            },
          },
        });
      }
      if (process.env.COWORK_CODEX_APP_SERVER_ARGS?.includes("early-token-usage-matching")) {
        sendNotification({
          method: "thread/tokenUsage/updated",
          params: {
            threadId,
            turnId,
            tokenUsage: {
              total: {
                totalTokens: 24,
                inputTokens: 11,
                cachedInputTokens: 1,
                cacheWriteInputTokens: 2,
                outputTokens: 13,
                reasoningOutputTokens: 5,
              },
              last: {
                totalTokens: 24,
                inputTokens: 11,
                cachedInputTokens: 1,
                cacheWriteInputTokens: 2,
                outputTokens: 13,
                reasoningOutputTokens: 5,
              },
            },
          },
        });
      }
      if (process.env.COWORK_CODEX_APP_SERVER_ARGS?.includes("cumulative-token-usage")) {
        sendNotification({
          method: "thread/tokenUsage/updated",
          params: {
            threadId,
            turnId,
            tokenUsage: {
              total: {
                totalTokens: 3476387,
                inputTokens: 3455915,
                cachedInputTokens: 2987776,
                outputTokens: 20472,
                reasoningOutputTokens: 5929,
              },
              last: {
                totalTokens: 182780,
                inputTokens: 182693,
                cachedInputTokens: 173952,
                outputTokens: 87,
                reasoningOutputTokens: 0,
              },
            },
          },
        });
      }
      if (process.env.COWORK_CODEX_APP_SERVER_ARGS?.includes("cross-thread-title-leak")) {
        sendNotification({
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread_title",
            turnId: "turn_title",
            itemId: "item_title",
            delta: "Leaked Generated Title",
          },
        });
        sendNotification({
          method: "turn/completed",
          params: {
            threadId: "thread_title",
            turn: {
              id: "turn_title",
              threadId: "thread_title",
              status: "completed",
              items: [{ type: "agentMessage", id: "item_title", text: "Leaked Generated Title" }],
              error: null,
            },
          },
        });
      }
      result = { turn: { id: turnId, status: "inProgress", items: [], error: null } };
      if (process.env.CODEX_APP_SERVER_DELAY_COMPLETION !== "1") {
        queueMicrotask(async () => {
          if (process.env.COWORK_CODEX_APP_SERVER_ARGS?.includes("dynamic-tool-call")) {
            await sendServerRequest("item/tool/call", {
              threadId: "thread_1",
              turnId,
              callId: "call_structured",
              tool: "structuredTool",
              arguments: { value: "ok" },
            });
            await sendServerRequest("item/tool/call", {
              threadId: "thread_1",
              turnId,
              callId: "call_mcp",
              tool: "cowork_mcp__srv__custom",
              arguments: { query: "ok" },
            });
            await sendServerRequest("item/tool/call", {
              threadId: "thread_1",
              turnId,
              callId: "call_unknown",
              tool: "unknownTool",
              arguments: {},
            });
            await sendServerRequest("item/tool/call", {
              threadId: "thread_1",
              turnId,
              callId: "call_invalid",
              tool: "validatedTool",
              arguments: { count: "bad" },
            });
            await sendServerRequest("item/tool/call", {
              threadId: "thread_1",
              turnId,
              callId: "call_throws",
              tool: "throwsTool",
              arguments: {},
            });
          }
          if (process.env.COWORK_CODEX_APP_SERVER_ARGS?.includes("eventful")) {
            await sendServerRequest("requestUserInput", {
              question: "Need detail?",
              options: ["yes"],
            });
            sendNotification({
              method: "todoList/updated",
              params: { todos: [{ content: "Wire app-server todos", status: "completed" }] },
            });
            sendNotification({
              method: "item/started",
              params: {
                threadId: "thread_1",
                turnId,
                item: {
                  type: "fileChange",
                  id: "file_change_1",
                  cwd: "/workspace",
                  paths: ["src/example.ts"],
                  summary: "Edited src/example.ts",
                },
              },
            });
            sendNotification({
              method: "item/fileChange/delta",
              params: {
                threadId: "thread_1",
                turnId,
                itemId: "file_change_1",
                diff: "--- a/src/example.ts\n+++ b/src/example.ts\n",
              },
            });
            sendNotification({
              method: "item/fileChange/patchUpdated",
              params: {
                threadId: "thread_1",
                turnId,
                itemId: "file_change_1",
                patch: "@@ -1 +1 @@\n-old\n+new\n",
              },
            });
            sendNotification({
              method: "item/completed",
              params: {
                threadId: "thread_1",
                turnId,
                item: {
                  type: "fileChange",
                  id: "file_change_1",
                  cwd: "/workspace",
                  paths: ["src/example.ts"],
                  changes: [{ path: "src/example.ts", kind: "modified" }],
                },
              },
            });
          }
          completeTurn(
            threadId,
            turnId,
            process.env.COWORK_CODEX_APP_SERVER_ARGS?.includes("model-gated")
              ? "fallback ok"
              : "hello from app-server",
            [],
            {
              emitUsage: !(
                process.env.COWORK_CODEX_APP_SERVER_ARGS?.includes("early-token-usage-wrong") ||
                process.env.COWORK_CODEX_APP_SERVER_ARGS?.includes("early-token-usage-matching") ||
                process.env.COWORK_CODEX_APP_SERVER_ARGS?.includes("cumulative-token-usage")
              ),
            },
          );
        });
      }
    } else if (method === "turn/steer") {
      const record = params as { expectedTurnId?: string; input?: unknown };
      result = { turnId: record.expectedTurnId };
      queueMicrotask(() => {
        completeTurn("thread_1", record.expectedTurnId ?? "turn_1", "hello from app-server", [
          { type: "userMessage", id: "steer_user_1", content: record.input },
        ]);
      });
    }
    emitRaw({ direction: "server_response", message: { id: requestId, result } });
    return result;
  };

  return {
    command: { command: "mock-codex-app-server", args: [], source: "override" },
    isClosed: () => closed,
    request,
    notify: (method, params) => {
      emitRaw({
        direction: "client_notification",
        message: { method, ...(params !== undefined ? { params } : {}) },
      });
    },
    interruptTurn: async (params) => {
      mockInterrupts.push(params);
    },
    onNotification: (listener) => {
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
    onServerRequest: (handler) => {
      serverRequestHandlers.add(handler);
      return () => {
        serverRequestHandlers.delete(handler);
      };
    },
    onJsonRpcMessage: (listener) => {
      rawListeners.add(listener);
      return () => rawListeners.delete(listener);
    },
    close: async () => {
      closed = true;
    },
  };
}
