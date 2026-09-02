import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildGooglePrepareStep } from "../../../src/providers/googleReplay";
import * as googleModel from "../../../src/runtime/googleInteractionsModel";
import { createGoogleInteractionsRuntime } from "../../../src/runtime/googleInteractionsRuntime";
import type { RunGoogleNativeInteractionStep } from "../../../src/runtime/googleNativeInteractions";
import * as piMessageBridge from "../../../src/runtime/piMessageBridge";
import * as piRuntime from "../../../src/runtime/piRuntime";
import * as piRuntimeOptions from "../../../src/runtime/piRuntimeOptions";
import {
  RUNTIME_COMMITTED_PROGRESS,
  type RuntimeCommittedProgress,
} from "../../../src/runtime/types";
import { normalizeModelStreamPart } from "../../../src/server/modelStream";
import type { ModelMessage } from "../../../src/types";
import { makeConfig, makeParams } from "./fixtures";

function mockGoogleStepModel(config: ReturnType<typeof makeConfig>) {
  return spyOn(googleModel, "resolveGoogleInteractionsModel").mockResolvedValue({
    model: {
      id: config.model,
      name: config.model,
      reasoning: true,
      input: ["text", "image", "audio", "video", "document"],
      contextWindow: 1000,
      maxTokens: 100,
    },
    apiKey: "test-api-key",
  });
}

