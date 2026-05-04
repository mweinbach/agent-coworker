import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  send({ method: "thread/tokenUsage/updated", params: { threadId: "thread_1", turnId: "turn_1", tokenUsage: { total: { totalTokens: 7, inputTokens: 3, cachedInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 0 }, last: { totalTokens: 7, inputTokens: 3, cachedInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 0 }, modelContextWindow: 272000 } } });
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
  const notificationListeners = new Set<(notification: CodexAppServerJsonRpcNotification) => void>();
  const rawListeners = new Set<(message: CodexAppServerJsonRpcRawMessage) => void>();
  const serverRequestHandlers = new Set<(request: { id: number; method: string; params?: unknown }) => unknown>();
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
  const completeTurn = (turnId: string, text: string, extraItems: unknown[] = []) => {
    sendNotification({
      method: "item/started",
      params: {
        threadId: "thread_1",
        turnId,
        item: { type: "agentMessage", id: "item_1", text: "", phase: null, memoryCitation: null },
      },
    });
    sendNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread_1", turnId, itemId: "item_1", delta: text },
    });
    sendNotification({
      method: "item/completed",
      params: {
        threadId: "thread_1",
        turnId,
        item: { type: "agentMessage", id: "item_1", text, phase: null, memoryCitation: null },
      },
    });
    sendNotification({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread_1",
        turnId,
        tokenUsage: {
          total: {
            totalTokens: 7,
            inputTokens: 3,
            cachedInputTokens: 0,
            outputTokens: 4,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 7,
            inputTokens: 3,
            cachedInputTokens: 0,
            outputTokens: 4,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 272000,
        },
      },
    });
    sendNotification({
      method: "turn/completed",
      params: {
        turn: {
          id: turnId,
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
      const record = params as { threadId?: string; model?: string; approvalPolicy?: string; sandbox?: string };
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
      const turnId = `turn_${nextTurnId++}`;
      result = { turn: { id: turnId, status: "inProgress", items: [], error: null } };
      if (process.env.CODEX_APP_SERVER_DELAY_COMPLETION !== "1") {
        queueMicrotask(async () => {
          if (process.env.COWORK_CODEX_APP_SERVER_ARGS?.includes("eventful")) {
            await sendServerRequest("requestUserInput", { question: "Need detail?", options: ["yes"] });
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
              method: "item/completed",
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
          }
          completeTurn(
            turnId,
            process.env.COWORK_CODEX_APP_SERVER_ARGS?.includes("model-gated")
              ? "fallback ok"
              : "hello from app-server",
          );
        });
      }
    } else if (method === "turn/steer") {
      const record = params as { expectedTurnId?: string; input?: unknown };
      result = { turnId: record.expectedTurnId };
      queueMicrotask(() => {
        completeTurn(record.expectedTurnId ?? "turn_1", "hello from app-server", [
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

  test.serial("forwards Codex verbosity and rich web search config to app-server threads", async () => {
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
  });

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

  test.serial("uses app-server default model when stored Codex model is not available", async () => {
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
  });

  test.serial("marks Codex app-server as owner of native tools, apps, and plugins", async () => {
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
        localOnlyTool: {
          description: "A Cowork-only custom tool.",
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
    expect(startParams?.baseInstructions).toContain("## Codex App-Server Tool Boundary");
    expect(startParams?.baseInstructions).toContain(
      "Executable tools, MCP servers, ChatGPT apps/connectors, and Codex plugins for this turn are owned by Codex app-server.",
    );
    expect(startParams?.baseInstructions).toContain(
      "Cowork custom tools and Cowork-managed MCP tools are not injected into Codex app-server turns",
    );
  });

  test.serial("passes workspace-write sandbox and approval prompts for regular Codex turns", async () => {
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
  });

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

  test.serial("omits base instructions and only sends latest user input on resume", async () => {
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
      tools: {},
      maxSteps: 1,
      providerState: {
        provider: "codex-cli",
        model: "gpt-5.4",
        threadId: "thread_1",
        updatedAt: new Date().toISOString(),
      },
    });

    const requests = await readCapturedRequests(capturePath);
    expect(requests.find((entry) => entry.method === "thread/resume")?.params).not.toHaveProperty(
      "baseInstructions",
    );
    expect(requests.find((entry) => entry.method === "turn/start")?.params.input).toEqual([
      { type: "text", text: "Newest question", text_elements: [] },
    ]);
  });

  test.serial("preserves fresh conversation history and attachment order in text_elements", async () => {
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
  });

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
    const runtime = createRuntime(makeConfig(dir));

    await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Do work" }],
      tools: {},
      maxSteps: 1,
      askUser: async () => "yes",
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
        output: expect.stringContaining("src/example.ts"),
      }),
    );
  });
});
