import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGoogleInteractionsRuntime } from "../../../src/runtime/googleInteractionsRuntime";
import { __internal as googleNativeInternal } from "../../../src/runtime/googleNativeInteractions";
import { makeConfig, makeParams } from "./fixtures";

describe("google interactions runtime — core", () => {
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

  test("runtime name is google-interactions", () => {
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async () => ({
        assistant: { role: "assistant", content: [], stopReason: "stop", timestamp: Date.now() },
        interactionId: "i",
      }),
    });
    expect(runtime.name).toBe("google-interactions");
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
});