describe("google interactions runtime — steps", () => {
  test.each(["google", "vertex"] as const)(
    "preserves sticky %s overrides, signed continuation, and telemetry input",
    async (section) => {
      const config = makeConfig(path.join(import.meta.dir, "fixtures", "step-overrides"), {
        providerOptions: {
          [section]: { temperature: 0.2, thinkingConfig: { thinkingLevel: "high" } },
        },
      });
      const resolveModel = mockGoogleStepModel(config);
      const bridge = spyOn(piMessageBridge, "modelMessagesToPiMessages");
      const span = spyOn(piRuntime, "startModelCallSpan").mockReturnValue(null);
      const requests: Array<Parameters<RunGoogleNativeInteractionStep>[0]> = [];
      const signal = new AbortController().signal;
      const steeredMessages: ModelMessage[] = [{ role: "user", content: "steered question" }];
      const runtime = createGoogleInteractionsRuntime({
        runStepImpl: async (request) => {
          requests.push(request);
          const step = requests.length;
          return {
            assistant: {
              role: "assistant",
              content:
                step < 3
                  ? [
                      { type: "thinking", thinking: "Inspect", thinkingSignature: `sig_${step}` },
                      {
                        type: "toolCall",
                        id: `call_${step}`,
                        name: "lookup",
                        arguments: {},
                        thoughtSignature: `tool_sig_${step}`,
                      },
                    ]
                  : [{ type: "text", text: "done" }],
              stopReason: step < 3 ? "tool_calls" : "stop",
            },
            interactionId: `interaction_${step}`,
          };
        },
      });
      try {
        const result = await runtime.runTurn(
          makeParams(config, {
            maxSteps: 3,
            abortSignal: signal,
            telemetry: { isEnabled: true, recordInputs: true },
            providerState: {
              provider: "google",
              model: config.model,
              interactionId: "saved_interaction",
              updatedAt: "2026-03-18T12:00:00.000Z",
            },
            tools: { lookup: { execute: () => "found" } },
            prepareStep: async ({ stepNumber }) => {
              if (stepNumber === 1) {
                return {
                  messages: steeredMessages,
                  streamOptions: { temperature: 0.9, responseMimeType: "text/plain" },
                };
              }
              if (stepNumber === 2) {
                return {
                  providerOptions: {
                    [section]: {
                      temperature: 0.6,
                      thinkingConfig: { thinkingLevel: "high", includeThoughts: false },
                    },
                  },
                };
              }
              return undefined;
            },
          }),
        );
        expect(requests.map((request) => request.previousInteractionId)).toEqual([
          "saved_interaction",
          "interaction_1",
          "interaction_2",
        ]);
        expect(requests.map((request) => request.streamOptions)).toEqual([
          {
            apiKey: "test-api-key",
            signal,
            temperature: 0.9,
            responseMimeType: "text/plain",
            thinkingLevel: "high",
            thinkingSummaries: "auto",
            nativeWebSearch: true,
          },
          ...Array.from({ length: 2 }, () => ({
            apiKey: "test-api-key",
            signal,
            temperature: 0.6,
            thinkingLevel: "high",
            thinkingSummaries: "none",
            nativeWebSearch: true,
          })),
        ]);
        expect(requests.map((request) => request.messages.map((message) => message.role))).toEqual([
          ["user"],
          ["tool"],
          ["tool"],
        ]);
        expect(requests[0]?.messages).toEqual(steeredMessages);
        expect(bridge).toHaveBeenCalledTimes(3);
        expect(span).toHaveBeenCalledTimes(3);
        for (const [index, call] of span.mock.calls.entries()) {
          expect(call[4]).toBe(requests[index]?.streamOptions);
          expect(call[5]).toBe(bridge.mock.results[index]?.value);
        }
        expect(bridge.mock.calls[2]?.[0]).toEqual([
          ...steeredMessages,
          ...result.responseMessages.slice(0, 4),
        ]);
        expect(JSON.stringify(span.mock.calls[2]?.[5])).toContain("sig_1");
        expect(JSON.stringify(span.mock.calls[2]?.[5])).toContain("tool_sig_2");
        expect(result.providerState).toMatchObject({ interactionId: "interaction_3" });
      } finally {
        span.mockRestore();
        bridge.mockRestore();
        resolveModel.mockRestore();
      }
    },
  );

  test("does not build discarded PI stream options during Google steps", async () => {
    const config = makeConfig(path.join(import.meta.dir, "fixtures", "step-work-count"));
    const resolveModel = mockGoogleStepModel(config);
    const options = spyOn(piRuntimeOptions, "buildPiStreamOptions");
    const bridge = spyOn(piMessageBridge, "modelMessagesToPiMessages");
    let steps = 0;
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async () => {
        steps += 1;
        return {
          assistant: {
            role: "assistant",
            content:
              steps === 1
                ? [{ type: "toolCall", id: "lookup", name: "lookup", arguments: {} }]
                : [{ type: "text", text: "done" }],
            stopReason: steps === 1 ? "tool_calls" : "stop",
          },
          interactionId: `interaction_${steps}`,
        };
      },
    });
    try {
      await runtime.runTurn(
        makeParams(config, { maxSteps: 2, tools: { lookup: { execute: () => "found" } } }),
      );
      expect(steps).toBe(2);
      expect(bridge).toHaveBeenCalledTimes(2);
      expect(options).toHaveBeenCalledTimes(0);
    } finally {
      bridge.mockRestore();
      options.mockRestore();
      resolveModel.mockRestore();
    }
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
    const timeline: string[] = [];
    const completedSnapshots: unknown[] = [];
    const finishParts: unknown[] = [];
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
            execute: async () => {
              timeline.push("tool");
              return { type: "text", value: "tool result" };
            },
          },
        },
        onModelStreamPart: (part) => {
          const record = part as Record<PropertyKey, unknown>;
          if (record.type !== "finish-step") return;
          timeline.push("finish-step");
          const progress = record[RUNTIME_COMMITTED_PROGRESS] as
            | RuntimeCommittedProgress
            | undefined;
          completedSnapshots.push(structuredClone(progress?.assistantMessages));
          finishParts.push(part);
        },
      }),
    );

    expect(timeline).toEqual(["finish-step", "tool", "finish-step"]);
    expect(completedSnapshots).toEqual([
      [result.responseMessages[0]],
      [result.responseMessages[2]],
    ]);
    expect(JSON.stringify(finishParts)).not.toContain("sig_");
    for (const part of finishParts) {
      expect(
        JSON.stringify(
          normalizeModelStreamPart(part, {
            provider: "google",
            includeRawPart: true,
            rawPartMode: "full",
          }),
        ),
      ).not.toContain("sig_");
    }
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
