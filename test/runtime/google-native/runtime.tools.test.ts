import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGoogleInteractionsRuntime } from "../../../src/runtime/googleInteractionsRuntime";
import { makeConfig, makeParams } from "./fixtures";

describe("google interactions runtime — tools", () => {
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
});
