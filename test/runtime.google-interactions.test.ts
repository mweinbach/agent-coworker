import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createGoogleInteractionsRuntime } from "../src/runtime/googleInteractionsRuntime";
import {
  __internal as googleNativeInternal,
  type GoogleNativeStepRequest,
  type GoogleNativeStepResult,
} from "../src/runtime/googleNativeInteractions";
import type { RuntimeRunTurnParams } from "../src/runtime/types";
import type { AgentConfig, ModelMessage } from "../src/types";

function makeConfig(homeDir: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
    workingDirectory: homeDir,
    outputDirectory: path.join(homeDir, "output"),
    uploadsDirectory: path.join(homeDir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectAgentDir: path.join(homeDir, ".agent-project"),
    userAgentDir: path.join(homeDir, ".agent"),
    builtInDir: homeDir,
    builtInConfigDir: path.join(homeDir, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    providerOptions: {
      google: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "high",
        },
      },
    },
    ...overrides,
  };
}

function makeParams(config: AgentConfig, overrides: Partial<RuntimeRunTurnParams> = {}): RuntimeRunTurnParams {
  return {
    config,
    system: "You are helpful.",
    messages: [{ role: "user", content: "hello" }] as ModelMessage[],
    tools: {},
    maxSteps: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Runtime tests
// ---------------------------------------------------------------------------

describe("google interactions runtime", () => {
  test("basic text response flows through runtime", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "google-interactions-test-"));
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async () => ({
        assistant: {
          role: "assistant",
          api: "google-interactions",
          provider: "google",
          model: "gemini-3-flash-preview",
          content: [
            { type: "text", text: "Hello! How can I help you?" },
          ],
          usage: { input: 10, output: 20, totalTokens: 30 },
          stopReason: "stop",
          timestamp: Date.now(),
        },
        interactionId: "interaction_abc123",
      }),
    });

    const result = await runtime.runTurn(makeParams(makeConfig(homeDir)));

    expect(result.text).toBe("Hello! How can I help you?");
    expect(result.responseMessages.length).toBeGreaterThan(0);
    expect(result.responseMessages[0].role).toBe("assistant");
  });

  test("thinking content is extracted as reasoningText", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "google-interactions-reasoning-"));
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async () => ({
        assistant: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me think about this..." },
            { type: "text", text: "Here is the answer." },
          ],
          usage: { input: 10, output: 30, totalTokens: 40 },
          stopReason: "stop",
          timestamp: Date.now(),
        },
        interactionId: "interaction_reason",
      }),
    });

    const result = await runtime.runTurn(makeParams(makeConfig(homeDir)));

    expect(result.text).toBe("Here is the answer.");
    expect(result.reasoningText).toBe("Let me think about this...");
  });

  test("tool calls trigger tool execution and multi-step loop", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "google-interactions-tools-"));
    let stepCount = 0;
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async () => {
        stepCount += 1;
        if (stepCount === 1) {
          return {
            assistant: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "call_1",
                  name: "testTool",
                  arguments: { query: "test" },
                },
              ],
              usage: { input: 10, output: 5, totalTokens: 15 },
              stopReason: "tool_calls",
              timestamp: Date.now(),
            },
            interactionId: "interaction_step1",
          };
        }
        return {
          assistant: {
            role: "assistant",
            content: [
              { type: "text", text: "Tool result received." },
            ],
            usage: { input: 20, output: 10, totalTokens: 30 },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          interactionId: "interaction_step2",
        };
      },
    });

    let toolExecuted = false;
    const result = await runtime.runTurn(makeParams(makeConfig(homeDir), {
      maxSteps: 5,
      tools: {
        testTool: {
          description: "A test tool",
          inputSchema: undefined,
          execute: async (input: unknown) => {
            toolExecuted = true;
            return { type: "text", value: "tool result" };
          },
        },
      },
    }));

    expect(toolExecuted).toBe(true);
    expect(stepCount).toBe(2);
    expect(result.text).toBe("Tool result received.");
  });

  test("usage is accumulated across multiple steps", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "google-interactions-usage-"));
    let step = 0;
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async () => {
        step += 1;
        if (step === 1) {
          return {
            assistant: {
              role: "assistant",
              content: [
                { type: "toolCall", id: "call_1", name: "testTool", arguments: {} },
              ],
              usage: { input: 100, output: 10, totalTokens: 110 },
              stopReason: "tool_calls",
              timestamp: Date.now(),
            },
            interactionId: "i1",
          };
        }
        return {
          assistant: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            usage: { input: 200, output: 20, totalTokens: 220 },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          interactionId: "i2",
        };
      },
    });

    const result = await runtime.runTurn(makeParams(makeConfig(homeDir), {
      maxSteps: 5,
      tools: {
        testTool: {
          description: "test",
          inputSchema: undefined,
          execute: async () => "ok",
        },
      },
    }));

    expect(result.usage).toBeDefined();
    expect(result.usage!.promptTokens).toBeGreaterThan(0);
    expect(result.usage!.totalTokens).toBeGreaterThan(0);
  });

  test("emits start-step and finish-step stream parts", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "google-interactions-parts-"));
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async () => ({
        assistant: {
          role: "assistant",
          content: [{ type: "text", text: "Hi" }],
          usage: { input: 5, output: 5, totalTokens: 10 },
          stopReason: "stop",
          timestamp: Date.now(),
        },
        interactionId: "i",
      }),
    });

    const streamParts: unknown[] = [];
    await runtime.runTurn(makeParams(makeConfig(homeDir), {
      onModelStreamPart: async (part) => {
        streamParts.push(part);
      },
    }));

    const types = streamParts.map((p) => (p as Record<string, unknown>).type);
    expect(types).toContain("start-step");
    expect(types).toContain("finish-step");
  });

  test("error in model step propagates and calls onModelError", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "google-interactions-err-"));
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async () => {
        throw new Error("API rate limit exceeded");
      },
    });

    let errorCaught: unknown;
    try {
      await runtime.runTurn(makeParams(makeConfig(homeDir), {
        onModelError: async (error) => {
          errorCaught = error;
        },
      }));
    } catch (error) {
      expect((error as Error).message).toBe("API rate limit exceeded");
    }

    expect(errorCaught).toBeDefined();
    expect((errorCaught as Error).message).toBe("API rate limit exceeded");
  });

  test("runtime name is google-interactions", () => {
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async () => ({
        assistant: { role: "assistant", content: [], stopReason: "stop", timestamp: Date.now() },
        interactionId: "i",
      }),
    });
    expect(runtime.name).toBe("google-interactions");
  });
});

