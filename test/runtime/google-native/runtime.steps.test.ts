import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildGooglePrepareStep } from "../../../src/providers/googleReplay";
import { createGoogleInteractionsRuntime } from "../../../src/runtime/googleInteractionsRuntime";
import type { ModelMessage } from "../../../src/types";
import { makeConfig, makeParams } from "./fixtures";

describe("google interactions runtime — steps", () => {
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
});
