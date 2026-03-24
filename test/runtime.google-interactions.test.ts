import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { __internal as citationMetadataInternal } from "../src/server/citationMetadata";
import { createGoogleInteractionsRuntime } from "../src/runtime/googleInteractionsRuntime";
import { buildGooglePrepareStep } from "../src/providers/googleReplay";
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
    expect(result.providerState).toEqual({
      provider: "google",
      model: "gemini-3-flash-preview",
      interactionId: "interaction_abc123",
      updatedAt: expect.any(String),
    });
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

  test("native Google tool blocks are preserved in responseMessages", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "google-interactions-native-history-"));
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async () => ({
        assistant: {
          role: "assistant",
          content: [
            {
              type: "providerToolCall",
              id: "gs_1",
              name: "nativeWebSearch",
              arguments: { queries: ["latest Gemini announcements"] },
              thoughtSignature: "sig_call",
            },
            {
              type: "providerToolResult",
              callId: "gs_1",
              name: "nativeWebSearch",
              result: [{ search_suggestions: "Latest Gemini announcements" }],
              thoughtSignature: "sig_result",
            },
            { type: "text", text: "Here is the latest." },
          ],
          usage: { input: 10, output: 20, totalTokens: 30 },
          stopReason: "stop",
          timestamp: Date.now(),
        },
        interactionId: "interaction_native_history",
      }),
    });

    const result = await runtime.runTurn(makeParams(makeConfig(homeDir)));

    expect(result.responseMessages).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "providerToolCall",
            id: "gs_1",
            name: "nativeWebSearch",
            arguments: { queries: ["latest Gemini announcements"] },
            thoughtSignature: "sig_call",
            providerOptions: { google: { thoughtSignature: "sig_call" } },
          },
          {
            type: "providerToolResult",
            callId: "gs_1",
            name: "nativeWebSearch",
            result: [{ search_suggestions: "Latest Gemini announcements" }],
            thoughtSignature: "sig_result",
            providerOptions: { google: { thoughtSignature: "sig_result" } },
          },
          { type: "text", text: "Here is the latest." },
        ],
      },
    ]);
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

  test("reuses previousInteractionId and only sends new messages when Google continuation state matches", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "google-interactions-continuation-"));
    const seenRequests: GoogleNativeStepRequest[] = [];
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async (opts) => {
        seenRequests.push(opts);
        return {
          assistant: {
            role: "assistant",
            api: "google-interactions",
            provider: "google",
            model: "gemini-3-flash-preview",
            content: [{ type: "text", text: "Follow-up answer" }],
            usage: { input: 5, output: 7, totalTokens: 12 },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          interactionId: "interaction_next",
        };
      },
    });

    const result = await runtime.runTurn(makeParams(makeConfig(homeDir), {
      messages: [
        { role: "user", content: "Find the latest pricing" },
        { role: "assistant", content: [{ type: "text", text: "Here are the latest prices." }] },
        { role: "user", content: "Open the second result" },
      ] as ModelMessage[],
      allMessages: [
        { role: "user", content: "Find the latest pricing" },
        { role: "assistant", content: [{ type: "text", text: "Here are the latest prices." }] },
        { role: "user", content: "Open the second result" },
      ] as ModelMessage[],
      providerState: {
        provider: "google",
        model: "gemini-3-flash-preview",
        interactionId: "interaction_prev",
        updatedAt: "2026-03-18T12:00:00.000Z",
      },
    }));

    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?.previousInteractionId).toBe("interaction_prev");
    expect(seenRequests[0]?.messages).toEqual([
      { role: "user", content: "Open the second result" },
    ]);
    expect(result.providerState).toEqual({
      provider: "google",
      model: "gemini-3-flash-preview",
      interactionId: "interaction_next",
      updatedAt: expect.any(String),
    });
  });

  test("prepareStep providerOptions overrides control thought summaries for the step", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "google-interactions-step-opts-"));
    const seenStreamOptions: Array<Record<string, unknown>> = [];
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async (opts) => {
        seenStreamOptions.push(opts.streamOptions as Record<string, unknown>);
        return {
          assistant: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
            timestamp: Date.now(),
          },
          interactionId: "step-opts",
        };
      },
    });

    await runtime.runTurn(makeParams(makeConfig(homeDir), {
      prepareStep: async () => ({
        providerOptions: {
          google: {
            thinkingConfig: {
              includeThoughts: false,
              thinkingLevel: "high",
            },
          },
        },
      }),
    }));

    expect(seenStreamOptions).toHaveLength(1);
    expect(seenStreamOptions[0]?.thinkingLevel).toBe("high");
    expect(seenStreamOptions[0]?.thinkingSummaries).toBe("none");
  });

  test("multi-step replay keeps Gemini thought signatures and thought summaries enabled", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "google-interactions-thought-replay-"));
    const seenStreamOptions: Array<Record<string, unknown>> = [];
    const prepareLogs: string[] = [];
    let stepCount = 0;
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async (opts) => {
        stepCount += 1;
        seenStreamOptions.push(opts.streamOptions as Record<string, unknown>);
        if (stepCount === 1) {
          return {
            assistant: {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinking: "Let me think through the plan.",
                  thinkingSignature: "sig_thought_1",
                },
                {
                  type: "toolCall",
                  id: "call_1",
                  name: "testTool",
                  arguments: { query: "latest release" },
                  thoughtSignature: "sig_tool_1",
                },
              ],
              usage: { input: 10, output: 10, totalTokens: 20 },
              stopReason: "tool_calls",
              timestamp: Date.now(),
            },
            interactionId: "interaction_step_1",
          };
        }

        return {
          assistant: {
            role: "assistant",
            content: [{ type: "text", text: "Done." }],
            usage: { input: 10, output: 5, totalTokens: 15 },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          interactionId: "interaction_step_2",
        };
      },
    });

    const prepareStep = buildGooglePrepareStep(
      { google: { thinkingConfig: { includeThoughts: true } } },
      (line) => prepareLogs.push(line),
    );

    const result = await runtime.runTurn(makeParams(makeConfig(homeDir), {
      maxSteps: 5,
      prepareStep,
      tools: {
        testTool: {
          description: "test",
          inputSchema: undefined,
          execute: async () => ({ type: "text", value: "tool result" }),
        },
      },
    }));

    expect(seenStreamOptions).toHaveLength(2);
    expect(seenStreamOptions[0]?.thinkingSummaries).toBe("auto");
    expect(seenStreamOptions[1]?.thinkingSummaries).toBe("auto");
    expect(prepareLogs).toEqual([]);
    expect(result.responseMessages[0]).toEqual({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "Let me think through the plan.",
          thinkingSignature: "sig_thought_1",
          providerOptions: { google: { thoughtSignature: "sig_thought_1" } },
        },
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "testTool",
          input: { query: "latest release" },
          thoughtSignature: "sig_tool_1",
          providerOptions: { google: { thoughtSignature: "sig_tool_1" } },
        },
      ],
    });
  });

  test("subsequent Google interaction steps only send incremental follow-up messages", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "google-interactions-delta-"));
    const seenMessages: ModelMessage[][] = [];
    let stepCount = 0;
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async (opts) => {
        stepCount += 1;
        seenMessages.push(opts.messages);
        if (stepCount === 1) {
          return {
            assistant: {
              role: "assistant",
              content: [
                { type: "toolCall", id: "call_1", name: "testTool", arguments: { query: "test" } },
              ],
              stopReason: "tool_calls",
              timestamp: Date.now(),
            },
            interactionId: "interaction_step1",
          };
        }
        return {
          assistant: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
            timestamp: Date.now(),
          },
          interactionId: "interaction_step2",
        };
      },
    });

    await runtime.runTurn(makeParams(makeConfig(homeDir), {
      maxSteps: 5,
      tools: {
        testTool: {
          description: "A test tool",
          inputSchema: undefined,
          execute: async () => ({ type: "text", value: "tool result" }),
        },
      },
    }));

    expect(seenMessages).toHaveLength(2);
    expect(seenMessages[0]?.[0]?.role).toBe("user");
    expect(seenMessages[1]).toHaveLength(1);
    expect(seenMessages[1]?.[0]?.role).toBe("tool");
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

  test("emits a single turn start and finish across a multi-step tool loop", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "google-interactions-turn-boundary-"));
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
            content: [{ type: "text", text: "Tool result received." }],
            usage: { input: 20, output: 10, totalTokens: 30 },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          interactionId: "interaction_step2",
        };
      },
    });

    const streamParts: Array<Record<string, unknown>> = [];
    await runtime.runTurn(makeParams(makeConfig(homeDir), {
      maxSteps: 5,
      tools: {
        testTool: {
          description: "A test tool",
          inputSchema: undefined,
          execute: async () => ({ type: "text", value: "tool result" }),
        },
      },
      onModelStreamPart: async (part) => {
        streamParts.push(part as Record<string, unknown>);
      },
    }));

    const types = streamParts.map((part) => part.type);
    expect(types.filter((type) => type === "start")).toHaveLength(1);
    expect(types.filter((type) => type === "finish")).toHaveLength(1);
    expect(types[0]).toBe("start");
    expect(types[types.length - 1]).toBe("finish");

    const finishPart = streamParts[streamParts.length - 1]!;
    expect(finishPart.finishReason).toBe("stop");
    expect(finishPart.totalUsage).toMatchObject({
      promptTokens: 30,
      completionTokens: 15,
      totalTokens: 45,
    });
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
    expect((request.input as Array<Record<string, unknown>>)[0]).toEqual({
      role: "user",
      content: "Hello",
    });

    const genConfig = request.generation_config as Record<string, unknown>;
    expect(genConfig.thinking_level).toBe("high");
    expect(genConfig.temperature).toBe(0.7);
  });

  test("buildGoogleNativeRequest adds Google Search and URL Context when native web search is enabled", () => {
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
      messages: [{ role: "user", content: "Find coffee shops near me" }] as ModelMessage[],
      tools: [
        { name: "bash", description: "Run bash commands", parameters: { type: "object" } },
        { name: "webFetch", description: "Fetch a web page", parameters: { type: "object" } },
      ],
      streamOptions: {
        nativeWebSearch: true,
      },
    });

    expect(request.tools).toEqual([
      { type: "function", name: "bash", description: "Run bash commands", parameters: { type: "object" } },
      { type: "function", name: "webFetch", description: "Fetch a web page", parameters: { type: "object" } },
      { type: "google_search", search_types: ["web_search"] },
      { type: "url_context" },
    ]);
  });

  test("buildGoogleNativeRequest omits provider-native Google tools when no web-capable tool survives filtering", () => {
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
      messages: [{ role: "user", content: "Find coffee shops near me and read their websites" }] as ModelMessage[],
      tools: [{ name: "bash", description: "Run bash commands", parameters: { type: "object" } }],
      streamOptions: {
        nativeWebSearch: true,
      },
    });

    expect(request.tools).toEqual([
      { type: "function", name: "bash", description: "Run bash commands", parameters: { type: "object" } },
    ]);
  });

  test("unsupported Gemini thinking levels are omitted for the selected model", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "google-interactions-thinking-"));
    const seenStreamOptions: Array<Record<string, unknown>> = [];
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async (opts) => {
        seenStreamOptions.push({ ...opts.streamOptions });
        return {
          assistant: {
            role: "assistant",
            api: "google-interactions",
            provider: "google",
            model: "gemini-3.1-pro-preview",
            content: [{ type: "text", text: "ok" }],
            usage: { input: 1, output: 1, totalTokens: 2 },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          interactionId: "omit-unsupported-thinking",
        };
      },
    });

    await runtime.runTurn(makeParams(makeConfig(homeDir, {
      model: "gemini-3.1-pro-preview",
      preferredChildModel: "gemini-3.1-pro-preview",
      providerOptions: {
        google: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: "minimal",
          },
        },
      },
    })));

    expect(seenStreamOptions).toHaveLength(1);
    expect(seenStreamOptions[0]?.thinkingLevel).toBeUndefined();
    expect(seenStreamOptions[0]?.thinkingSummaries).toBe("auto");
  });

  test("convertMessagesToInteractionsInput preserves roleful conversation turns", () => {
    const input = googleNativeInternal.convertMessagesToInteractionsInput([
      { role: "user", content: "Hello world" },
      { role: "assistant", content: [{ type: "text", text: "Hi there." }] },
      { role: "user", content: "What is my name?" },
    ] as ModelMessage[]);

    expect(input).toEqual([
      { role: "user", content: "Hello world" },
      { role: "model", content: [{ type: "text", text: "Hi there." }] },
      { role: "user", content: "What is my name?" },
    ]);
  });

  test("convertMessagesToInteractionsInput preserves assistant string turns", () => {
    const input = googleNativeInternal.convertMessagesToInteractionsInput([
      { role: "user", content: "Hello world" },
      { role: "assistant", content: "Hi there." },
      { role: "user", content: "What did you just say?" },
    ] as ModelMessage[]);

    expect(input).toEqual([
      { role: "user", content: "Hello world" },
      { role: "model", content: "Hi there." },
      { role: "user", content: "What did you just say?" },
    ]);
  });

  test("convertMessagesToInteractionsInput preserves assistant output_text parts", () => {
    const input = googleNativeInternal.convertMessagesToInteractionsInput([
      {
        role: "assistant",
        content: [{ type: "output_text", text: "Saved response." }],
      },
    ] as ModelMessage[]);

    expect(input).toEqual([
      {
        role: "model",
        content: [{ type: "text", text: "Saved response." }],
      },
    ]);
  });

  test("convertMessagesToInteractionsInput preserves multimodal user input", () => {
    const input = googleNativeInternal.convertMessagesToInteractionsInput([
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image" },
          { type: "image", data: "abc123", mimeType: "image/png" },
        ],
      },
    ] as ModelMessage[]);

    expect(input).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image" },
          { type: "image", data: "abc123", mime_type: "image/png" },
        ],
      },
    ]);
  });

  test("convertMessagesToInteractionsInput handles assistant tool calls with repaired thought signatures", () => {
    const input = googleNativeInternal.convertMessagesToInteractionsInput([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_123|fc_456",
            toolName: "bash",
            input: { command: "ls" },
            providerOptions: { google: { thoughtSignature: "sig_123" } },
          },
        ],
      },
    ] as ModelMessage[]);

    expect(input.length).toBe(1);
    expect(input[0]).toEqual({
      role: "model",
      content: [
        {
          type: "function_call",
          id: "call_123",
          name: "bash",
          arguments: { command: "ls" },
          signature: "sig_123",
        },
      ],
    });
  });

  test("convertMessagesToInteractionsInput round-trips native Google tool history", () => {
    const input = googleNativeInternal.convertMessagesToInteractionsInput([
      {
        role: "assistant",
        content: [
          {
            type: "providerToolCall",
            id: "gs_1",
            name: "nativeWebSearch",
            arguments: { queries: ["latest Gemini announcements"] },
            providerOptions: { google: { thoughtSignature: "sig_call" } },
          },
          {
            type: "providerToolResult",
            callId: "gs_1",
            name: "nativeWebSearch",
            result: [{ search_suggestions: "Latest Gemini announcements" }],
            providerOptions: { google: { thoughtSignature: "sig_result" } },
          },
          {
            type: "providerToolCall",
            id: "uc_1",
            name: "nativeUrlContext",
            arguments: { urls: ["https://example.com"] },
          },
          {
            type: "providerToolResult",
            callId: "uc_1",
            name: "nativeUrlContext",
            result: { url: "https://example.com", status: "ok" },
          },
        ],
      },
    ] as ModelMessage[]);

    expect(input).toEqual([
      {
        role: "model",
        content: [
          {
            type: "google_search_call",
            id: "gs_1",
            arguments: { queries: ["latest Gemini announcements"] },
            signature: "sig_call",
          },
          {
            type: "google_search_result",
            call_id: "gs_1",
            result: [{ search_suggestions: "Latest Gemini announcements" }],
            signature: "sig_result",
          },
          {
            type: "url_context_call",
            id: "uc_1",
            arguments: { urls: ["https://example.com"] },
          },
          {
            type: "url_context_result",
            call_id: "uc_1",
            result: { url: "https://example.com", status: "ok" },
          },
        ],
      },
    ]);
  });

  test("convertMessagesToInteractionsInput handles rich tool results", () => {
    const input = googleNativeInternal.convertMessagesToInteractionsInput([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_123|fc_456",
            toolName: "read",
            output: {
              type: "content",
              content: [
                { type: "text", text: "image attached" },
                { type: "image", data: "abc123", mimeType: "image/png" },
              ],
            },
            isError: false,
          },
        ],
      },
    ] as ModelMessage[]);

    expect(input).toEqual([
      {
        role: "user",
        content: [
          {
            type: "function_result",
            call_id: "call_123",
            name: "read",
            result: [
              { type: "text", text: "image attached" },
              { type: "image", data: "abc123", mime_type: "image/png" },
            ],
            is_error: false,
          },
        ],
      },
    ]);
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

  test("enrichTextBlockAnnotations resolves Google grounding redirects for final text blocks", async () => {
    const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    let fetchCalls = 0;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL) => {
        fetchCalls += 1;
        const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
        if (url.includes("/grounding-api-redirect/example")) {
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://www.foxnews.com/live-news/new-york-laguardia-plane-crash-march-23",
            },
          });
        }

        const response = new Response(
          `<html><head><title>LaGuardia collision: 2 pilots killed after Air Canada jet hits fire truck, forcing airport closure</title></head></html>`,
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
            },
          },
        );
        Object.defineProperty(response, "url", {
          configurable: true,
          value: "https://www.foxnews.com/live-news/new-york-laguardia-plane-crash-march-23",
        });
        return response;
      },
    });

    try {
      const block = {
        type: "text" as const,
        text: "Answer",
        annotations: [
          {
            type: "url_citation",
            url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/example",
            title: "foxnews.com",
            start_index: 0,
            end_index: 6,
          },
        ],
      };

      await googleNativeInternal.enrichTextBlockAnnotations(block);
      expect(fetchCalls).toBe(2);

      expect(block.annotations).toEqual([
        {
          type: "url_citation",
          url: "https://www.foxnews.com/live-news/new-york-laguardia-plane-crash-march-23",
          title: "LaGuardia collision: 2 pilots killed after Air Canada jet hits fire truck, forcing airport closure",
          start_index: 0,
          end_index: 6,
        },
      ]);
    } finally {
      citationMetadataInternal.clearCitationResolutionCache();
      if (originalFetchDescriptor) {
        Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
      }
    }
  });

  test("queueTextBlockAnnotationEnrichment keeps slow citation fetches off the text-end hot path", async () => {
    const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    const fetchStarted = Promise.withResolvers<void>();
    const responseGate = Promise.withResolvers<Response>();
    let fetchCalls = 0;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL) => {
        fetchCalls += 1;
        const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
        if (url.includes("/grounding-api-redirect/slow-example")) {
          fetchStarted.resolve();
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://www.foxnews.com/live-news/new-york-laguardia-plane-crash-march-23",
            },
          });
        }

        return await responseGate.promise;
      },
    });

    try {
      const block = {
        type: "text" as const,
        text: "Answer",
        annotations: [
          {
            type: "url_citation",
            url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/slow-example",
            title: "foxnews.com",
            start_index: 0,
            end_index: 6,
          },
        ],
      };
      const blocks = new Map([[0, block]]);
      const providerToolCallsById = new Map();
      const pendingAnnotationEnrichments: Array<Promise<void>> = [];

      googleNativeInternal.queueTextBlockAnnotationEnrichment(pendingAnnotationEnrichments, block);
      await fetchStarted.promise;
      expect(fetchCalls).toBe(1);

      expect(googleNativeInternal.mapGoogleEventToStreamParts(
        { event_type: "content.stop", index: 0 },
        blocks,
        providerToolCallsById,
      )).toEqual([
        {
          type: "text-end",
          id: "s0",
          annotations: [
            {
              type: "url_citation",
              url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/slow-example",
              title: "foxnews.com",
              start_index: 0,
              end_index: 6,
            },
          ],
        },
      ]);

      const response = new Response(
        `<html><head><title>LaGuardia collision: 2 pilots killed after Air Canada jet hits fire truck, forcing airport closure</title></head></html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        },
      );
      Object.defineProperty(response, "url", {
        configurable: true,
        value: "https://www.foxnews.com/live-news/new-york-laguardia-plane-crash-march-23",
      });
      responseGate.resolve(response);

      await Promise.all(pendingAnnotationEnrichments);
      expect(fetchCalls).toBe(2);

      expect(block.annotations).toEqual([
        {
          type: "url_citation",
          url: "https://www.foxnews.com/live-news/new-york-laguardia-plane-crash-march-23",
          title: "LaGuardia collision: 2 pilots killed after Air Canada jet hits fire truck, forcing airport closure",
          start_index: 0,
          end_index: 6,
        },
      ]);
    } finally {
      citationMetadataInternal.clearCitationResolutionCache();
      if (originalFetchDescriptor) {
        Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
      }
    }
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

  test("processStreamEvent updates function_call name from later delta", () => {
    const blocks = new Map();

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 0,
        content: {
          type: "function_call",
          id: "call_abc",
        },
      },
      blocks,
    );
    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.delta",
        index: 0,
        delta: {
          type: "function_call",
          name: "webSearch",
          arguments: { query: "NVIDIA GTC 2026 dates announcements keynote" },
          signature: "sig_call",
        },
      },
      blocks,
    );

    const block = blocks.get(0);
    expect(block).toBeDefined();
    expect(block.type).toBe("toolCall");
    expect(block.id).toBe("call_abc");
    expect(block.name).toBe("webSearch");
    expect(block.arguments).toEqual({ query: "NVIDIA GTC 2026 dates announcements keynote" });
    expect(block.thoughtSignature).toBe("sig_call");
  });

  test("processStreamEvent keeps the first emitted function_call id stable", () => {
    const blocks = new Map();

    const startEvent = {
      event_type: "content.start",
      index: 0,
      content: {
        type: "function_call",
        name: "bash",
      },
    };
    googleNativeInternal.processStreamEvent(startEvent, blocks);

    const startBlock = blocks.get(0);
    expect(startBlock).toBeDefined();
    expect(startBlock.type).toBe("toolCall");
    const fallbackId = startBlock.id;

    expect(googleNativeInternal.mapGoogleEventToStreamParts(startEvent, blocks)).toEqual([
      { type: "tool-input-start", id: fallbackId, toolName: "bash" },
    ]);

    const deltaEvent = {
      event_type: "content.delta",
      index: 0,
      delta: {
        type: "function_call",
        id: "call_real",
        arguments: { command: "ls" },
      },
    };
    googleNativeInternal.processStreamEvent(deltaEvent, blocks);

    const block = blocks.get(0);
    expect(block).toBeDefined();
    expect(block.type).toBe("toolCall");
    expect(block.id).toBe(fallbackId);
    expect(block.arguments).toEqual({ command: "ls" });

    expect(googleNativeInternal.mapGoogleEventToStreamParts(deltaEvent, blocks)).toEqual([
      { type: "tool-input-delta", id: fallbackId, delta: "{\"command\":\"ls\"}" },
    ]);

    expect(googleNativeInternal.mapGoogleEventToStreamParts(
      { event_type: "content.stop", index: 0 },
      blocks,
    )).toEqual([
      { type: "tool-input-end", id: fallbackId },
      { type: "tool-call", toolCallId: fallbackId, toolName: "bash", input: { command: "ls" } },
    ]);
  });

  test("processStreamEvent keeps the first emitted native provider tool id stable", () => {
    const blocks = new Map();
    const providerToolCallsById = new Map();

    const startEvent = {
      event_type: "content.start",
      index: 0,
      content: {
        type: "google_search_call",
      },
    };
    googleNativeInternal.processStreamEvent(startEvent, blocks, providerToolCallsById);

    const startBlock = blocks.get(0);
    expect(startBlock).toBeDefined();
    expect(startBlock.type).toBe("providerToolCall");
    const fallbackId = startBlock.id;

    expect(googleNativeInternal.mapGoogleEventToStreamParts(
      startEvent,
      blocks,
      providerToolCallsById,
    )).toEqual([
      { type: "tool-input-start", id: fallbackId, toolName: "nativeWebSearch", providerExecuted: true },
    ]);

    const deltaEvent = {
      event_type: "content.delta",
      index: 0,
      delta: {
        type: "google_search_call",
        id: "gs_real",
        arguments: { queries: ["latest Gemini announcements"] },
      },
    };
    googleNativeInternal.processStreamEvent(deltaEvent, blocks, providerToolCallsById);

    const block = blocks.get(0);
    expect(block).toBeDefined();
    expect(block.type).toBe("providerToolCall");
    expect(block.id).toBe(fallbackId);
    expect(block.arguments).toEqual({ queries: ["latest Gemini announcements"] });

    expect(googleNativeInternal.mapGoogleEventToStreamParts(
      deltaEvent,
      blocks,
      providerToolCallsById,
    )).toEqual([
      { type: "tool-input-delta", id: fallbackId, delta: "{\"queries\":[\"latest Gemini announcements\"]}" },
    ]);

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 1,
        content: {
          type: "google_search_result",
          call_id: "gs_real",
          result: [{ search_suggestions: "Latest Gemini announcements" }],
        },
      },
      blocks,
      providerToolCallsById,
    );

    expect(googleNativeInternal.mapGoogleEventToStreamParts(
      { event_type: "content.stop", index: 1 },
      blocks,
      providerToolCallsById,
    )).toEqual([
      {
        type: "tool-result",
        toolCallId: fallbackId,
        toolName: "nativeWebSearch",
        output: {
          provider: "google",
          status: "completed",
          callId: fallbackId,
          queries: ["latest Gemini announcements"],
          results: [{ search_suggestions: "Latest Gemini announcements" }],
          raw: [{ search_suggestions: "Latest Gemini announcements" }],
        },
        providerExecuted: true,
      },
    ]);
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

  test("processStreamEvent preserves thought summaries that arrive before thought start", () => {
    const blocks = new Map();

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.delta",
        index: 0,
        delta: { type: "thought_summary", content: { type: "text", text: "Buffered reasoning." } },
      },
      blocks,
    );
    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.delta",
        index: 0,
        delta: { type: "thought_signature", signature: "sig_buffered" },
      },
      blocks,
    );
    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 0,
        content: { type: "thought" },
      },
      blocks,
    );

    const block = blocks.get(0);
    expect(block).toBeDefined();
    expect(block.type).toBe("thinking");
    expect(block.thinking).toBe("Buffered reasoning.");
    expect(block.thinkingSignature).toBe("sig_buffered");
  });

  test("mapGoogleEventToStreamParts emits normalized model stream parts", () => {
    const blocks = new Map();

    googleNativeInternal.processStreamEvent(
      { event_type: "content.start", index: 0, content: { type: "text", text: "" } },
      blocks,
    );
    expect(googleNativeInternal.mapGoogleEventToStreamParts(
      { event_type: "content.start", index: 0, content: { type: "text", text: "" } },
      blocks,
    )).toEqual([{ type: "text-start", id: "s0" }]);

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 1,
        content: { type: "thought", signature: "sig_1" },
      },
      blocks,
    );
    expect(googleNativeInternal.mapGoogleEventToStreamParts(
      {
        event_type: "content.delta",
        index: 1,
        delta: { type: "thought_summary", content: { type: "text", text: "Thinking..." } },
      },
      blocks,
    )).toEqual([{ type: "reasoning-delta", id: "s1", text: "Thinking..." }]);

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 2,
        content: { type: "function_call", id: "call_1", name: "bash", arguments: { command: "ls" } },
      },
      blocks,
    );
    expect(googleNativeInternal.mapGoogleEventToStreamParts(
      {
        event_type: "content.stop",
        index: 2,
      },
      blocks,
    )).toEqual([
      { type: "tool-input-end", id: "call_1" },
      { type: "tool-call", toolCallId: "call_1", toolName: "bash", input: { command: "ls" } },
    ]);
  });

  test("mapGoogleEventToStreamParts emits tool calls with names learned from deltas", () => {
    const blocks = new Map();

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 0,
        content: { type: "function_call", id: "call_1" },
      },
      blocks,
    );
    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.delta",
        index: 0,
        delta: {
          type: "function_call",
          name: "webSearch",
          arguments: { query: "NVIDIA GTC 2026 dates announcements keynote" },
        },
      },
      blocks,
    );

    expect(googleNativeInternal.mapGoogleEventToStreamParts(
      { event_type: "content.stop", index: 0 },
      blocks,
    )).toEqual([
      { type: "tool-input-end", id: "call_1" },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "webSearch",
        input: { query: "NVIDIA GTC 2026 dates announcements keynote" },
      },
    ]);
  });

  test("mapGoogleEventToStreamParts normalizes native Google tool calls and results", () => {
    const blocks = new Map();
    const providerToolCallsById = new Map();

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 0,
        content: {
          type: "google_search_call",
          id: "gs_1",
          arguments: { queries: ["latest Gemini announcements"] },
        },
      },
      blocks,
      providerToolCallsById,
    );

    expect(googleNativeInternal.mapGoogleEventToStreamParts(
      {
        event_type: "content.stop",
        index: 0,
      },
      blocks,
      providerToolCallsById,
    )).toEqual([
      { type: "tool-input-end", id: "gs_1", toolName: "nativeWebSearch", providerExecuted: true },
    ]);

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 1,
        content: {
          type: "google_search_result",
          call_id: "gs_1",
          result: [{ search_suggestions: "Latest Gemini announcements" }],
        },
      },
      blocks,
      providerToolCallsById,
    );

    expect(googleNativeInternal.mapGoogleEventToStreamParts(
      {
        event_type: "content.stop",
        index: 1,
      },
      blocks,
      providerToolCallsById,
    )).toEqual([
      {
        type: "tool-result",
        toolCallId: "gs_1",
        toolName: "nativeWebSearch",
        output: {
          provider: "google",
          status: "completed",
          callId: "gs_1",
          queries: ["latest Gemini announcements"],
          results: [{ search_suggestions: "Latest Gemini announcements" }],
          raw: [{ search_suggestions: "Latest Gemini announcements" }],
        },
        providerExecuted: true,
      },
    ]);
  });

  test("mapGoogleEventToStreamParts preserves native Google search sources for citation fallbacks", () => {
    const blocks = new Map();
    const providerToolCallsById = new Map();

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 0,
        content: {
          type: "google_search_call",
          id: "gs_2",
          arguments: { queries: ["latest Gemini announcements"] },
        },
      },
      blocks,
      providerToolCallsById,
    );

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 1,
        content: {
          type: "google_search_result",
          call_id: "gs_2",
          result: {
            results: [{ search_suggestions: "Latest Gemini announcements" }],
            sources: [
              { title: "Gemini update", url: "https://example.com/gemini-update" },
            ],
          },
        },
      },
      blocks,
      providerToolCallsById,
    );

    expect(googleNativeInternal.mapGoogleEventToStreamParts(
      {
        event_type: "content.stop",
        index: 1,
      },
      blocks,
      providerToolCallsById,
    )).toEqual([
      {
        type: "tool-result",
        toolCallId: "gs_2",
        toolName: "nativeWebSearch",
        output: {
          provider: "google",
          status: "completed",
          callId: "gs_2",
          queries: ["latest Gemini announcements"],
          results: [{ search_suggestions: "Latest Gemini announcements" }],
          sources: [
            { title: "Gemini update", url: "https://example.com/gemini-update" },
          ],
          raw: {
            results: [{ search_suggestions: "Latest Gemini announcements" }],
            sources: [
              { title: "Gemini update", url: "https://example.com/gemini-update" },
            ],
          },
        },
        providerExecuted: true,
      },
    ]);
  });

  test("mapGoogleEventToStreamParts preserves singleton native URL context result objects", () => {
    const blocks = new Map();
    const providerToolCallsById = new Map();

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 0,
        content: {
          type: "url_context_call",
          id: "uc_1",
          arguments: { urls: ["https://example.com"] },
        },
      },
      blocks,
      providerToolCallsById,
    );

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 1,
        content: {
          type: "url_context_result",
          call_id: "uc_1",
          result: { url: "https://example.com", status: "ok" },
        },
      },
      blocks,
      providerToolCallsById,
    );

    expect(googleNativeInternal.mapGoogleEventToStreamParts(
      {
        event_type: "content.stop",
        index: 1,
      },
      blocks,
      providerToolCallsById,
    )).toEqual([
      {
        type: "tool-result",
        toolCallId: "uc_1",
        toolName: "nativeUrlContext",
        output: {
          provider: "google",
          status: "completed",
          callId: "uc_1",
          urls: ["https://example.com"],
          results: [{ url: "https://example.com", status: "ok" }],
          raw: { url: "https://example.com", status: "ok" },
        },
        providerExecuted: true,
      },
    ]);
  });

  test("mapGoogleEventToStreamParts carries assistant text annotations through text-end", () => {
    const blocks = new Map();
    const providerToolCallsById = new Map();

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 0,
        content: { type: "text", text: "Coffee shops" },
      },
      blocks,
      providerToolCallsById,
    );
    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.delta",
        index: 0,
        delta: {
          type: "text",
          text: " nearby",
          annotations: [
            {
              type: "place_citation",
              start_index: 0,
              end_index: 12,
              name: "Blue Bottle Coffee",
              url: "https://maps.google.com/?cid=123",
            },
          ],
        },
      },
      blocks,
      providerToolCallsById,
    );

    expect(googleNativeInternal.mapGoogleEventToStreamParts(
      { event_type: "content.stop", index: 0 },
      blocks,
      providerToolCallsById,
    )).toEqual([
      {
        type: "text-end",
        id: "s0",
        annotations: [
          {
            type: "place_citation",
            start_index: 0,
            end_index: 12,
            name: "Blue Bottle Coffee",
            url: "https://maps.google.com/?cid=123",
          },
        ],
      },
    ]);
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
