import { describe, expect, test } from "bun:test";

import {
  beginInProcessStep,
  completeInProcessAssistantStep,
  createInProcessTurnUsageTracker,
} from "../src/runtime/inProcessStepLoop";
import type { RuntimeRunTurnParams } from "../src/runtime/types";
import type { AgentConfig, ModelMessage } from "../src/types";

function turnParams(overrides: Partial<RuntimeRunTurnParams> = {}): RuntimeRunTurnParams {
  return {
    config: { provider: "openai" } as AgentConfig,
    system: "",
    messages: [],
    tools: {},
    maxSteps: 1,
    ...overrides,
  };
}

describe("in-process step loop", () => {
  test("does not prepare the next step when cancellation lands during start-step", async () => {
    const controller = new AbortController();
    let prepareCalled = false;
    const parts: unknown[] = [];

    await expect(
      beginInProcessStep({
        params: turnParams({
          abortSignal: controller.signal,
          prepareStep: async () => {
            prepareCalled = true;
            return { streamOptions: { temperature: 0 } };
          },
        }),
        stepNumber: 1,
        modelId: "gpt-test",
        stepMessages: [],
        emitPart: async (part) => {
          parts.push(part);
          controller.abort();
        },
        recheckAbortBetweenBoundaries: true,
      }),
    ).rejects.toThrow("Model turn aborted.");

    expect(prepareCalled).toBe(false);
    expect(parts).toEqual([
      {
        type: "start-step",
        stepNumber: 1,
        request: { model: "gpt-test", provider: "openai" },
      },
    ]);
  });

  test("rejects a failed assistant step after committing it and before running tools", async () => {
    const executed: unknown[] = [];
    const parts: unknown[] = [];
    const assistantMessages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "partial" }] },
    ];
    const assistantRecord = {
      stopReason: "error",
      errorMessage: "provider rejected the request",
      content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "pwd" } }],
    };

    await expect(
      completeInProcessAssistantStep({
        stepNumber: 2,
        assistantRecord,
        assistantMessages,
        stepMessages: [{ role: "user", content: "go" }],
        terminalFailureFallbackMessage: "OpenAI Responses runtime model stream failed.",
        params: turnParams({
          tools: {
            bash: {
              execute: async (input) => {
                executed.push(input);
                return "ran";
              },
            },
          },
        }),
        emitPart: async (part) => {
          parts.push(part);
        },
        turnMessages: [],
      }),
    ).rejects.toThrow("provider rejected the request");

    expect(executed).toEqual([]);
    expect(parts).toEqual([
      expect.objectContaining({
        type: "finish-step",
        stepNumber: 2,
        finishReason: "error",
        response: { stopReason: "error" },
      }),
    ]);
  });

  test("uses the runtime fallback when a failed assistant step has no error message", async () => {
    await expect(
      completeInProcessAssistantStep({
        stepNumber: 1,
        assistantRecord: { stopReason: "aborted" },
        assistantMessages: [],
        stepMessages: [],
        terminalFailureFallbackMessage: "Google Interactions runtime model stream failed.",
        params: turnParams(),
        emitPart: async () => {},
        turnMessages: [],
      }),
    ).rejects.toThrow("Google Interactions runtime model stream failed.");
  });

  test("provider-managed continuation keeps only tool results for the next request", async () => {
    const completed = await completeInProcessAssistantStep({
      stepNumber: 1,
      assistantRecord: {
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call_1", name: "echo", arguments: { text: "hi" } }],
      },
      assistantMessages: [{ role: "assistant", content: [{ type: "text", text: "calling" }] }],
      stepMessages: [{ role: "user", content: "prior history" }],
      appendAssistantToStepMessages: false,
      replaceStepMessagesWithToolResults: true,
      params: turnParams({
        shouldStopAfterToolStep: () => true,
        tools: {
          echo: {
            execute: async (input) => input,
          },
        },
      }),
      emitPart: async () => {},
      turnMessages: [],
    });

    expect(completed.shouldContinue).toBe(false);
    expect(completed.stopReason).toBe("toolUse");
    expect(completed.stepMessages).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "echo",
            output: { type: "text", value: '{"text":"hi"}' },
            isError: false,
          },
        ],
      },
    ]);
  });

  test("ignores an unusable requestUsages payload instead of mixing in fallback usage", () => {
    const tracker = createInProcessTurnUsageTracker();
    tracker.recordStepUsage({ input: 4, output: 2, totalTokens: 6 });
    tracker.recordPartialErrorUsage(
      { requestUsages: [{}] },
      { input: 9, output: 9, totalTokens: 18 },
    );

    expect(tracker.hasCompleteRequestUsage).toBe(true);
    expect(tracker.buildUsageResult()).toEqual({
      usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
      requestUsages: [{ promptTokens: 4, completionTokens: 2, totalTokens: 6 }],
    });
  });
});
