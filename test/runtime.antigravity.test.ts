import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
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
  let lastCreatedInstance: any = null;

  class MockAgent {
    static __setChatMockImpl(impl: typeof chatMockImpl) {
      chatMockImpl = impl;
    }

    static __setStartMockImpl(impl: typeof startMockImpl) {
      startMockImpl = impl;
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

describe("antigravity runtime", () => {
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

    (Agent as any).__setChatMockImpl(async (prompt: string) => {
      return {
        getChunks: async function* () {
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
    const turnPromise = runtime.runTurn(params);

    await new Promise((r) => setTimeout(r, 50));

    const capturedAgent = (Agent as any).getLastInstance();
    expect(capturedAgent).toBeDefined();
    const testTool = capturedAgent.config.tools.find((t: any) => t.name === "testTool");
    expect(testTool).toBeDefined();

    const toolResult = await testTool.execute({ val: "hello-tool" });
    expect(toolResult).toBe("tool result content");
    expect(toolExecuted).toBe(true);
    expect(toolInputReceived).toEqual({ val: "hello-tool" });

    const result = await turnPromise;

    expect(result.text).toBe("Tool executed successfully.");
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
  });

  test("validates Zod tool input before executing model-supplied arguments", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-test-"));
    const runtime = createAntigravityRuntime({ platform: "linux" });
    let executeCalls = 0;

    (Agent as any).__setChatMockImpl(async () => {
      return {
        getChunks: async function* () {
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
    const turnPromise = runtime.runTurn(params);

    await new Promise((r) => setTimeout(r, 50));

    const capturedAgent = (Agent as any).getLastInstance();
    expect(capturedAgent).toBeDefined();
    const boundedTool = capturedAgent.config.tools.find((t: any) => t.name === "boundedTool");
    expect(boundedTool).toBeDefined();

    await expect(boundedTool.execute({ limit: 6 })).rejects.toThrow(/5|less than or equal|Too big/);

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

    const result = await turnPromise;
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

  test("antigravity local harness startup sees the prepared tool env", async () => {
    const runtime = createAntigravityRuntime({ platform: "linux" });
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-env-"));
    const previousSoffice = process.env.COWORK_SOFFICE;
    let capturedSoffice: string | undefined;

    (Agent as any).__setChatMockImpl(async () => ({
      getChunks: async function* () {
        yield new Text(0, "Mocked response");
      },
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    }));
    (Agent as any).__setStartMockImpl(() => {
      capturedSoffice = process.env.COWORK_SOFFICE;
    });

    try {
      process.env.GEMINI_API_KEY = "test-key";
      process.env.COWORK_SOFFICE = "outside";

      await runtime.runTurn(
        makeParams(makeConfig(homeDir), {
          toolEnv: {
            COWORK_SOFFICE: "/tmp/cowork-managed-bin/soffice",
          },
        }),
      );

      expect(capturedSoffice).toBe("/tmp/cowork-managed-bin/soffice");
      expect(process.env.COWORK_SOFFICE).toBe("outside");
    } finally {
      (Agent as any).__setStartMockImpl(undefined);
      if (previousSoffice === undefined) {
        delete process.env.COWORK_SOFFICE;
      } else {
        process.env.COWORK_SOFFICE = previousSoffice;
      }
    }
  });
});
