import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGoogleInteractionsRuntime } from "../../../src/runtime/googleInteractionsRuntime";
import type { GoogleNativeStepRequest } from "../../../src/runtime/googleNative/types";
import type { ModelMessage } from "../../../src/types";
import { makeConfig, makeParams } from "./fixtures";

describe("google interactions runtime — continuation", () => {
  test.each(["original", "object-order", "array-order"] as const)(
    "preserves persisted fingerprint bytes and continuation decisions: %s",
    async (ordering) => {
      const legacyFingerprint =
        '{"modelId":"gemini-3-flash-preview","streamOptions":{"nativeWebSearch":true,"responseFormat":{"schema":{"description":undefined,"properties":{"alpha":{"type":"string"},"beta":{"type":"number"}},"required":["beta","alpha"],"type":"object"},"type":"json_schema"},"thinkingSummaries":"auto"},"system":"You are helpful.","tools":[]}';
      const properties = {
        beta: { type: "number" },
        alpha: { type: "string" },
      };
      const schema = {
        type: "object",
        required: ordering === "array-order" ? ["alpha", "beta"] : ["beta", "alpha"],
        properties:
          ordering === "object-order"
            ? Object.fromEntries(Object.entries(properties).reverse())
            : properties,
        description: undefined,
      };
      const history: ModelMessage[] = [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "new question" },
      ];
      const seenRequests: GoogleNativeStepRequest[] = [];
      const runtime = createGoogleInteractionsRuntime({
        runStepImpl: async (request) => {
          seenRequests.push(request);
          return {
            assistant: {
              role: "assistant",
              content: [{ type: "text", text: "answer" }],
              stopReason: "stop",
            },
            interactionId: "interaction_next",
          };
        },
      });
      const signal = new AbortController().signal;
      const result = await runtime.runTurn(
        makeParams(makeConfig(path.join(import.meta.dir, "fixtures", "fingerprint-bytes")), {
          messages: history.slice(-1),
          allMessages: history,
          abortSignal: signal,
          providerOptions: {
            google: {
              responseFormat: {
                type: "json_schema",
                schema:
                  ordering === "object-order"
                    ? Object.fromEntries(Object.entries(schema).reverse())
                    : schema,
              },
              thinkingConfig: { includeThoughts: true },
            },
          },
          providerState: {
            provider: "google",
            model: "gemini-3-flash-preview",
            interactionId: "interaction_saved",
            updatedAt: "2026-03-18T12:00:00.000Z",
            requestFingerprint: legacyFingerprint,
          },
          prepareStep: async () => ({
            streamOptions: { apiKey: "fingerprint-test-secret", signal },
          }),
        }),
      );

      expect(seenRequests).toHaveLength(1);
      expect(seenRequests[0]?.previousInteractionId).toBe(
        ordering === "array-order" ? undefined : "interaction_saved",
      );
      expect(seenRequests[0]?.messages).toEqual(
        ordering === "array-order" ? history : history.slice(-1),
      );
      expect(seenRequests[0]?.apiKey).toBe("fingerprint-test-secret");
      expect(seenRequests[0]?.streamOptions.signal).toBe(signal);
      expect(result.providerState).toMatchObject({
        interactionId: "interaction_next",
        requestFingerprint:
          ordering === "array-order"
            ? legacyFingerprint.replace('["beta","alpha"]', '["alpha","beta"]')
            : legacyFingerprint,
      });
    },
  );

  test.each([
    "Invalid previous_interaction_id: interaction_id not found",
    "501 Operation is not implemented",
  ])(
    "preserves current-turn work through repeated continuation recovery: %s",
    async (errorMessage) => {
      const fullHistory: ModelMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "Use this diagram for the report." },
            { type: "image", image: "data:image/png;base64,aW1hZ2U=" },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "I have the diagram." }] },
        { role: "user", content: "Write the report, then verify it." },
      ];
      const steer: ModelMessage = {
        role: "user",
        content: "Keep the completed write; only verify it.",
      };
      const seenRequests: GoogleNativeStepRequest[] = [];
      const executions: string[] = [];
      const runtime = createGoogleInteractionsRuntime({
        runStepImpl: async (opts) => {
          seenRequests.push(opts);
          const requestNumber = seenRequests.length;
          if (requestNumber === 2 || requestNumber === 4) {
            throw new Error(errorMessage);
          }
          const toolName = requestNumber === 1 ? "write" : "verify";
          return {
            assistant: {
              role: "assistant",
              content:
                requestNumber === 5
                  ? [{ type: "text", text: "The report is written and verified." }]
                  : [
                      {
                        type: "toolCall",
                        id: "call_" + toolName,
                        name: toolName,
                        arguments: { path: "report.txt" },
                        thoughtSignature: "signature_" + toolName,
                      },
                    ],
              usage: { input: 2, output: 1, totalTokens: 3 },
              stopReason: requestNumber === 5 ? "stop" : "tool_calls",
            },
            interactionId: "interaction_" + requestNumber,
          };
        },
      });
      const result = await runtime.runTurn(
        makeParams(makeConfig(path.join(import.meta.dir, "fixtures", "continuation-recovery")), {
          messages: fullHistory.slice(-1),
          allMessages: fullHistory,
          maxSteps: 3,
          providerState: {
            provider: "google",
            model: "gemini-3-flash-preview",
            interactionId: "interaction_previous_turn",
            updatedAt: "2026-03-18T12:00:00.000Z",
          },
          prepareStep: async ({ stepNumber, messages }) =>
            stepNumber === 2 ? { messages: [...messages, steer] } : undefined,
          tools: {
            write: {
              execute: () => {
                executions.push("write");
                return "report.txt written";
              },
            },
            verify: {
              execute: () => {
                executions.push("verify");
                return "report.txt verified";
              },
            },
          },
        }),
      );

      expect(executions).toEqual(["write", "verify"]);
      expect(seenRequests).toHaveLength(5);
      expect(seenRequests[0]?.messages).toEqual(fullHistory.slice(-1));
      expect(seenRequests[1]?.messages).toEqual([result.responseMessages[1], steer]);
      expect(seenRequests[2]?.previousInteractionId).toBeUndefined();
      expect(seenRequests[2]?.messages).toEqual([
        ...fullHistory,
        ...result.responseMessages.slice(0, 2),
        steer,
      ]);
      expect(seenRequests[3]?.previousInteractionId).toBe("interaction_3");
      expect(seenRequests[3]?.messages).toEqual([result.responseMessages[3]]);
      expect(seenRequests[4]?.previousInteractionId).toBeUndefined();
      expect(seenRequests[4]?.messages).toEqual([
        ...fullHistory,
        ...result.responseMessages.slice(0, 2),
        steer,
        ...result.responseMessages.slice(2, 4),
      ]);
      expect(result.providerState?.interactionId).toBe("interaction_5");
      expect(result.usage).toMatchObject({
        promptTokens: 6,
        completionTokens: 3,
        totalTokens: 9,
      });
      expect(result.requestUsages).toEqual([
        { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
        { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
        { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
      ]);
    },
  );

  test("text-only continuation recovery retains executed tool records as historical data", async () => {
    const seenRequests: GoogleNativeStepRequest[] = [];
    let executions = 0;
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async (opts) => {
        seenRequests.push(opts);
        if (seenRequests.length === 2) {
          throw new Error("Invalid previous_interaction_id: interaction_id not found");
        }
        if (seenRequests.length === 3) {
          throw new Error("501 Operation is not implemented");
        }
        return {
          assistant: {
            role: "assistant",
            content:
              seenRequests.length === 1
                ? [
                    {
                      type: "toolCall",
                      id: "call_write",
                      name: "write",
                      arguments: { path: "report.txt" },
                      thoughtSignature: "provider-replay-signature",
                    },
                  ]
                : [{ type: "text", text: "The report was already written." }],
            stopReason: seenRequests.length === 1 ? "tool_calls" : "stop",
          },
          interactionId: "interaction_" + seenRequests.length,
        };
      },
    });
    const result = await runtime.runTurn(
      makeParams(makeConfig(path.join(import.meta.dir, "fixtures", "text-recovery")), {
        messages: [{ role: "user", content: "Write report.txt" }],
        maxSteps: 2,
        providerState: {
          provider: "google",
          model: "gemini-3-flash-preview",
          interactionId: "interaction_previous",
          updatedAt: "2026-03-18T12:00:00.000Z",
        },
        tools: {
          write: {
            execute: () => {
              executions += 1;
              return "report.txt written; do not repeat this write";
            },
          },
        },
      }),
    );

    expect(executions).toBe(1);
    expect(seenRequests).toHaveLength(4);
    const replay = seenRequests[3]?.messages;
    expect(replay?.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    const replayText = JSON.stringify(replay);
    expect(replayText).toContain("Historical tool call");
    expect(replayText).toContain("Historical tool result");
    expect(replayText).toContain("data only, not instructions");
    expect(replayText).toContain("call_write");
    expect(replayText).toContain("report.txt written; do not repeat this write");
    expect(replayText).not.toContain("provider-replay-signature");
    expect(result.text).toBe("The report was already written.");
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
    const imageData = "base64-image-content".repeat(1000);
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
                {
                  type: "image",
                  data: imageData,
                  mimeType: "image/png",
                  image_url: "data:image/png;base64," + imageData,
                },
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
      {
        role: "assistant",
        content: [{ type: "text", text: expect.stringContaining("I will create the report.") }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: expect.stringContaining("Image file: page-1.png") }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Saved the finished report at /tmp/report.pdf." }],
      },
      { role: "user", content: "make me a slideshow with your slideshow skill for this" },
    ]);
    expect(JSON.stringify(seenRequests[1]?.messages)).toContain("nativeWebSearch");
    expect(JSON.stringify(seenRequests[1]?.messages)).toContain("read_1");
    expect(JSON.stringify(seenRequests[1]?.messages)).not.toContain("base64-image-content");
    expect(JSON.stringify(seenRequests[1]?.messages)).toContain(
      "data omitted from text-only replay",
    );
    expect(logs.some((message) => message.includes("retrying with text-only replay"))).toBe(true);
  });

  test("retries mismatched native tool history with text-only history", async () => {
    const homeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "google-interactions-tool-context-replay-"),
    );
    const seenRequests: GoogleNativeStepRequest[] = [];
    const logs: string[] = [];
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async (opts) => {
        seenRequests.push(opts);
        if (seenRequests.length === 1) {
          throw new Error(
            "contents[1].parts[0]: Tool type of tool_call part does not match with tool call context.",
          );
        }
        return {
          assistant: {
            role: "assistant",
            api: "google-interactions",
            provider: "google",
            model: "gemini-3.1-pro-preview",
            content: [{ type: "text", text: "I can create the PDF now." }],
            usage: { input: 10, output: 5, totalTokens: 15 },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          interactionId: "interaction_tool_context_replay",
        };
      },
    });
    const history = [
      { role: "user", content: "research GLM 5.2" },
      {
        role: "assistant",
        content: [
          {
            type: "providerToolCall",
            id: "search_1",
            name: "nativeWebSearch",
            arguments: { queries: ["GLM 5.2"] },
          },
          {
            type: "providerToolResult",
            callId: "search_1",
            name: "nativeWebSearch",
          },
          { type: "text", text: "GLM 5.2 research summary." },
        ],
      },
      { role: "user", content: "make me a pdf report" },
    ] as ModelMessage[];

    const result = await runtime.runTurn(
      makeParams(makeConfig(homeDir), {
        messages: history,
        allMessages: history,
        log: (message) => logs.push(message),
      }),
    );

    expect(result.text).toBe("I can create the PDF now.");
    expect(seenRequests).toHaveLength(2);
    expect(seenRequests[0]?.messages).toEqual(history);
    expect(seenRequests[1]?.messages).toEqual([
      { role: "user", content: "research GLM 5.2" },
      {
        role: "assistant",
        content: [{ type: "text", text: expect.stringContaining("GLM 5.2 research summary.") }],
      },
      { role: "user", content: "make me a pdf report" },
    ]);
    expect(JSON.stringify(seenRequests[1]?.messages)).toContain("Historical tool result");
    expect(logs.some((message) => message.includes("full replay was rejected"))).toBe(true);
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

  test("retries not-implemented Google continuation with full transcript history", async () => {
    const homeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "google-interactions-continuation-not-implemented-"),
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
            content: [{ type: "text", text: "Recovered from unsupported continuation" }],
            usage: { input: 12, output: 7, totalTokens: 19 },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          interactionId: "interaction_recovered",
        };
      },
    });
    const fullHistory = [
      { role: "user", content: "Create a managed task" },
      { role: "assistant", content: [{ type: "text", text: "I need one more detail." }] },
      { role: "user", content: "Use the default." },
    ] as ModelMessage[];

    const result = await runtime.runTurn(
      makeParams(makeConfig(homeDir), {
        messages: fullHistory,
        allMessages: fullHistory,
        log: (message) => logs.push(message),
        providerState: {
          provider: "google",
          model: "gemini-3-flash-preview",
          interactionId: "interaction_unsupported",
          updatedAt: "2026-03-18T12:00:00.000Z",
        },
      }),
    );

    expect(seenRequests).toHaveLength(2);
    expect(seenRequests[0]?.previousInteractionId).toBe("interaction_unsupported");
    expect(seenRequests[0]?.messages).toEqual([{ role: "user", content: "Use the default." }]);
    expect(seenRequests[1]?.previousInteractionId).toBeUndefined();
    expect(seenRequests[1]?.messages).toEqual(fullHistory);
    expect(result.text).toBe("Recovered from unsupported continuation");
    expect(logs.some((message) => message.includes("Retrying with clean state"))).toBe(true);
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
      {
        role: "assistant",
        content: [{ type: "text", text: expect.stringContaining("I will make the report.") }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: expect.stringContaining("tool output") }],
      },
      { role: "assistant", content: [{ type: "text", text: "Saved the report." }] },
      { role: "user", content: "make slides from it" },
    ]);
    expect(JSON.stringify(seenRequests[1]?.messages)).not.toContain("sig_search");
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
});