// ---------------------------------------------------------------------------
// Native interactions step tests (request building)
// ---------------------------------------------------------------------------

describe("google native interactions request building", () => {
  test("buildGoogleNativeRequest produces correct structure", () => {
    const request = googleNativeInternal.buildGoogleNativeRequest({
      model: {
        id: "gemini-3-flash-preview",
        name: "Gemini 3 Flash Preview",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_048_576,
        maxTokens: 65_536,
      },
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "Hello" }] as ModelMessage[],
      tools: [{ name: "bash", description: "Run bash commands", parameters: { type: "object" } }],
      streamOptions: {
        thinkingLevel: "high",
        temperature: 0.7,
      },
    });

    expect(request.model).toBe("gemini-3-flash-preview");
    expect(request.system_instruction).toBe("You are helpful.");
    expect(request.stream).toBe(true);
    expect(request.store).toBe(true);
    expect(Array.isArray(request.input)).toBe(true);
    expect(Array.isArray(request.tools)).toBe(true);

    const genConfig = request.generation_config as Record<string, unknown>;
    expect(genConfig.thinking_level).toBe("high");
    expect(genConfig.temperature).toBe(0.7);
  });

  test("convertMessagesToInteractionsInput handles user messages", () => {
    const input = googleNativeInternal.convertMessagesToInteractionsInput([
      { role: "user", content: "Hello world" },
    ] as ModelMessage[]);

    expect(input).toEqual([{ type: "text", text: "Hello world" }]);
  });

  test("convertMessagesToInteractionsInput handles assistant tool calls", () => {
    const input = googleNativeInternal.convertMessagesToInteractionsInput([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_123|fc_456",
            toolName: "bash",
            input: { command: "ls" },
          },
        ],
      },
    ] as ModelMessage[]);

    expect(input.length).toBe(1);
    expect(input[0].type).toBe("function_call");
    expect(input[0].id).toBe("call_123");
    expect(input[0].name).toBe("bash");
    expect(input[0].arguments).toEqual({ command: "ls" });
  });

  test("convertMessagesToInteractionsInput handles tool results", () => {
    const input = googleNativeInternal.convertMessagesToInteractionsInput([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_123|fc_456",
            toolName: "bash",
            output: { type: "text", value: "file.txt" },
            isError: false,
          },
        ],
      },
    ] as ModelMessage[]);

    expect(input.length).toBe(1);
    expect(input[0].type).toBe("function_result");
    expect(input[0].call_id).toBe("call_123");
    expect(input[0].is_error).toBe(false);
  });

  test("convertToolsToInteractionsTools maps to function type", () => {
    const tools = googleNativeInternal.convertToolsToInteractionsTools([
      { name: "readFile", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
    ]);

    expect(tools.length).toBe(1);
    expect(tools[0].type).toBe("function");
    expect(tools[0].name).toBe("readFile");
    expect(tools[0].description).toBe("Read a file");
  });

  test("processStreamEvent accumulates text content", () => {
    const blocks = new Map();

    googleNativeInternal.processStreamEvent(
      { event_type: "content.start", index: 0, content: { type: "text", text: "" } },
      blocks,
    );
    googleNativeInternal.processStreamEvent(
      { event_type: "content.delta", index: 0, delta: { type: "text", text: "Hello" } },
      blocks,
    );
    googleNativeInternal.processStreamEvent(
      { event_type: "content.delta", index: 0, delta: { type: "text", text: " world" } },
      blocks,
    );

    const block = blocks.get(0);
    expect(block).toBeDefined();
    expect(block.type).toBe("text");
    expect(block.text).toBe("Hello world");
  });

  test("processStreamEvent handles function_call content", () => {
    const blocks = new Map();

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 0,
        content: {
          type: "function_call",
          id: "call_abc",
          name: "readFile",
          arguments: { path: "/tmp/test.txt" },
        },
      },
      blocks,
    );

    const block = blocks.get(0);
    expect(block).toBeDefined();
    expect(block.type).toBe("toolCall");
    expect(block.id).toBe("call_abc");
    expect(block.name).toBe("readFile");
    expect(block.arguments).toEqual({ path: "/tmp/test.txt" });
  });

  test("processStreamEvent handles thought content with signature", () => {
    const blocks = new Map();

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 0,
        content: { type: "thought", signature: "sig_abc" },
      },
      blocks,
    );
    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.delta",
        index: 0,
        delta: { type: "thought_summary", content: { type: "text", text: "Thinking about it..." } },
      },
      blocks,
    );
    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.delta",
        index: 0,
        delta: { type: "thought_signature", signature: "sig_final" },
      },
      blocks,
    );

    const block = blocks.get(0);
    expect(block).toBeDefined();
    expect(block.type).toBe("thinking");
    expect(block.thinking).toBe("Thinking about it...");
    expect(block.thinkingSignature).toBe("sig_final");
  });

  test("resolveGoogleApiKey throws when no key is available", () => {
    const origEnv1 = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const origEnv2 = process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    try {
      expect(() => googleNativeInternal.resolveGoogleApiKey()).toThrow("No API key");
    } finally {
      if (origEnv1) process.env.GOOGLE_GENERATIVE_AI_API_KEY = origEnv1;
      if (origEnv2) process.env.GOOGLE_API_KEY = origEnv2;
    }
  });

  test("resolveGoogleApiKey uses explicit key when provided", () => {
    expect(googleNativeInternal.resolveGoogleApiKey("my-key")).toBe("my-key");
  });
});
