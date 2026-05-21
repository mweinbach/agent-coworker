import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import {
  type CodexAppServerClient,
  type CodexAppServerJsonRpcNotification,
  type CodexAppServerJsonRpcRawMessage,
  closePooledCodexAppServerClients,
  __internal as codexAppServerClientInternal,
} from "../src/providers/codexAppServerClient";
import { createRuntime } from "../src/runtime";
import type { AgentConfig } from "../src/types";
import { VERSION } from "../src/version";

const previousCommand = process.env.COWORK_CODEX_APP_SERVER_COMMAND;
const previousArgs = process.env.COWORK_CODEX_APP_SERVER_ARGS;
const previousCapturePath = process.env.CODEX_APP_SERVER_CAPTURE_PATH;
const previousDelayCompletion = process.env.CODEX_APP_SERVER_DELAY_COMPLETION;
const testNodeCommand = process.env.COWORK_TEST_NODE_COMMAND ?? "node";
const mockInterrupts: Array<{ threadId: string; turnId?: string }> = [];

function expectedManagedSofficeShimPath(shimDir: string): string {
  return path.join(shimDir, process.platform === "win32" ? "soffice.cmd" : "soffice");
}

function makeConfig(dir: string): AgentConfig {
  return {
    provider: "codex-cli",
    runtime: "codex-app-server",
    model: "gpt-5.4",
    preferredChildModel: "gpt-5.4",
    workingDirectory: dir,
    outputDirectory: path.join(dir, "output"),
    uploadsDirectory: path.join(dir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(dir, ".cowork"),
    userCoworkDir: path.join(dir, ".cowork-user"),
    builtInDir: dir,
    builtInConfigDir: path.join(dir, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
  };
}

async function writeMockAppServer(dir: string): Promise<string> {
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

async function readCapturedRequests(
  capturePath: string,
): Promise<Array<{ method: string; params: Record<string, unknown> }>> {
  const raw = await fs.readFile(capturePath, "utf-8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function installMockClientFactory(): void {
  codexAppServerClientInternal.setClientFactoryForTests(async () => createMockClient());
}

function createMockClient(): CodexAppServerClient {
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

beforeEach(() => {
  mockInterrupts.length = 0;
  installMockClientFactory();
});

afterEach(async () => {
  await closePooledCodexAppServerClients();
  codexAppServerClientInternal.setClientFactoryForTests(undefined);
  if (previousCommand === undefined) delete process.env.COWORK_CODEX_APP_SERVER_COMMAND;
  else process.env.COWORK_CODEX_APP_SERVER_COMMAND = previousCommand;
  if (previousArgs === undefined) delete process.env.COWORK_CODEX_APP_SERVER_ARGS;
  else process.env.COWORK_CODEX_APP_SERVER_ARGS = previousArgs;
  if (previousCapturePath === undefined) delete process.env.CODEX_APP_SERVER_CAPTURE_PATH;
  else process.env.CODEX_APP_SERVER_CAPTURE_PATH = previousCapturePath;
  if (previousDelayCompletion === undefined) delete process.env.CODEX_APP_SERVER_DELAY_COMPLETION;
  else process.env.CODEX_APP_SERVER_DELAY_COMPLETION = previousDelayCompletion;
});

describe("codex app-server runtime", () => {
  test.serial("passes the prepared tool env into pooled app-server clients", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-env-"));
    let receivedOpts:
      | Parameters<
          NonNullable<Parameters<typeof codexAppServerClientInternal.setClientFactoryForTests>[0]>
        >[0]
      | null = null;
    codexAppServerClientInternal.setClientFactoryForTests(async (opts) => {
      receivedOpts = opts;
      return createMockClient();
    });

    const runtime = createRuntime(makeConfig(dir));
    await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
      toolEnv: {
        PATH: "/tmp/cowork-managed-bin",
        COWORK_SOFFICE: "/tmp/cowork-managed-bin/soffice",
      },
    });

    expect(receivedOpts?.env).toMatchObject({
      PATH: "/tmp/cowork-managed-bin",
      COWORK_SOFFICE: "/tmp/cowork-managed-bin/soffice",
    });
  });

  test.serial("prepares managed soffice env and instructions for app-server turns", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-soffice-"));
    const home = path.join(dir, "home");
    const capturePath = path.join(dir, "requests.jsonl");
    await fs.mkdir(home, { recursive: true });
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

    let receivedOpts:
      | Parameters<
          NonNullable<Parameters<typeof codexAppServerClientInternal.setClientFactoryForTests>[0]>
        >[0]
      | null = null;
    codexAppServerClientInternal.setClientFactoryForTests(async (opts) => {
      receivedOpts = opts;
      return createMockClient();
    });

    try {
      const runtime = createRuntime(makeConfig(dir));
      await runtime.runTurn({
        config: makeConfig(dir),
        system: "You are Codex.",
        messages: [{ role: "user", content: "Say hi" }],
        tools: {},
        maxSteps: 1,
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }

    const shimDir = path.join(home, ".cache", "cowork", "libreoffice", "bin");
    const shimPath = expectedManagedSofficeShimPath(shimDir);
    expect(receivedOpts?.env?.COWORK_SOFFICE).toBe(shimPath);
    expect(receivedOpts?.env?.COWORK_MANAGED_SOFFICE_SHIM_DIR).toBe(shimDir);
    const pathEnvKey = Object.keys(receivedOpts?.env ?? {}).find(
      (key) => key.toLowerCase() === "path",
    );
    expect(pathEnvKey ? receivedOpts?.env?.[pathEnvKey]?.split(path.delimiter)[0] : undefined).toBe(
      shimDir,
    );

    const requests = await readCapturedRequests(capturePath);
    const startParams = requests.find((entry) => entry.method === "thread/start")?.params;
    expect(startParams?.baseInstructions).toContain("Managed LibreOffice Runtime");
    expect(startParams?.baseInstructions).toContain(shimPath);
    if (process.platform === "win32") {
      expect(startParams?.baseInstructions).toContain(`$env:PATH = '${shimDir};' + $env:PATH`);
    } else {
      expect(startParams?.baseInstructions).toContain(`PATH=${shimDir}:$PATH`);
    }
  });

  test.serial("initializes app-server with the Cowork package version", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-init-"));
    const script = await writeMockAppServer(dir);
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = testNodeCommand;
    process.env.COWORK_CODEX_APP_SERVER_ARGS = script;
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

    const runtime = createRuntime(makeConfig(dir));
    await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
    });

    const requests = await readCapturedRequests(capturePath);
    expect(requests.find((entry) => entry.method === "initialize")?.params).toEqual({
      clientInfo: {
        name: "agent-coworker",
        title: "Agent Coworker",
        version: VERSION,
      },
      capabilities: { experimentalApi: true },
    });
  });

  test.serial("drives a turn through codex app-server JSONL", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-runtime-"));
    const script = await writeMockAppServer(dir);
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = testNodeCommand;
    process.env.COWORK_CODEX_APP_SERVER_ARGS = script;

    const streamParts: unknown[] = [];
    const rawEvents: unknown[] = [];
    const timeline: Array<{ type: "raw" | "part"; value: unknown }> = [];
    const runtime = createRuntime(makeConfig(dir));
    const result = await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
      onModelStreamPart: (part) => {
        streamParts.push(part);
        timeline.push({ type: "part", value: part });
      },
      onModelRawEvent: (event) => {
        rawEvents.push(event);
        timeline.push({ type: "raw", value: event });
      },
    });

    expect(result.text).toBe("hello from app-server");
    expect(result.usage).toEqual({
      promptTokens: 3,
      completionTokens: 4,
      totalTokens: 7,
      cachedPromptTokens: 0,
      reasoningOutputTokens: 2,
    });
    expect(result.providerState).toMatchObject({
      provider: "codex-cli",
      model: "gpt-5.4",
      threadId: "thread_1",
    });
    expect(streamParts.some((part) => (part as { type?: string }).type === "text-delta")).toBe(
      true,
    );
    expect(rawEvents).toContainEqual(
      expect.objectContaining({
        format: "codex-app-server-v2",
      }),
    );
    expect(rawEvents).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          direction: "client_request",
          message: expect.objectContaining({
            method: "turn/start",
            params: expect.objectContaining({
              threadId: "thread_1",
              input: [{ type: "text", text: "User: Say hi", text_elements: [] }],
            }),
          }),
        }),
      }),
    );
    expect(rawEvents).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          direction: "server_response",
          message: expect.objectContaining({
            result: expect.objectContaining({
              turn: expect.objectContaining({ id: "turn_1" }),
            }),
          }),
        }),
      }),
    );
    const rawDeltaIndex = timeline.findIndex(({ type, value }) => {
      const raw = value as {
        event?: { direction?: string; message?: { method?: string; params?: { delta?: string } } };
      };
      return (
        type === "raw" &&
        raw.event?.direction === "server_notification" &&
        raw.event.message?.method === "item/agentMessage/delta" &&
        raw.event.message.params?.delta === "hello from app-server"
      );
    });
    const textDeltaIndex = timeline.findIndex(
      ({ type, value }) => type === "part" && (value as { type?: string }).type === "text-delta",
    );
    expect(rawDeltaIndex).toBeGreaterThanOrEqual(0);
    expect(textDeltaIndex).toBeGreaterThanOrEqual(0);
    expect(rawDeltaIndex).toBeLessThanOrEqual(textDeltaIndex);
  });

  test.serial("ignores pooled app-server title-generation events from other threads", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-title-leak-"));
    process.env.COWORK_CODEX_APP_SERVER_ARGS = "cross-thread-title-leak";

    const streamParts: unknown[] = [];
    const rawEvents: unknown[] = [];
    const runtime = createRuntime(makeConfig(dir));
    const result = await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
      onModelStreamPart: (part) => {
        streamParts.push(part);
      },
      onModelRawEvent: (event) => {
        rawEvents.push(event);
      },
    });

    expect(result.text).toBe("hello from app-server");
    expect(JSON.stringify(streamParts)).not.toContain("Leaked Generated Title");
    expect(JSON.stringify(rawEvents)).not.toContain("Leaked Generated Title");
  });

  test.serial(
    "forwards Codex verbosity and rich web search config to app-server threads",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-config-"));
      const script = await writeMockAppServer(dir);
      const capturePath = path.join(dir, "requests.jsonl");
      process.env.COWORK_CODEX_APP_SERVER_COMMAND = testNodeCommand;
      process.env.COWORK_CODEX_APP_SERVER_ARGS = script;
      process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

      const config = {
        ...makeConfig(dir),
        providerOptions: {
          "codex-cli": {
            textVerbosity: "high",
            webSearchMode: "live",
            webSearch: {
              contextSize: "high",
              allowedDomains: ["openai.com", "platform.openai.com"],
              location: {
                country: "US",
                region: "CA",
                city: "San Francisco",
                timezone: "America/Los_Angeles",
              },
            },
          },
        },
      };
      const runtime = createRuntime(config);
      await runtime.runTurn({
        config,
        providerOptions: config.providerOptions,
        system: "You are Codex.",
        messages: [{ role: "user", content: "Say hi" }],
        tools: {},
        maxSteps: 1,
      });

      const requests = await readCapturedRequests(capturePath);
      expect(requests.find((entry) => entry.method === "thread/start")?.params.config).toEqual({
        web_search: "live",
        model_verbosity: "high",
        tools: {
          web_search: {
            context_size: "high",
            allowed_domains: ["openai.com", "platform.openai.com"],
            location: {
              country: "US",
              region: "CA",
              city: "San Francisco",
              timezone: "America/Los_Angeles",
            },
          },
        },
      });
    },
  );

  test.serial("does not emit empty rich web search config", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-empty-web-"));
    const script = await writeMockAppServer(dir);
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = testNodeCommand;
    process.env.COWORK_CODEX_APP_SERVER_ARGS = script;
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

    const config = {
      ...makeConfig(dir),
      providerOptions: {
        "codex-cli": {
          webSearchMode: "cached",
          webSearch: {
            allowedDomains: [],
            location: {},
          },
        },
      },
    };
    const runtime = createRuntime(config);
    await runtime.runTurn({
      config,
      providerOptions: config.providerOptions,
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
    });

    const requests = await readCapturedRequests(capturePath);
    expect(requests.find((entry) => entry.method === "thread/start")?.params.config).toEqual({
      web_search: "cached",
    });
  });

  test.serial("normalizes Codex reasoning effort sentinels before turn/start", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-effort-"));
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

    const highConfig = {
      ...makeConfig(dir),
      providerOptions: {
        "codex-cli": {
          reasoningEffort: "xhigh",
        },
      },
    };
    const runtime = createRuntime(highConfig);
    await runtime.runTurn({
      config: highConfig,
      providerOptions: highConfig.providerOptions,
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
    });

    const xhighRequests = await readCapturedRequests(capturePath);
    expect(xhighRequests.find((entry) => entry.method === "turn/start")?.params.effort).toBe(
      "high",
    );

    await fs.writeFile(capturePath, "", "utf-8");
    const noneConfig = {
      ...makeConfig(dir),
      providerOptions: {
        "codex-cli": {
          reasoningEffort: "none",
        },
      },
    };
    await runtime.runTurn({
      config: noneConfig,
      providerOptions: noneConfig.providerOptions,
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
    });

    const noneRequests = await readCapturedRequests(capturePath);
    expect(noneRequests.find((entry) => entry.method === "turn/start")?.params).not.toHaveProperty(
      "effort",
    );
  });

  test.serial(
    "uses app-server default model when stored Codex model is not available",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-model-"));
      const script = path.join(dir, "model-gated-codex-app-server.js");
      const capturePath = path.join(dir, "requests.jsonl");
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
  if (msg.method === "thread/start" || msg.method === "turn/start") {
    fs.appendFileSync(process.env.CODEX_APP_SERVER_CAPTURE_PATH, JSON.stringify({ method: msg.method, params: msg.params }) + "\\n");
  }
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
    send({ id: msg.id, result: { data: [
      { id: "gpt-5.3-codex-spark", model: "gpt-5.3-codex-spark", displayName: "Spark", isDefault: true }
    ], nextCursor: null } });
    return;
  }
  if (msg.method === "thread/start") {
    if (msg.params.model !== "gpt-5.3-codex-spark") {
      send({ id: msg.id, error: { message: "The '" + msg.params.model + "' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again." } });
      return;
    }
    send({ id: msg.id, result: { thread: { id: "thread_1", modelProvider: "openai", turns: [] } } });
    return;
  }
  if (msg.method === "turn/start") {
    if (msg.params.model !== "gpt-5.3-codex-spark") {
      send({ id: msg.id, error: { message: "wrong model" } });
      return;
    }
    send({ id: msg.id, result: { turn: { id: "turn_1", status: "inProgress", items: [], error: null } } });
    send({ method: "turn/completed", params: { turn: { id: "turn_1", status: "completed", items: [{ type: "agentMessage", id: "item_1", text: "fallback ok" }], error: null } } });
  }
});
`,
        "utf-8",
      );
      process.env.COWORK_CODEX_APP_SERVER_COMMAND = testNodeCommand;
      process.env.COWORK_CODEX_APP_SERVER_ARGS = script;
      process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

      const logs: string[] = [];
      const runtime = createRuntime(makeConfig(dir));
      const result = await runtime.runTurn({
        config: makeConfig(dir),
        system: "You are Codex.",
        messages: [{ role: "user", content: "Say hi" }],
        tools: {},
        maxSteps: 1,
        log: (line) => logs.push(line),
      });

      expect(result.text).toBe("fallback ok");
      expect(result.providerState).toMatchObject({
        provider: "codex-cli",
        model: "gpt-5.3-codex-spark",
      });
      expect(logs.join("\n")).toContain(
        'model "gpt-5.4" is not available from the resolved app-server',
      );
      const requests = await readCapturedRequests(capturePath);
      expect(requests.find((entry) => entry.method === "thread/start")?.params.model).toBe(
        "gpt-5.3-codex-spark",
      );
      expect(requests.find((entry) => entry.method === "turn/start")?.params.model).toBe(
        "gpt-5.3-codex-spark",
      );
    },
  );

  test.serial("registers Cowork coordination tools as Codex dynamic tools", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-tools-"));
    const script = await writeMockAppServer(dir);
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = testNodeCommand;
    process.env.COWORK_CODEX_APP_SERVER_ARGS = script;
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

    const runtime = createRuntime(makeConfig(dir));
    await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.\n\n## Enabled Plugin Bundles\n\nCowork plugin example.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {
        spawnAgent: {
          description: "Spawn a Cowork subagent.",
          inputSchema: z.object({ task: z.string() }),
          execute: () => "spawned",
        },
        mcp__srv__custom: {
          description: "A Cowork-managed MCP tool.",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
          execute: () => "mcp ok",
        },
        bash: {
          description: "Cowork bash should already be filtered before runtime.",
          execute: () => "should not be called",
        },
      },
      maxSteps: 1,
    });

    const requests = await readCapturedRequests(capturePath);
    const startParams = requests.find((entry) => entry.method === "thread/start")?.params;
    expect(startParams).toMatchObject({
      modelProvider: "openai",
      experimentalRawEvents: true,
    });
    expect(startParams).not.toHaveProperty("tools");
    expect(startParams?.dynamicTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "spawnAgent",
          description: "Spawn a Cowork subagent.",
          inputSchema: expect.objectContaining({ type: "object" }),
        }),
        expect.objectContaining({
          name: "cowork_mcp__srv__custom",
          description: "A Cowork-managed MCP tool.",
          inputSchema: expect.objectContaining({ type: "object" }),
        }),
      ]),
    );
    expect(
      (startParams?.dynamicTools as Array<{ name?: string }>).map((tool) => tool.name),
    ).not.toContain("bash");
    expect(startParams?.baseInstructions).toContain("## Codex App-Server Tool Boundary");
    expect(startParams?.baseInstructions).toContain(
      "Codex app-server handles shell, filesystem, sandboxing, approvals, and native web search/fetch for this turn.",
    );
    expect(startParams?.baseInstructions).toContain(
      "Cowork exposes coordination tools and Cowork MCP as dynamic tools.",
    );
  });

  test.serial("handles Codex dynamic tool call server requests", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-dynamic-tools-"));
    process.env.COWORK_CODEX_APP_SERVER_ARGS = "dynamic-tool-call";

    const rawEvents: unknown[] = [];
    const runtime = createRuntime(makeConfig(dir));
    await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Use dynamic tools" }],
      tools: {
        structuredTool: {
          description: "Return structured data.",
          inputSchema: z.object({ value: z.string() }),
          execute: (input) => ({ ok: true, input }),
        },
        mcp__srv__custom: {
          description: "A Cowork-managed MCP tool.",
          inputSchema: z.object({ query: z.string() }),
          execute: (input) => ({ mcp: true, input }),
        },
        validatedTool: {
          description: "Validate input.",
          inputSchema: z.object({ count: z.number() }),
          execute: () => "valid",
        },
        throwsTool: {
          description: "Throw for testing.",
          execute: () => {
            throw new Error("boom");
          },
        },
      },
      maxSteps: 1,
      onModelRawEvent: (event) => {
        rawEvents.push(event);
      },
    });

    const dynamicResponses = rawEvents
      .map((event) => (event as { event?: { direction?: string; message?: unknown } }).event)
      .filter((event) => event?.direction === "client_response")
      .map((event) => event?.message as { result?: unknown })
      .map((message) => message.result)
      .filter((result) => {
        const record = result as { contentItems?: unknown };
        return Array.isArray(record?.contentItems);
      }) as Array<{ success: boolean; contentItems: Array<{ text: string }> }>;

    expect(dynamicResponses).toHaveLength(5);
    const structuredText = dynamicResponses[0]?.contentItems[0]?.text;
    expect(dynamicResponses[0]).toMatchObject({
      success: true,
      contentItems: [{ type: "inputText", text: expect.stringContaining('"ok": true') }],
    });
    expect(structuredText).toContain('"value": "ok"');
    const mcpText = dynamicResponses[1]?.contentItems[0]?.text;
    expect(dynamicResponses[1]?.success).toBe(true);
    expect(mcpText).toContain('"mcp": true');
    expect(mcpText).toContain('"query": "ok"');
    expect(dynamicResponses[2]).toMatchObject({
      success: false,
      contentItems: [{ text: expect.stringContaining("unknownTool") }],
    });
    expect(dynamicResponses[3]).toMatchObject({
      success: false,
      contentItems: [{ text: expect.stringContaining("validatedTool") }],
    });
    expect(dynamicResponses[4]).toMatchObject({
      success: false,
      contentItems: [{ text: expect.stringContaining("boom") }],
    });
  });

  test.serial(
    "passes workspace-write sandbox and approval prompts for regular Codex turns",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-sandbox-"));
      const script = await writeMockAppServer(dir);
      const capturePath = path.join(dir, "requests.jsonl");
      process.env.COWORK_CODEX_APP_SERVER_COMMAND = testNodeCommand;
      process.env.COWORK_CODEX_APP_SERVER_ARGS = script;
      process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

      const runtime = createRuntime(makeConfig(dir));
      await runtime.runTurn({
        config: makeConfig(dir),
        system: "You are Codex.",
        messages: [{ role: "user", content: "Say hi" }],
        tools: {},
        maxSteps: 1,
        yolo: false,
        shellPolicy: "full",
        approveCommand: async () => true,
      });

      const requests = await readCapturedRequests(capturePath);
      expect(requests.find((entry) => entry.method === "thread/start")?.params).toMatchObject({
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      });
      expect(requests.find((entry) => entry.method === "turn/start")?.params).toMatchObject({
        approvalPolicy: "on-request",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [dir],
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      });
    },
  );

  test.serial("passes danger-full-access sandbox when the session is in yolo mode", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-yolo-"));
    const script = await writeMockAppServer(dir);
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = testNodeCommand;
    process.env.COWORK_CODEX_APP_SERVER_ARGS = script;
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

    const runtime = createRuntime(makeConfig(dir));
    await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
      yolo: true,
      shellPolicy: "full",
    });

    const requests = await readCapturedRequests(capturePath);
    expect(requests.find((entry) => entry.method === "thread/start")?.params).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(requests.find((entry) => entry.method === "turn/start")?.params).toMatchObject({
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });

  test.serial("passes read-only sandbox for read-only subagent shell policy", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-readonly-"));
    const script = await writeMockAppServer(dir);
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = testNodeCommand;
    process.env.COWORK_CODEX_APP_SERVER_ARGS = script;
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

    const runtime = createRuntime(makeConfig(dir));
    await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are a read-only child agent.",
      messages: [{ role: "user", content: "Inspect only" }],
      tools: {},
      maxSteps: 1,
      yolo: true,
      shellPolicy: "no_project_write",
    });

    const requests = await readCapturedRequests(capturePath);
    expect(requests.find((entry) => entry.method === "thread/start")?.params).toMatchObject({
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    expect(requests.find((entry) => entry.method === "turn/start")?.params).toMatchObject({
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: true },
    });
  });

  test.serial("registers an active steer handler that sends turn/steer to app-server", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-steer-"));
    const script = await writeMockAppServer(dir);
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = testNodeCommand;
    process.env.COWORK_CODEX_APP_SERVER_ARGS = script;
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;
    process.env.CODEX_APP_SERVER_DELAY_COMPLETION = "1";

    let steerHandler:
      | ((input: { text: string; expectedTurnId: string }) => Promise<void>)
      | undefined;
    const runtime = createRuntime(makeConfig(dir));
    const result = await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
      registerSteerHandler: (handler) => {
        steerHandler = handler;
        queueMicrotask(() => {
          void handler({ text: "also mention steering", expectedTurnId: "turn_1" });
        });
        return () => {
          if (steerHandler === handler) steerHandler = undefined;
        };
      },
    });

    expect(result.text).toBe("hello from app-server");
    const requests = await readCapturedRequests(capturePath);
    expect(requests.find((entry) => entry.method === "turn/steer")?.params).toMatchObject({
      threadId: "thread_1",
      expectedTurnId: "turn_1",
      input: [{ type: "text", text: "also mention steering", text_elements: [] }],
    });
    expect(steerHandler).toBeUndefined();
  });

  test.serial("refreshes dynamic tools and only sends latest user input on resume", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-resume-"));
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

    const runtime = createRuntime(makeConfig(dir));
    await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      allMessages: [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "Newest question" },
      ],
      messages: [{ role: "user", content: "Newest question" }],
      tools: {
        spawnAgent: {
          description: "Spawn a Cowork subagent.",
          inputSchema: z.object({ task: z.string() }),
          execute: () => "spawned",
        },
        mcp__srv__custom: {
          description: "A Cowork-managed MCP tool.",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
          execute: () => "mcp ok",
        },
        bash: {
          description: "Cowork bash should stay native to app-server.",
          execute: () => "should not be called",
        },
      },
      maxSteps: 1,
      providerState: {
        provider: "codex-cli",
        model: "gpt-5.4",
        threadId: "thread_1",
        updatedAt: new Date().toISOString(),
      },
    });

    const requests = await readCapturedRequests(capturePath);
    const resumeParams = requests.find((entry) => entry.method === "thread/resume")?.params;
    expect(resumeParams).not.toHaveProperty("baseInstructions");
    expect(resumeParams?.dynamicTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "spawnAgent",
          description: "Spawn a Cowork subagent.",
          inputSchema: expect.objectContaining({ type: "object" }),
        }),
        expect.objectContaining({
          name: "cowork_mcp__srv__custom",
          description: "A Cowork-managed MCP tool.",
          inputSchema: expect.objectContaining({ type: "object" }),
        }),
      ]),
    );
    expect(
      (resumeParams?.dynamicTools as Array<{ name?: string }>).map((tool) => tool.name),
    ).not.toContain("bash");
    expect(requests.find((entry) => entry.method === "turn/start")?.params.input).toEqual([
      { type: "text", text: "Newest question", text_elements: [] },
    ]);
  });

  test.serial("starts a fresh thread when stored app-server thread is stale", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-stale-"));
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;
    process.env.COWORK_CODEX_APP_SERVER_ARGS = "stale-resume";

    const runtime = createRuntime(makeConfig(dir));
    const result = await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      allMessages: [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "Newest question" },
      ],
      messages: [{ role: "user", content: "Newest question" }],
      tools: {},
      maxSteps: 1,
      providerState: {
        provider: "codex-cli",
        model: "gpt-5.4",
        threadId: "stale_thread",
        updatedAt: new Date().toISOString(),
      },
    });

    const requests = await readCapturedRequests(capturePath);
    expect(requests.map((entry) => entry.method)).toEqual(
      expect.arrayContaining(["thread/resume", "thread/start", "turn/start"]),
    );
    expect(requests.find((entry) => entry.method === "thread/start")?.params).toHaveProperty(
      "baseInstructions",
    );
    expect(requests.find((entry) => entry.method === "turn/start")?.params.input).toEqual([
      { type: "text", text: "User: Earlier question", text_elements: [] },
      { type: "text", text: "Assistant: Earlier answer", text_elements: [] },
      { type: "text", text: "User: Newest question", text_elements: [] },
    ]);
    expect(result.providerState).toEqual(
      expect.objectContaining({ provider: "codex-cli", model: "gpt-5.4", threadId: "thread_1" }),
    );
  });

  test.serial(
    "preserves fresh conversation history and attachment order in text_elements",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-attachments-"));
      const capturePath = path.join(dir, "requests.jsonl");
      process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

      const runtime = createRuntime(makeConfig(dir));
      await runtime.runTurn({
        config: makeConfig(dir),
        system: "You are Codex.",
        allMessages: [
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: "Earlier answer" },
          {
            role: "user",
            content: [
              { type: "text", text: "Look at these" },
              { type: "image", mimeType: "image/png", data: "abc", filename: "chart.png" },
              { type: "file", mimeType: "text/plain", data: "inline", filename: "note.txt" },
              { type: "file", path: "/tmp/uploaded.pdf", filename: "uploaded.pdf" },
            ],
          },
        ],
        messages: [{ role: "user", content: "Look at these" }],
        tools: {},
        maxSteps: 1,
      });

      const requests = await readCapturedRequests(capturePath);
      expect(requests.find((entry) => entry.method === "turn/start")?.params.input).toEqual([
        { type: "text", text: "User: Earlier question", text_elements: [] },
        { type: "text", text: "Assistant: Earlier answer", text_elements: [] },
        {
          type: "text",
          text: "User: Look at these",
          text_elements: [
            { type: "image", mimeType: "image/png", data: "abc", filename: "chart.png" },
            { type: "file", mimeType: "text/plain", data: "inline", filename: "note.txt" },
            { type: "file", path: "/tmp/uploaded.pdf", filename: "uploaded.pdf" },
          ],
        },
      ]);
    },
  );

  test.serial("aborts active app-server turns through interruptTurn", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-abort-"));
    process.env.CODEX_APP_SERVER_DELAY_COMPLETION = "1";
    const controller = new AbortController();
    const runtime = createRuntime(makeConfig(dir));

    await expect(
      runtime.runTurn({
        config: makeConfig(dir),
        system: "You are Codex.",
        messages: [{ role: "user", content: "Wait" }],
        tools: {},
        maxSteps: 1,
        abortSignal: controller.signal,
        onModelRawEvent: (event) => {
          const message = event.event.message as { method?: string } | undefined;
          if (message?.method === "turn/start") setTimeout(() => controller.abort(), 0);
        },
      }),
    ).rejects.toThrow("Cancelled by user");
    expect(mockInterrupts).toEqual([{ threadId: "thread_1", turnId: "turn_1" }]);
  });

  test.serial("projects requestUserInput, todoList, and fileChange events", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-events-"));
    process.env.COWORK_CODEX_APP_SERVER_ARGS = "eventful";
    const todos: unknown[] = [];
    const streamParts: unknown[] = [];
    const prompts: unknown[] = [];
    const runtime = createRuntime(makeConfig(dir));

    await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Do work" }],
      tools: {},
      maxSteps: 1,
      askUser: async (question, options) => {
        prompts.push({ question, options });
        return "yes";
      },
      updateTodos: (nextTodos) => todos.push(nextTodos),
      onModelStreamPart: (part) => streamParts.push(part),
    });

    expect(todos).toContainEqual([
      {
        content: "Wire app-server todos",
        status: "completed",
        activeForm: "Wire app-server todos",
      },
    ]);
    expect(streamParts).toContainEqual(
      expect.objectContaining({
        type: "tool-call",
        toolName: "fileChange",
      }),
    );
    expect(streamParts).toContainEqual(
      expect.objectContaining({
        type: "tool-result",
        toolName: "fileChange",
        output: expect.stringContaining("--- a/src/example.ts"),
      }),
    );
    expect(streamParts).toContainEqual(
      expect.objectContaining({
        type: "tool-result",
        toolName: "fileChange",
        output: expect.stringContaining("@@ -1 +1 @@"),
      }),
    );
    expect(streamParts).toContainEqual(
      expect.objectContaining({
        type: "tool-result",
        toolName: "fileChange",
        output: [{ path: "src/example.ts", kind: "modified" }],
      }),
    );
    expect(prompts).toEqual([{ question: "Need detail?", options: ["yes"] }]);
  });

  test.serial("ignores early token usage for a different turn id", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-wrong-usage-"));
    process.env.COWORK_CODEX_APP_SERVER_ARGS = "early-token-usage-wrong";
    const runtime = createRuntime(makeConfig(dir));

    const result = await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
    });

    expect(result.text).toBe("hello from app-server");
    expect(result.usage).toBeUndefined();
  });

  test.serial("keeps early token usage when its turn id later matches", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-matching-usage-"));
    process.env.COWORK_CODEX_APP_SERVER_ARGS = "early-token-usage-matching";
    const runtime = createRuntime(makeConfig(dir));

    const result = await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
    });

    expect(result.usage).toEqual({
      promptTokens: 11,
      completionTokens: 13,
      totalTokens: 24,
      cachedPromptTokens: 1,
      cacheWritePromptTokens: 2,
      reasoningOutputTokens: 5,
    });
  });

  test.serial("uses cumulative Codex token usage instead of the last request", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-cumulative-usage-"));
    process.env.COWORK_CODEX_APP_SERVER_ARGS = "cumulative-token-usage";
    const runtime = createRuntime(makeConfig(dir));

    const result = await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
    });

    expect(result.usage).toEqual({
      promptTokens: 3455915,
      completionTokens: 20472,
      totalTokens: 3476387,
      cachedPromptTokens: 2987776,
      reasoningOutputTokens: 5929,
    });
  });

  test.serial("normalizes OpenAI-style cached and reasoning usage details", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-openai-usage-"));
    process.env.COWORK_CODEX_APP_SERVER_ARGS = "openai-usage-details";
    const runtime = createRuntime(makeConfig(dir));

    const result = await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
    });

    expect(result.usage).toEqual({
      promptTokens: 20,
      completionTokens: 13,
      totalTokens: 33,
      cachedPromptTokens: 6,
      cacheWritePromptTokens: 4,
      reasoningOutputTokens: 5,
    });
  });
});
