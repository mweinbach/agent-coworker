import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRuntime } from "../src/runtime";
import type { AgentConfig } from "../src/types";
import { VERSION } from "../src/version";

const previousCommand = process.env.COWORK_CODEX_APP_SERVER_COMMAND;
const previousArgs = process.env.COWORK_CODEX_APP_SERVER_ARGS;
const previousCapturePath = process.env.CODEX_APP_SERVER_CAPTURE_PATH;
const previousDelayCompletion = process.env.CODEX_APP_SERVER_DELAY_COMPLETION;

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

afterEach(() => {
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
  test("initializes app-server with the Cowork package version", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-init-"));
    const script = await writeMockAppServer(dir);
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = process.execPath;
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
    });
  });

  test("drives a turn through codex app-server JSONL", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-runtime-"));
    const script = await writeMockAppServer(dir);
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = process.execPath;
    process.env.COWORK_CODEX_APP_SERVER_ARGS = script;

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
  });

  test("passes workspace-write sandbox and approval prompts for regular Codex turns", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-sandbox-"));
    const script = await writeMockAppServer(dir);
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = process.execPath;
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

  test("passes danger-full-access sandbox when the session is in yolo mode", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-yolo-"));
    const script = await writeMockAppServer(dir);
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = process.execPath;
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

  test("passes read-only sandbox for read-only subagent shell policy", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-readonly-"));
    const script = await writeMockAppServer(dir);
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = process.execPath;
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

  test("registers an active steer handler that sends turn/steer to app-server", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-steer-"));
    const script = await writeMockAppServer(dir);
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = process.execPath;
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
});
