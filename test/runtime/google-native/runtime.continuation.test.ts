import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGoogleInteractionsRuntime } from "../../../src/runtime/googleInteractionsRuntime";
import type { GoogleNativeStepRequest } from "../../../src/runtime/googleNative/types";
import type { ModelMessage } from "../../../src/types";
import { makeConfig, makeParams } from "./fixtures";

describe("google interactions runtime — continuation", () => {
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
});
