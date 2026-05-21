import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildGooglePrepareStep } from "../src/providers/googleReplay";
import { createGoogleInteractionsRuntime } from "../src/runtime/googleInteractionsRuntime";
import { __internal as googleNativeInternal } from "../src/runtime/googleNativeInteractions";
import type { RuntimeRunTurnParams } from "../src/runtime/types";
import { isInvalidGoogleContinuationError } from "../src/shared/providerContinuation";
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
    projectCoworkDir: path.join(homeDir, ".agent-project"),
    userCoworkDir: path.join(homeDir, ".cowork"),
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

function googleSseResponse(events: Array<Record<string, unknown>>): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const liveGoogleApiKey =
  process.env.GOOGLE_INTERACTIONS_LIVE === "1"
    ? (process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GOOGLE_API_KEY)
    : undefined;
const liveGoogleTest = liveGoogleApiKey ? test : test.skip;

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
          content: [{ type: "text", text: "Hello! How can I help you?" }],
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
      requestFingerprint: expect.any(String),
    });
  });

  test("caches the Google interactions client so the SDK experimental warning is only emitted once per api key", () => {
    const realWarn = console.warn;
    const warn = mock(() => {});
    console.warn = warn as typeof console.warn;

    try {
      googleNativeInternal.__testResetGoogleInteractionsClientCache();

      const first = googleNativeInternal.getGoogleInteractionsClient("test-google-api-key");
      const second = googleNativeInternal.getGoogleInteractionsClient("test-google-api-key");

      expect(first).toBe(second);
      expect(googleNativeInternal.__testGetGoogleInteractionsClientCacheSize()).toBe(1);
      expect(
        warn.mock.calls.filter(([message]) =>
          String(message).includes("GoogleGenAI.interactions: Interactions usage is experimental"),
        ).length,
      ).toBe(1);
    } finally {
      console.warn = realWarn;
      googleNativeInternal.__testResetGoogleInteractionsClientCache();
    }
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

  test("provider-native web search blocks do not trigger client tool execution", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "google-interactions-web-search-"));
    let stepCount = 0;
    let clientToolExecuted = false;
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async () => {
        stepCount += 1;
        return {
          assistant: {
            role: "assistant",
            content: [
              {
                type: "providerToolCall",
                id: "search_1",
                name: "nativeWebSearch",
                arguments: { queries: ["Gemini announcements"] },
              },
              {
                type: "providerToolResult",
                callId: "search_1",
                name: "nativeWebSearch",
                result: [{ search_suggestions: "Gemini announcements" }],
              },
              { type: "text", text: "Here is the latest." },
            ],
            stopReason: "stop",
            timestamp: Date.now(),
          },
          interactionId: "interaction_web_search",
        };
      },
    });

    const result = await runtime.runTurn(
      makeParams(makeConfig(homeDir), {
        maxSteps: 5,
        tools: {
          nativeWebSearch: {
            description: "A client tool that must not run for provider-native web search",
            inputSchema: undefined,
            execute: async () => {
              clientToolExecuted = true;
              return "client web search";
            },
          },
        },
      }),
    );

    expect(stepCount).toBe(1);
    expect(clientToolExecuted).toBe(false);
    expect(result.text).toBe("Here is the latest.");
    expect(result.responseMessages).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "providerToolCall",
            id: "search_1",
            name: "nativeWebSearch",
            arguments: { queries: ["Gemini announcements"] },
          },
          {
            type: "providerToolResult",
            callId: "search_1",
            name: "nativeWebSearch",
            result: [{ search_suggestions: "Gemini announcements" }],
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
            content: [{ type: "text", text: "Tool result received." }],
            usage: { input: 20, output: 10, totalTokens: 30 },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          interactionId: "interaction_step2",
        };
      },
    });

    let toolExecuted = false;
    const result = await runtime.runTurn(
      makeParams(makeConfig(homeDir), {
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
      }),
    );

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
              content: [{ type: "toolCall", id: "call_1", name: "testTool", arguments: {} }],
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

    const result = await runtime.runTurn(
      makeParams(makeConfig(homeDir), {
        maxSteps: 5,
        tools: {
          testTool: {
            description: "test",
            inputSchema: undefined,
            execute: async () => "ok",
          },
        },
      }),
    );

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

    const result = await runtime.runTurn(
      makeParams(makeConfig(homeDir), {
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
      }),
    );

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
      requestFingerprint: expect.any(String),
    });
  });

  test("replays full transcript when the request fingerprint changes", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "google-interactions-fingerprint-"));
    const seenRequests: GoogleNativeStepRequest[] = [];
    const logs: string[] = [];
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async (opts) => {
        seenRequests.push(opts);
        return {
          assistant: {
            role: "assistant",
            api: "google-interactions",
            provider: "google",
            model: "gemini-3-flash-preview",
            content: [{ type: "text", text: "fresh context" }],
            usage: { input: 1, output: 1, totalTokens: 2 },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          interactionId: "interaction_fresh",
        };
      },
    });
    const history = [
      { role: "user", content: "old" },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      { role: "user", content: "new" },
    ] as ModelMessage[];

    await runtime.runTurn(
      makeParams(makeConfig(homeDir), {
        messages: history,
        allMessages: history,
        log: (message) => logs.push(message),
        providerState: {
          provider: "google",
          model: "gemini-3-flash-preview",
          interactionId: "interaction_old",
          requestFingerprint: "outdated-fingerprint",
          updatedAt: "2026-03-18T12:00:00.000Z",
        },
      }),
    );

    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?.previousInteractionId).toBeUndefined();
    expect(seenRequests[0]?.messages).toEqual(history);
    expect(
      logs.some((message) =>
        message.includes("Not reusing stored continuation because request context changed"),
      ),
    ).toBe(true);
  });

  test("retries transient Google failures before succeeding without continuation", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "google-interactions-retry-"));
    let calls = 0;
    const logs: string[] = [];
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async () => {
        calls += 1;
        if (calls < 3) throw new Error("503 service unavailable");
        return {
          assistant: {
            role: "assistant",
            api: "google-interactions",
            provider: "google",
            model: "gemini-3-flash-preview",
            content: [{ type: "text", text: "ok" }],
            usage: { input: 1, output: 1, totalTokens: 2 },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          interactionId: "interaction_after_retry",
        };
      },
    });

    await runtime.runTurn(
      makeParams(makeConfig(homeDir), {
        log: (message) => logs.push(message),
      }),
    );

    expect(calls).toBe(3);
    expect(logs.some((message) => message.includes("transient model call failure"))).toBe(true);
  });

  test("retries not implemented full-history replays with text-only history", async () => {
    const homeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "google-interactions-not-implemented-replay-"),
    );
    const seenRequests: GoogleNativeStepRequest[] = [];
    const logs: string[] = [];
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async (opts) => {
        seenRequests.push(opts);
        if (seenRequests.length === 1) {
          throw new Error(
            '501 {"error":{"message":"Operation is not implemented, or supported, or enabled.","code":"not_implemented"}}',
          );
        }
        return {
          assistant: {
            role: "assistant",
            api: "google-interactions",
            provider: "google",
            model: "gemini-3-flash-preview",
            content: [{ type: "text", text: "I can make the slideshow now." }],
            usage: { input: 10, output: 5, totalTokens: 15 },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          interactionId: "interaction_text_only_replay",
        };
      },
    });
    const history = [
      { role: "user", content: "make a pdf report" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will create the report." },
          {
            type: "providerToolCall",
            id: "search_1",
            name: "nativeWebSearch",
            arguments: { queries: ["latest"] },
            providerOptions: { google: { thoughtSignature: "sig_search" } },
          },
          {
            type: "tool-call",
            toolCallId: "read_1",
            toolName: "read",
            input: { filePath: "assets/page-1.png" },
            providerOptions: { google: { thoughtSignature: "sig_read" } },
          },
          {
            type: "thinking",
            thinking: "Hidden planning should not be replayed as text.",
            thinkingSignature: "sig_thought",
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read_1",
            toolName: "read",
            output: {
              type: "content",
              content: [
                { type: "text", text: "Image file: page-1.png" },
                { type: "image", data: "abc123", mimeType: "image/png" },
              ],
            },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Saved the finished report at /tmp/report.pdf.",
          },
        ],
      },
      { role: "user", content: "make me a slideshow with your slideshow skill for this" },
    ] as ModelMessage[];

    const result = await runtime.runTurn(
      makeParams(makeConfig(homeDir), {
        messages: history,
        allMessages: history,
        log: (message) => logs.push(message),
      }),
    );

    expect(result.text).toBe("I can make the slideshow now.");
    expect(seenRequests).toHaveLength(2);
    expect(seenRequests[0]?.messages).toEqual(history);
    expect(seenRequests[1]?.messages).toEqual([
      { role: "user", content: "make a pdf report" },
      { role: "assistant", content: [{ type: "text", text: "I will create the report." }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Saved the finished report at /tmp/report.pdf." }],
      },
      { role: "user", content: "make me a slideshow with your slideshow skill for this" },
    ]);
    expect(logs.some((message) => message.includes("retrying with text-only replay"))).toBe(true);
  });

  test("does not reuse Google continuation after disabled native code execution", async () => {
    const homeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "google-interactions-code-exec-continuation-"),
    );
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
            content: [{ type: "text", text: "Use bash instead." }],
            usage: { input: 5, output: 7, totalTokens: 12 },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          interactionId: "interaction_after_reset",
        };
      },
    });
    const history = [
      { role: "user", content: "make a pdf" },
      {
        role: "assistant",
        content: [
          {
            type: "providerToolCall",
            id: "code_1",
            name: "codeExecution",
            arguments: {},
          },
        ],
      },
      { role: "user", content: "continue" },
    ] as ModelMessage[];

    await runtime.runTurn(
      makeParams(makeConfig(homeDir), {
        messages: history,
        allMessages: history,
        providerState: {
          provider: "google",
          model: "gemini-3-flash-preview",
          interactionId: "interaction_requires_code_execution",
          updatedAt: "2026-03-18T12:00:00.000Z",
        },
      }),
    );

    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?.previousInteractionId).toBeUndefined();
    expect(seenRequests[0]?.messages).toEqual(history);
  });

  test("retries stale Google continuation with full transcript history", async () => {
    const homeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "google-interactions-continuation-fallback-"),
    );
    const seenRequests: GoogleNativeStepRequest[] = [];
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async (opts) => {
        seenRequests.push(opts);
        if (seenRequests.length === 1) {
          throw new Error("Invalid previous_interaction_id: interaction_id not found");
        }
        return {
          assistant: {
            role: "assistant",
            api: "google-interactions",
            provider: "google",
            model: "gemini-3-flash-preview",
            content: [{ type: "text", text: "Recovered with full history" }],
            usage: { input: 12, output: 7, totalTokens: 19 },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          interactionId: "interaction_recovered",
        };
      },
    });
    const fullHistory = [
      { role: "user", content: "Find the latest pricing" },
      { role: "assistant", content: [{ type: "text", text: "Here are the latest prices." }] },
      { role: "user", content: "Open the second result" },
    ] as ModelMessage[];

    const result = await runtime.runTurn(
      makeParams(makeConfig(homeDir), {
        messages: fullHistory,
        allMessages: fullHistory,
        providerState: {
          provider: "google",
          model: "gemini-3-flash-preview",
          interactionId: "interaction_stale",
          updatedAt: "2026-03-18T12:00:00.000Z",
        },
      }),
    );

    expect(seenRequests).toHaveLength(2);
    expect(seenRequests[0]?.previousInteractionId).toBe("interaction_stale");
    expect(seenRequests[0]?.messages).toEqual([
      { role: "user", content: "Open the second result" },
    ]);
    expect(seenRequests[1]?.previousInteractionId).toBeUndefined();
    expect(seenRequests[1]?.messages).toEqual(fullHistory);
    expect(result.text).toBe("Recovered with full history");
  });

  test("retries changed-context replay with text-only history when clean replay is unsupported", async () => {
    const homeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "google-interactions-continuation-not-implemented-fallback-"),
    );
    const seenRequests: GoogleNativeStepRequest[] = [];
    const logs: string[] = [];
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async (opts) => {
        seenRequests.push(opts);
        if (seenRequests.length === 1) {
          throw new Error(
            '501 {"error":{"message":"Operation is not implemented, or supported, or enabled.","code":"not_implemented"}}',
          );
        }
        return {
          assistant: {
            role: "assistant",
            api: "google-interactions",
            provider: "google",
            model: "gemini-3-flash-preview",
            content: [{ type: "text", text: "Recovered with text-only history" }],
            usage: { input: 12, output: 7, totalTokens: 19 },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          interactionId: "interaction_recovered_text_only",
        };
      },
    });
    const fullHistory = [
      { role: "user", content: "make a report" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will make the report." },
          {
            type: "providerToolCall",
            id: "search_1",
            name: "nativeWebSearch",
            arguments: { query: "latest" },
            providerOptions: { google: { thoughtSignature: "sig_search" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read_1",
            toolName: "read",
            output: { type: "text", value: "tool output" },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Saved the report." }] },
      { role: "user", content: "make slides from it" },
    ] as ModelMessage[];

    const result = await runtime.runTurn(
      makeParams(makeConfig(homeDir), {
        messages: fullHistory,
        allMessages: fullHistory,
        log: (message) => logs.push(message),
        providerState: {
          provider: "google",
          model: "gemini-3-flash-preview",
          interactionId: "interaction_stale",
          requestFingerprint: "outdated-fingerprint",
          updatedAt: "2026-03-18T12:00:00.000Z",
        },
      }),
    );

    expect(result.text).toBe("Recovered with text-only history");
    expect(seenRequests).toHaveLength(2);
    expect(seenRequests[0]?.previousInteractionId).toBeUndefined();
    expect(seenRequests[0]?.messages).toEqual(fullHistory);
    expect(seenRequests[1]?.previousInteractionId).toBeUndefined();
    expect(seenRequests[1]?.messages).toEqual([
      { role: "user", content: "make a report" },
      { role: "assistant", content: [{ type: "text", text: "I will make the report." }] },
      { role: "assistant", content: [{ type: "text", text: "Saved the report." }] },
      { role: "user", content: "make slides from it" },
    ]);
    expect(logs.some((message) => message.includes("retrying with text-only replay"))).toBe(true);
  });

  test("does not retry generic Google invalid request errors as stale continuation", async () => {
    const homeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "google-interactions-generic-invalid-"),
    );
    const seenRequests: GoogleNativeStepRequest[] = [];
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async (opts) => {
        seenRequests.push(opts);
        throw new Error("INVALID_ARGUMENT: bad attachment content");
      },
    });

    await expect(
      runtime.runTurn(
        makeParams(makeConfig(homeDir), {
          messages: [
            { role: "user", content: "Find the latest pricing" },
            { role: "assistant", content: [{ type: "text", text: "Here are the latest prices." }] },
            { role: "user", content: "Open the second result" },
          ] as ModelMessage[],
          providerState: {
            provider: "google",
            model: "gemini-3-flash-preview",
            interactionId: "interaction_valid",
            updatedAt: "2026-03-18T12:00:00.000Z",
          },
        }),
      ),
    ).rejects.toThrow("INVALID_ARGUMENT: bad attachment content");

    expect(seenRequests).toHaveLength(1);
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

    await runtime.runTurn(
      makeParams(makeConfig(homeDir), {
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
      }),
    );

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

    const result = await runtime.runTurn(
      makeParams(makeConfig(homeDir), {
        maxSteps: 5,
        prepareStep,
        tools: {
          testTool: {
            description: "test",
            inputSchema: undefined,
            execute: async () => ({ type: "text", value: "tool result" }),
          },
        },
      }),
    );

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

    await runtime.runTurn(
      makeParams(makeConfig(homeDir), {
        maxSteps: 5,
        tools: {
          testTool: {
            description: "A test tool",
            inputSchema: undefined,
            execute: async () => ({ type: "text", value: "tool result" }),
          },
        },
      }),
    );

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
    await runtime.runTurn(
      makeParams(makeConfig(homeDir), {
        onModelStreamPart: async (part) => {
          streamParts.push(part);
        },
      }),
    );

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
    await runtime.runTurn(
      makeParams(makeConfig(homeDir), {
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
      }),
    );

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
      await runtime.runTurn(
        makeParams(makeConfig(homeDir), {
          onModelError: async (error) => {
            errorCaught = error;
          },
        }),
      );
    } catch (error) {
      expect((error as Error).message).toBe("API rate limit exceeded");
    }

    expect(errorCaught).toBeDefined();
    expect((errorCaught as Error).message).toBe("API rate limit exceeded");
  });

  test("records and attaches usage to thrown error when turn fails mid-way", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "google-interactions-failure-usage-"));
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
                  name: "some_tool",
                  arguments: {},
                },
              ],
              usage: {
                input: 40,
                output: 8,
                totalTokens: 48,
              },
              stopReason: "tool_calls",
              timestamp: Date.now(),
            },
            interactionId: "interaction_step_1",
          };
        }
        throw new Error("Gemini interactions failed on step 2");
      },
    });

    let thrownError: any = null;
    try {
      await runtime.runTurn(
        makeParams(makeConfig(homeDir), {
          maxSteps: 2,
          tools: {
            some_tool: {
              execute: async () => "success",
            },
          },
        }),
      );
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).not.toBeNull();
    expect(thrownError.message).toContain("Gemini interactions failed on step 2");
    expect(thrownError.usage).toEqual({
      promptTokens: 40,
      completionTokens: 8,
      totalTokens: 48,
    });
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

describe("google continuation error detection", () => {
  test("requires an interaction-id-specific Google error before retrying continuation", () => {
    expect(
      isInvalidGoogleContinuationError(
        new Error("INVALID_ARGUMENT: previous_interaction_id interaction_id not found"),
      ),
    ).toBe(true);
    expect(isInvalidGoogleContinuationError(new Error("invalid_request: tool schema failed"))).toBe(
      false,
    );
    expect(isInvalidGoogleContinuationError(new Error("INVALID_ARGUMENT: bad attachment"))).toBe(
      false,
    );
  });
});
