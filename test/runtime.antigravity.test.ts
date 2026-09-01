import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { scratchRoots } from "../src/platform/sandbox";
import type { RuntimeRunTurnParams } from "../src/runtime/types";
import type { AgentConfig, ModelMessage } from "../src/types";

// Setup Mock for unofficial-antigravity-sdk
mock.module("unofficial-antigravity-sdk", () => {
  class MockText {
    constructor(
      public stepIndex: number,
      public text: string,
    ) {}
  }
  class MockThought {
    constructor(
      public stepIndex: number,
      public text: string,
    ) {}
  }
  class MockLocalAgentConfig {
    constructor(public options?: any) {
      if (options) Object.assign(this, options);
    }
  }
  class MockCapabilitiesConfig {
    constructor(public options?: any) {
      if (options) Object.assign(this, options);
    }
  }

  let chatMockImpl: (prompt: string) => Promise<any>;
  let startMockImpl: ((agent: MockAgent) => Promise<void> | void) | undefined;
  let stopMockImpl: ((agent: MockAgent) => Promise<void> | void) | undefined;
  let lastCreatedInstance: any = null;

  class MockAgent {
    static __setChatMockImpl(impl: typeof chatMockImpl) {
      chatMockImpl = impl;
    }

    static __setStartMockImpl(impl: typeof startMockImpl) {
      startMockImpl = impl;
    }

    static __setStopMockImpl(impl: typeof stopMockImpl) {
      stopMockImpl = impl;
    }

    static getLastInstance() {
      return lastCreatedInstance;
    }

    static open = mock(async (config: any) => {
      const agent = new MockAgent(config);
      await agent.start();
      return agent;
    });

    constructor(public config: any) {
      lastCreatedInstance = this;
    }
    isConnected = false;

    async start() {
      await startMockImpl?.(this);
      this.isConnected = true;
    }

    async stop() {
      await stopMockImpl?.(this);
      if (!this.isConnected) return;
      this.isConnected = false;
    }

    async chat(prompt: string) {
      if (chatMockImpl) {
        return chatMockImpl(prompt);
      }
      throw new Error("chatMockImpl not set");
    }
  }

  return {
    Agent: MockAgent,
    LocalAgentConfig: MockLocalAgentConfig,
    CapabilitiesConfig: MockCapabilitiesConfig,
    Text: MockText,
    Thought: MockThought,
    tool: (name: string, description: string, schema: any, execute: any) => {
      return { name, description, schema, execute };
    },
  };
});

import { Agent, Text, Thought } from "unofficial-antigravity-sdk";
import { createAntigravityRuntime } from "../src/runtime/antigravityRuntime";

function makeConfig(homeDir: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: "antigravity",
    model: "gemini-3.5-flash",
    preferredChildModel: "gemini-3.5-flash",
    workingDirectory: homeDir,
    outputDirectory: path.join(homeDir, "output"),
    uploadsDirectory: path.join(homeDir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(homeDir, ".agent-project"),
    userCoworkDir: path.join(homeDir, ".cowork"),
    builtInDir: homeDir,
    builtInConfigDir: path.join(homeDir, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    providerOptions: {},
    ...overrides,
  };
}

function makeParams(
  config: AgentConfig,
  overrides: Partial<RuntimeRunTurnParams> = {},
): RuntimeRunTurnParams {
  return {
    config,
    system: "You are helpful.",
    messages: [{ role: "user", content: "hello" }] as ModelMessage[],
    tools: {},
    maxSteps: 1,
    ...overrides,
  };
}

async function boundedOutcome<T>(operation: Promise<T>, timeoutMs = 500) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(
        (value) => ({ kind: "resolved" as const, value }),
        (error: Error) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ kind: "hung" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "hung" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

describe("antigravity runtime", () => {
  afterEach(() => {
    (Agent as any).__setStartMockImpl(undefined);
    (Agent as any).__setStopMockImpl(undefined);
  });

  test("basic text response flows through runtime", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-test-"));
    const runtime = createAntigravityRuntime({ platform: "linux" });

    (Agent as any).__setChatMockImpl(async (prompt: string) => {
      const chunks = [new Text(0, "Hello! "), new Text(0, "How can I help you?")];
      return {
        getChunks: async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        },
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 20,
          totalTokenCount: 30,
          cachedContentTokenCount: 3,
          cacheWriteTokenCount: 2,
          thoughtsTokenCount: 4,
        },
      };
    });

    const emittedParts: any[] = [];
    const params = makeParams(makeConfig(homeDir), {
      onModelStreamPart: (part) => {
        emittedParts.push(part);
      },
    });

    // Provide API Key via env to avoid throw
    process.env.GEMINI_API_KEY = "test-key";

    const result = await runtime.runTurn(params);

    expect(result.text).toBe("Hello! How can I help you?");
    expect(result.responseMessages).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello! How can I help you?" }],
      },
    ]);
    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      cachedPromptTokens: 3,
      cacheWritePromptTokens: 2,
      reasoningOutputTokens: 4,
    });

    expect(emittedParts).toContainEqual({ type: "start" });
    expect(emittedParts).toContainEqual({ type: "text-start", id: "s0" });
    expect(emittedParts).toContainEqual({ type: "text-delta", id: "s0", text: "Hello! " });
    expect(emittedParts).toContainEqual({
      type: "text-delta",
      id: "s0",
      text: "How can I help you?",
    });
    expect(emittedParts).toContainEqual({ type: "text-end", id: "s0" });
    expect(emittedParts).toContainEqual({
      type: "finish",
      finishReason: "stop",
      totalUsage: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        cachedPromptTokens: 3,
        cacheWritePromptTokens: 2,
        reasoningOutputTokens: 4,
      },
    });
  });

  test("thinking content emits bracketed reasoning events and extracts reasoningText", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-test-"));
    const runtime = createAntigravityRuntime({ platform: "linux" });

    (Agent as any).__setChatMockImpl(async (prompt: string) => {
      const chunks = [new Thought(0, "Thinking..."), new Text(0, "Here is the response.")];
      return {
        getChunks: async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        },
        usageMetadata: {
          promptTokenCount: 15,
          candidatesTokenCount: 25,
          totalTokenCount: 40,
        },
      };
    });

    const emittedParts: any[] = [];
    const params = makeParams(makeConfig(homeDir), {
      onModelStreamPart: (part) => {
        emittedParts.push(part);
      },
    });

    process.env.GEMINI_API_KEY = "test-key";

    const result = await runtime.runTurn(params);

    expect(result.text).toBe("Here is the response.");
    expect(result.reasoningText).toBe("Thinking...");
    expect(result.responseMessages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Thinking..." },
          { type: "text", text: "Here is the response." },
        ],
      },
    ]);

    const typeSequence = emittedParts.map((p) => p.type);
    const reasoningStartIdx = typeSequence.indexOf("reasoning-start");
    const reasoningDeltaIdx = typeSequence.indexOf("reasoning-delta");
    const reasoningEndIdx = typeSequence.indexOf("reasoning-end");
    const textStartIdx = typeSequence.indexOf("text-start");
    const textDeltaIdx = typeSequence.indexOf("text-delta");
    const textEndIdx = typeSequence.indexOf("text-end");

    expect(reasoningStartIdx).toBeGreaterThanOrEqual(0);
    expect(reasoningDeltaIdx).toBeGreaterThan(reasoningStartIdx);
    expect(reasoningEndIdx).toBeGreaterThan(reasoningDeltaIdx);
    expect(textStartIdx).toBeGreaterThan(reasoningEndIdx);
    expect(textDeltaIdx).toBeGreaterThan(textStartIdx);
    expect(textEndIdx).toBeGreaterThan(textDeltaIdx);

    const reasoningStart = emittedParts[reasoningStartIdx];
    const reasoningDelta = emittedParts[reasoningDeltaIdx];
    const reasoningEnd = emittedParts[reasoningEndIdx];
    const textStart = emittedParts[textStartIdx];
    expect(reasoningStart.id).toBe(reasoningDelta.id);
    expect(reasoningEnd.id).toBe(reasoningDelta.id);
    expect(reasoningDelta.id).not.toBe(textStart.id);
    expect(reasoningDelta.text).toBe("Thinking...");
  });

  test("interleaved thoughts and text produce paired reasoning brackets", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-test-"));
    const runtime = createAntigravityRuntime({ platform: "linux" });

    (Agent as any).__setChatMockImpl(async (_prompt: string) => {
      const chunks = [
        new Thought(0, "planning..."),
        new Text(0, "first answer."),
        new Thought(1, "second thought."),
        new Text(1, "second answer."),
      ];
      return {
        getChunks: async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        },
        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: 10,
          totalTokenCount: 15,
        },
      };
    });

    const emittedParts: any[] = [];
    const params = makeParams(makeConfig(homeDir), {
      onModelStreamPart: (part) => {
        emittedParts.push(part);
      },
    });

    process.env.GEMINI_API_KEY = "test-key";

    const result = await runtime.runTurn(params);
    expect(result.text).toBe("first answer.second answer.");
    expect(result.reasoningText).toBe("planning...second thought.");

    const typeSequence = emittedParts.map((p) => p.type);

    // We expect two complete reasoning brackets and two text brackets,
    // alternating: r-s r-d r-e t-s t-d t-e r-s r-d r-e t-s t-d t-e.
    const reasoningStarts = typeSequence.filter((t) => t === "reasoning-start").length;
    const reasoningEnds = typeSequence.filter((t) => t === "reasoning-end").length;
    const textStarts = typeSequence.filter((t) => t === "text-start").length;
    const textEnds = typeSequence.filter((t) => t === "text-end").length;
    expect(reasoningStarts).toBe(2);
    expect(reasoningEnds).toBe(2);
    expect(textStarts).toBe(2);
    expect(textEnds).toBe(2);

    // Reasoning brackets must not enclose text-deltas: the previous reasoning
    // must end before any text-start for that run.
    const phaseOrder = typeSequence.filter((t) =>
      ["reasoning-start", "reasoning-end", "text-start", "text-end"].includes(t as string),
    );
    expect(phaseOrder).toEqual([
      "reasoning-start",
      "reasoning-end",
      "text-start",
      "text-end",
      "reasoning-start",
      "reasoning-end",
      "text-start",
      "text-end",
    ]);
  });

  test("tool calls trigger tool execution and multi-step loop", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-test-"));
    const runtime = createAntigravityRuntime({ platform: "linux" });

    let toolExecuted = false;
    let toolInputReceived: any = null;
    let sdkTool: any;
    let toolResult: unknown;

    (Agent as any).__setChatMockImpl(async (prompt: string) => {
      return {
        getChunks: async function* () {
          yield new Text(0, "I will inspect it. ");
          sdkTool = (Agent as any)
            .getLastInstance()
            .config.tools.find((t: any) => t.name === "testTool");
          toolResult = await sdkTool.execute({ val: "hello-tool" });
          yield new Text(0, "Tool executed successfully.");
        },
        usageMetadata: {
          promptTokenCount: 20,
          candidatesTokenCount: 30,
          totalTokenCount: 50,
        },
      };
    });

    const emittedParts: any[] = [];
    const params = makeParams(makeConfig(homeDir), {
      onModelStreamPart: (part) => {
        emittedParts.push(part);
      },
      tools: {
        testTool: {
          description: "A test tool",
          inputSchema: { type: "object", properties: { val: { type: "string" } } },
          execute: async (input: any) => {
            toolExecuted = true;
            toolInputReceived = input;
            return "tool result content";
          },
        },
      },
    });

    process.env.GEMINI_API_KEY = "test-key";
    const result = await runtime.runTurn(params);
    expect(toolResult).toBe("tool result content");
    expect(toolExecuted).toBe(true);
    expect(toolInputReceived).toEqual({ val: "hello-tool" });

    expect(result.text).toBe("I will inspect it. Tool executed successfully.");
    expect(result.responseMessages.map((message) => message.role)).toEqual([
      "assistant",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(result.responseMessages[0]?.content).toEqual([
      { type: "text", text: "I will inspect it. " },
    ]);
    expect(
      result.responseMessages.some(
        (m) => m.role === "assistant" && m.content.some((c: any) => c.type === "tool-call"),
      ),
    ).toBe(true);
    expect(
      result.responseMessages.some(
        (m) => m.role === "tool" && m.content.some((c: any) => c.type === "tool-result"),
      ),
    ).toBe(true);

    expect(emittedParts.some((p) => p.type === "tool-input-start")).toBe(true);
    expect(emittedParts.some((p) => p.type === "tool-input-end")).toBe(true);
    expect(emittedParts.some((p) => p.type === "tool-call")).toBe(true);
    expect(emittedParts.some((p) => p.type === "tool-result")).toBe(true);

    const historyLength = result.responseMessages.length;
    await expect(sdkTool.execute({ val: "too-late" })).rejects.toThrow("no longer active");
    expect(result.responseMessages).toHaveLength(historyLength);
  });

  test("validates Zod tool input before executing model-supplied arguments", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-test-"));
    const runtime = createAntigravityRuntime({ platform: "linux" });
    let executeCalls = 0;

    (Agent as any).__setChatMockImpl(async () => {
      return {
        getChunks: async function* () {
          const boundedTool = (Agent as any)
            .getLastInstance()
            .config.tools.find((t: any) => t.name === "boundedTool");
          await expect(boundedTool.execute({ limit: 6 })).rejects.toThrow(
            /5|less than or equal|Too big/,
          );
          yield new Text(0, "No tool needed.");
        },
        usageMetadata: {
          promptTokenCount: 2,
          candidatesTokenCount: 3,
          totalTokenCount: 5,
        },
      };
    });

    const emittedParts: any[] = [];
    const params = makeParams(makeConfig(homeDir), {
      onModelStreamPart: (part) => {
        emittedParts.push(part);
      },
      tools: {
        boundedTool: {
          description: "A bounded test tool",
          inputSchema: z.object({
            limit: z.number().int().min(1).max(5),
          }),
          execute: async () => {
            executeCalls++;
            return "should not run";
          },
        },
      },
    });

    process.env.GEMINI_API_KEY = "test-key";
    const result = await runtime.runTurn(params);
    expect(executeCalls).toBe(0);
    expect(
      emittedParts.some(
        (part) =>
          part.type === "tool-error" &&
          part.toolName === "boundedTool" &&
          typeof part.error === "string",
      ),
    ).toBe(true);
    expect(emittedParts.some((part) => part.type === "tool-result")).toBe(false);

    expect(result.text).toBe("No tool needed.");
  });

  test("isHiddenPath mirrors localharness URI hidden check (any '.' segment)", () => {
    const { isHiddenPath } = require("../src/runtime/antigravityRuntime");
    expect(isHiddenPath("/Users/mweinbach/Projects/my-project")).toBe(false);
    expect(isHiddenPath("/Users/mweinbach/.cowork/chats/1234")).toBe(true);
    expect(isHiddenPath(".cowork/chats")).toBe(true);
    expect(isHiddenPath("path/to/.hidden/dir")).toBe(true);
    expect(isHiddenPath("/path/.env")).toBe(true);
    expect(isHiddenPath(".git")).toBe(true);
  });

  test("antigravity runtime falls back to a non-hidden tmpdir workspace when the working dir is hidden", async () => {
    const { resolveHarnessWorkspaceDir } = require("../src/runtime/antigravityRuntime");
    const expectedFallback = path.join(os.tmpdir(), "cowork-antigravity-workspace");

    const runtime = createAntigravityRuntime({ platform: "linux" });
    const hiddenHomeDir = "/Users/mweinbach/.cowork/chats/20260520T182819Z-test";
    const config = makeConfig(hiddenHomeDir);
    config.workingDirectory = hiddenHomeDir;

    (Agent as any).__setChatMockImpl(async () => {
      return {
        getChunks: async function* () {
          yield new Text(0, "Mocked response");
        },
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      };
    });

    const params = makeParams(config);
    process.env.GEMINI_API_KEY = "test-key";

    await runtime.runTurn(params);

    const capturedAgent = (Agent as any).getLastInstance();
    expect(capturedAgent).toBeDefined();
    expect(capturedAgent.config.workspaces).toEqual([expectedFallback]);
    expect(resolveHarnessWorkspaceDir(hiddenHomeDir)).toBe(expectedFallback);
  });

  test("antigravity runtime passes through a non-hidden working dir as the workspace", async () => {
    const runtime = createAntigravityRuntime({ platform: "linux" });
    const visibleHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-ws-"));
    const config = makeConfig(visibleHomeDir);
    config.workingDirectory = visibleHomeDir;

    (Agent as any).__setChatMockImpl(async () => {
      return {
        getChunks: async function* () {
          yield new Text(0, "Mocked response");
        },
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      };
    });

    const params = makeParams(config);
    process.env.GEMINI_API_KEY = "test-key";

    await runtime.runTurn(params);

    const capturedAgent = (Agent as any).getLastInstance();
    expect(capturedAgent).toBeDefined();
    expect(capturedAgent.config.workspaces).toEqual([visibleHomeDir]);
  });

  test("provider harness startup never mutates the process environment for Cowork tools", async () => {
    const runtime = createAntigravityRuntime({ platform: "linux" });
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-env-"));
    const previousToolEnv = process.env.COWORK_TEST_TOOL_ENV;
    let capturedToolEnv: string | undefined;

    (Agent as any).__setChatMockImpl(async () => ({
      getChunks: async function* () {
        yield new Text(0, "Mocked response");
      },
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    }));
    (Agent as any).__setStartMockImpl(() => {
      capturedToolEnv = process.env.COWORK_TEST_TOOL_ENV;
    });

    try {
      process.env.GEMINI_API_KEY = "test-key";
      process.env.COWORK_TEST_TOOL_ENV = "outside";

      await runtime.runTurn(
        makeParams(makeConfig(homeDir), {
          toolEnv: {
            COWORK_TEST_TOOL_ENV: "inside",
          },
        }),
      );

      expect(capturedToolEnv).toBe("outside");
      expect(process.env.COWORK_TEST_TOOL_ENV).toBe("outside");
    } finally {
      (Agent as any).__setStartMockImpl(undefined);
      if (previousToolEnv === undefined) {
        delete process.env.COWORK_TEST_TOOL_ENV;
      } else {
        process.env.COWORK_TEST_TOOL_ENV = previousToolEnv;
      }
    }
  });

  test("never starts a local harness for a turn cancelled before startup", async () => {
    const runtime = createAntigravityRuntime({ platform: "linux" });
    const homeDir = await fs.mkdtemp(
      path.join(scratchRoots()[0] ?? "/tmp", "antigravity-cancel-before-start-"),
    );
    const controller = new AbortController();
    controller.abort();
    const starts = mock(() => {});
    (Agent as any).__setStartMockImpl(starts);
    process.env.GEMINI_API_KEY = "test-key";

    try {
      await expect(
        runtime.runTurn(makeParams(makeConfig(homeDir), { abortSignal: controller.signal })),
      ).rejects.toThrow("Model turn aborted.");
      expect(starts).not.toHaveBeenCalled();
    } finally {
      (Agent as any).__setStartMockImpl(undefined);
    }
  });

  test("stops and releases a harness when startup fails after partially connecting", async () => {
    const runtime = createAntigravityRuntime({ platform: "linux" });
    const homeDir = await fs.mkdtemp(
      path.join(scratchRoots()[0] ?? "/tmp", "antigravity-startup-failure-"),
    );
    (Agent as any).__setStartMockImpl(async (agent: { isConnected: boolean }) => {
      agent.isConnected = true;
      throw new Error("local harness startup failed");
    });
    process.env.GEMINI_API_KEY = "test-key";

    try {
      await expect(runtime.runTurn(makeParams(makeConfig(homeDir)))).rejects.toThrow(
        "local harness startup failed",
      );
      expect((Agent as any).getLastInstance().isConnected).toBe(false);
    } finally {
      (Agent as any).__setStartMockImpl(undefined);
    }
  });

  test("Stop settles immediately when local harness startup never answers", async () => {
    const runtime = createAntigravityRuntime({ platform: "linux" });
    const homeDir = await fs.mkdtemp(
      path.join(scratchRoots()[0] ?? "/tmp", "antigravity-stalled-startup-"),
    );
    const startup = Promise.withResolvers<void>();
    (Agent as any).__setStartMockImpl(async () => await startup.promise);
    process.env.GEMINI_API_KEY = "test-key";
    const controller = new AbortController();

    try {
      const turn = runtime.runTurn(
        makeParams(makeConfig(homeDir), { abortSignal: controller.signal }),
      );
      const settled = turn.then(
        () => ({ kind: "completed" as const }),
        (error: Error) => ({ kind: "rejected" as const, error }),
      );
      await Promise.resolve();
      controller.abort();

      const result = await Promise.race([
        settled,
        new Promise<{ kind: "hung" }>((resolve) =>
          setTimeout(() => resolve({ kind: "hung" }), 100),
        ),
      ]);
      startup.resolve();

      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") {
        expect(result.error.message).toBe("Model turn aborted.");
      }
    } finally {
      startup.resolve();
      (Agent as any).__setStartMockImpl(undefined);
    }
  });

  test("replays complete conversation and completed tool work into each fresh harness", async () => {
    const homeDir = await fs.mkdtemp(path.join(scratchRoots()[0]!, "antigravity-history-"));
    let capturedPrompt: unknown;
    (Agent as any).__setChatMockImpl(async (prompt: unknown) => {
      capturedPrompt = prompt;
      return {
        getChunks: async function* () {
          yield new Text(0, "continued");
        },
      };
    });
    process.env.GEMINI_API_KEY = "test-key";
    const latest: ModelMessage = { role: "user", content: "continue, do not repeat it" };
    const allMessages: ModelMessage[] = [
      { role: "user", content: "Remember the chosen name: Cedar" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "write-1",
            toolName: "write",
            input: { path: "report.txt", content: "Cedar" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "write-1",
            toolName: "write",
            output: { ok: true, path: "report.txt" },
          },
        ],
      },
      { role: "assistant", content: "The report is saved." },
      latest,
    ];

    await createAntigravityRuntime({ platform: "linux" }).runTurn(
      makeParams(makeConfig(homeDir), {
        messages: [latest],
        allMessages,
      }),
    );

    const prompt = JSON.stringify(capturedPrompt);
    expect(prompt).toContain("Cedar");
    expect(prompt).toContain("write-1");
    expect(prompt).toContain("report.txt");
    expect(prompt).toContain("The report is saved.");
    expect(prompt).toContain("continue, do not repeat it");
  });

  test("passes image bytes as native SDK media rather than an image placeholder", async () => {
    const homeDir = await fs.mkdtemp(path.join(scratchRoots()[0]!, "antigravity-media-"));
    let capturedPrompt: unknown;
    (Agent as any).__setChatMockImpl(async (prompt: unknown) => {
      capturedPrompt = prompt;
      return {
        getChunks: async function* () {
          yield new Text(0, "image received");
        },
      };
    });
    process.env.GEMINI_API_KEY = "test-key";
    await createAntigravityRuntime({ platform: "linux" }).runTurn(
      makeParams(makeConfig(homeDir), {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this" },
              { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
            ],
          },
        ],
      }),
    );
    expect(capturedPrompt).toEqual(
      expect.arrayContaining([{ inlineData: { data: "aW1hZ2U=", mimeType: "image/png" } }]),
    );
  });

  test("uses the bounded overflow result for SDK continuation and returned history", async () => {
    const homeDir = await fs.mkdtemp(path.join(scratchRoots()[0]!, "antigravity-overflow-"));
    const originalOutput = "x".repeat(20_000);
    let sdkOutput: any;
    (Agent as any).__setChatMockImpl(async () => ({
      getChunks: async function* () {
        sdkOutput = await (Agent as any).getLastInstance().config.tools[0].execute({});
        yield new Text(0, "done");
      },
    }));
    process.env.GEMINI_API_KEY = "test-key";
    try {
      const result = await createAntigravityRuntime({ platform: "linux" }).runTurn(
        makeParams(makeConfig(homeDir, { toolOutputOverflowChars: 100 }), {
          tools: { lookup: { execute: async () => originalOutput } },
        }),
      );
      expect(sdkOutput.overflow).toBe(true);
      expect(await fs.readFile(sdkOutput.filePath, "utf8")).toBe(originalOutput);
      const toolMessage = result.responseMessages.find((message) => message.role === "tool");
      expect((toolMessage?.content as any[] | undefined)?.[0]?.output).toEqual(sdkOutput);
      expect(JSON.stringify(result.responseMessages)).not.toContain(originalOutput);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  test.each(["chat", "chunks", "eof"] as const)(
    "Stop cancels a stalled %s without reporting success",
    async (phase) => {
      const homeDir = await fs.mkdtemp(path.join(scratchRoots()[0]!, "antigravity-stream-stop-"));
      const waiting = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const controller = new AbortController();
      const onModelAbort = mock(async () => {});
      const emitted: any[] = [];
      (Agent as any).__setChatMockImpl(async () => {
        if (phase === "chat") {
          waiting.resolve();
          await release.promise;
        }
        return {
          getChunks: async function* () {
            if (phase !== "chat") {
              waiting.resolve();
              await release.promise;
            }
            if (phase === "eof") controller.abort();
          },
        };
      });
      process.env.GEMINI_API_KEY = "test-key";
      const turn = createAntigravityRuntime({ platform: "linux" }).runTurn(
        makeParams(makeConfig(homeDir), {
          abortSignal: controller.signal,
          onModelAbort,
          onModelStreamPart: (part) => {
            emitted.push(part);
          },
        }),
      );
      await waiting.promise;
      if (phase === "eof") release.resolve();
      else controller.abort();
      try {
        const result = await boundedOutcome(turn);
        expect(result.kind).toBe("rejected");
        expect(onModelAbort).toHaveBeenCalledTimes(1);
        expect(emitted.some((part) => part.type === "finish")).toBe(false);
      } finally {
        release.resolve();
        await turn.catch(() => {});
      }
    },
  );

  test.each(["failure", "abort"] as const)(
    "disposes the partial startup child on %s and stops a late connection",
    async (outcome) => {
      const homeDir = await fs.mkdtemp(path.join(scratchRoots()[0]!, "antigravity-child-stop-"));
      const child = { pid: 123, exitCode: null as number | null, signalCode: null };
      const killProcess = mock(async () => {
        child.exitCode = 137;
      });
      const startup = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const lateStopped = Promise.withResolvers<void>();
      const controller = new AbortController();
      (Agent as any).__setStartMockImpl(async (agent: any) => {
        agent._strategy = { childProcess: child };
        started.resolve();
        if (outcome === "failure") throw new Error("handshake failed");
        await startup.promise;
      });
      (Agent as any).__setStopMockImpl((agent: any) => {
        if (agent.isConnected) lateStopped.resolve();
      });
      process.env.GEMINI_API_KEY = "test-key";
      const turn = createAntigravityRuntime({ platform: "linux", killProcess }).runTurn(
        makeParams(makeConfig(homeDir), { abortSignal: controller.signal }),
      );
      const settled = boundedOutcome(turn);
      await started.promise;
      if (outcome === "abort") controller.abort();
      try {
        expect((await settled).kind).toBe("rejected");
        expect(killProcess).toHaveBeenCalledTimes(1);
        startup.resolve();
        if (outcome === "abort") {
          expect((await boundedOutcome(lateStopped.promise)).kind).toBe("resolved");
          expect((Agent as any).getLastInstance().isConnected).toBe(false);
        }
      } finally {
        startup.resolve();
        await turn.catch(() => {});
      }
    },
  );

  test("preserves partial text and usage when a stream fails", async () => {
    const homeDir = await fs.mkdtemp(path.join(scratchRoots()[0]!, "antigravity-partial-"));
    const onModelError = mock(async () => {});
    (Agent as any).__setChatMockImpl(async () => ({
      getChunks: async function* () {
        yield new Text(0, "partial answer");
        throw new Error("stream failed");
      },
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }));
    process.env.GEMINI_API_KEY = "test-key";
    const result = await boundedOutcome(
      createAntigravityRuntime({ platform: "linux" }).runTurn(
        makeParams(makeConfig(homeDir), { onModelError }),
      ),
    );
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect((result.error as any).responseMessages).toEqual([
        { role: "assistant", content: [{ type: "text", text: "partial answer" }] },
      ]);
      expect((result.error as any).usage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });
    }
    expect(onModelError).toHaveBeenCalledTimes(1);
  });

  test("bounds SDK stop and kills the owned child when disconnect never settles", async () => {
    const homeDir = await fs.mkdtemp(path.join(scratchRoots()[0]!, "antigravity-stalled-stop-"));
    const child = { pid: 123, exitCode: null as number | null, signalCode: null };
    const releaseStop = Promise.withResolvers<void>();
    const killProcess = mock(async () => {
      child.exitCode = 137;
    });
    (Agent as any).__setStartMockImpl((agent: any) => {
      agent._strategy = { childProcess: child };
    });
    (Agent as any).__setStopMockImpl(async () => await releaseStop.promise);
    (Agent as any).__setChatMockImpl(async () => ({
      getChunks: async function* () {
        yield new Text(0, "done");
      },
    }));
    process.env.GEMINI_API_KEY = "test-key";
    const turn = createAntigravityRuntime({ platform: "linux", killProcess }).runTurn(
      makeParams(makeConfig(homeDir)),
    );
    try {
      const result = await boundedOutcome(turn, 750);
      expect(result.kind).toBe("resolved");
      expect(killProcess).toHaveBeenCalledWith(123);
      expect(child.exitCode).toBe(137);
    } finally {
      releaseStop.resolve();
      await turn;
    }
  });

  test.each(["text-delta", "finish"])(
    "Stop interrupts a stalled %s delivery",
    async (blockedType) => {
      const homeDir = await fs.mkdtemp(path.join(scratchRoots()[0]!, "antigravity-delivery-stop-"));
      const blocked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const controller = new AbortController();
      (Agent as any).__setChatMockImpl(async () => ({
        getChunks: async function* () {
          yield new Text(0, "answer");
        },
      }));
      process.env.GEMINI_API_KEY = "test-key";
      const turn = createAntigravityRuntime({ platform: "linux" }).runTurn(
        makeParams(makeConfig(homeDir), {
          abortSignal: controller.signal,
          onModelStreamPart: async (part: any) => {
            if (part.type === blockedType) {
              blocked.resolve();
              await release.promise;
            }
          },
        }),
      );
      await blocked.promise;
      controller.abort();
      try {
        expect((await boundedOutcome(turn)).kind).toBe("rejected");
        expect((Agent as any).getLastInstance().isConnected).toBe(false);
      } finally {
        release.resolve();
        await turn.catch(() => {});
      }
    },
  );
});
