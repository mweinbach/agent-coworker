import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";
import {
  __internal as openAiNativeInternal,
  runOpenAiNativeResponseStep,
} from "../src/runtime/openaiNativeResponses";
import * as openAiResponsesModel from "../src/runtime/openaiResponsesModel";
import { createOpenAiResponsesRuntime } from "../src/runtime/openaiResponsesRuntime";
import * as piMessageBridge from "../src/runtime/piMessageBridge";
import type { PiModel } from "../src/runtime/piRuntimeOptions";
import {
  type PartialTurnError,
  RUNTIME_COMMITTED_PROGRESS,
  type RuntimeCommittedProgress,
  type RuntimeRunTurnParams,
} from "../src/runtime/types";
import { normalizeModelStreamPart } from "../src/server/modelStream";
import {
  MODEL_SCRATCHPAD_DIRNAME,
  TOOL_OUTPUT_OVERFLOW_PREVIEW_CHARS,
} from "../src/shared/toolOutputOverflow";
import type { AgentConfig, ModelMessage } from "../src/types";

function makeConfig(homeDir: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: "openai",
    model: "gpt-5.2",
    preferredChildModel: "gpt-5.2",
    workingDirectory: homeDir,
    outputDirectory: path.join(homeDir, "output"),
    uploadsDirectory: path.join(homeDir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(homeDir, ".agent-project"),
    userCoworkDir: path.join(homeDir, ".cowork"),
    builtInDir: homeDir,
    builtInConfigDir: path.join(homeDir, "config"),
    skillsDirs: [path.join(homeDir, ".cowork", "skills")],
    memoryDirs: [],
    configDirs: [],
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

describe("openai responses runtime", () => {
  test.each(["matching", "changed-header"] as const)(
    "preserves initial fingerprint bytes separately from step overrides: %s",
    async (context) => {
      const legacyFingerprint =
        '{"modelId":"gpt-5.2","streamOptions":{"headers":{"x-test":"resolved"},"reasoningEffort":"medium","reasoningSummary":"auto","temperature":0.25,"textVerbosity":"low"},"system":"You are helpful.","tools":[]}';
      const resolveModel = openAiResponsesModel.resolveOpenAiResponsesModel;
      const resolveModelSpy = spyOn(
        openAiResponsesModel,
        "resolveOpenAiResponsesModel",
      ).mockImplementation(async (params) => ({
        ...(await resolveModel(params)),
        apiKey: "resolved-secret",
        headers: { "x-test": context === "changed-header" ? "changed" : "resolved" },
      }));
      try {
        const history: ModelMessage[] = [
          { role: "user", content: "old question" },
          { role: "assistant", content: "old answer" },
          { role: "user", content: "new question" },
        ];
        const steeredMessages: ModelMessage[] = [{ role: "user", content: "steered question" }];
        const preparedMessages: ModelMessage[][] = [];
        const seenRequests: Array<Parameters<typeof runOpenAiNativeResponseStep>[0]> = [];
        const runtime = createOpenAiResponsesRuntime({
          runStepImpl: async (request) => {
            seenRequests.push(request);
            return {
              assistant: {
                role: "assistant",
                content: [{ type: "text", text: "answer" }],
                stopReason: "stop",
              },
              responseId: "resp_next",
            };
          },
        });
        const signal = new AbortController().signal;
        const result = await runtime.runTurn(
          makeParams(
            makeConfig(path.join(import.meta.dir, "fixtures", "fingerprint-options"), {
              providerOptions: { openai: { temperature: 0.99, reasoningEffort: "low" } },
            }),
            {
              messages: history.slice(-1),
              allMessages: history,
              abortSignal: signal,
              providerOptions: {
                openai: {
                  textVerbosity: "low",
                  temperature: 0.25,
                  reasoningSummary: "auto",
                  reasoningEffort: "medium",
                },
              },
              providerState: {
                provider: "openai",
                model: "gpt-5.2",
                responseId: "resp_saved",
                updatedAt: "2026-03-18T12:00:00.000Z",
                requestFingerprint: legacyFingerprint,
              },
              prepareStep: async ({ messages }) => {
                preparedMessages.push(messages);
                return {
                  messages: steeredMessages,
                  providerOptions: {
                    openai: { reasoningEffort: "high", temperature: 0.5, textVerbosity: "high" },
                  },
                  streamOptions: {
                    reasoningEffort: "xhigh",
                    apiKey: "step-secret",
                    headers: { "x-test": "step" },
                  },
                };
              },
            },
          ),
        );

        expect(preparedMessages).toEqual([
          context === "changed-header" ? history : history.slice(-1),
        ]);
        expect(seenRequests).toHaveLength(1);
        expect(seenRequests[0]?.previousResponseId).toBe(
          context === "changed-header" ? undefined : "resp_saved",
        );
        expect(seenRequests[0]?.piMessages).toMatchObject([
          { role: "user", content: "steered question" },
        ]);
        expect(seenRequests[0]?.apiKey).toBe("step-secret");
        expect(seenRequests[0]?.headers).toEqual({ "x-test": "step" });
        expect(seenRequests[0]?.streamOptions).toEqual({
          apiKey: "step-secret",
          signal,
          headers: { "x-test": "step" },
          reasoningEffort: "xhigh",
          temperature: 0.5,
          textVerbosity: "high",
        });
        expect(result.providerState).toMatchObject({
          responseId: "resp_next",
          requestFingerprint:
            context === "changed-header"
              ? legacyFingerprint.replace('"resolved"', '"changed"')
              : legacyFingerprint,
        });
      } finally {
        resolveModelSpy.mockRestore();
      }
    },
  );

  test.each(["fresh", "matching", "stale"] as const)(
    "converts only actual request messages, not fingerprint history: %s",
    async (continuation) => {
      const history: ModelMessage[] = [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "new question" },
      ];
      const bridge = spyOn(piMessageBridge, "modelMessagesToPiMessages");
      try {
        const seenRequests: Array<Parameters<typeof runOpenAiNativeResponseStep>[0]> = [];
        const runtime = createOpenAiResponsesRuntime({
          runStepImpl: async (request) => {
            seenRequests.push(request);
            return {
              assistant: {
                role: "assistant",
                content: [{ type: "text", text: "answer" }],
                stopReason: "stop",
              },
              responseId: "resp_next",
            };
          },
        });
        await runtime.runTurn(
          makeParams(makeConfig(path.join(import.meta.dir, "fixtures", "fingerprint-history")), {
            messages: history.slice(-1),
            allMessages: history,
            providerState:
              continuation === "fresh"
                ? undefined
                : {
                    provider: "openai",
                    model: "gpt-5.2",
                    responseId: "resp_saved",
                    updatedAt: "2026-03-18T12:00:00.000Z",
                    requestFingerprint:
                      continuation === "stale"
                        ? "outdated-fingerprint"
                        : '{"modelId":"gpt-5.2","streamOptions":{},"system":"You are helpful.","tools":[]}',
                  },
          }),
        );

        const expectedMessages = continuation === "matching" ? history.slice(-1) : history;
        expect(seenRequests).toHaveLength(1);
        expect(seenRequests[0]?.previousResponseId).toBe(
          continuation === "matching" ? "resp_saved" : undefined,
        );
        expect(seenRequests[0]?.piMessages.map((message) => message.role)).toEqual(
          expectedMessages.map((message) => message.role),
        );
        expect(bridge.mock.calls.map(([messages]) => messages)).toEqual([expectedMessages]);
      } finally {
        bridge.mockRestore();
      }
    },
  );

  test("finish-step carries signed assistant history internally before tool execution", async () => {
    const runtime = createOpenAiResponsesRuntime({
      runStepImpl: async () => ({
        assistant: {
          role: "assistant",
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.2",
          content: [
            {
              type: "thinking",
              thinking: "Check the report first.",
              thinkingSignature: "snapshot-reasoning-signature",
            },
            {
              type: "text",
              text: "I will check the report.",
              textSignature: "snapshot-text-signature",
            },
            {
              type: "toolCall",
              id: "call_lookup|fc_lookup",
              name: "lookup",
              arguments: { path: "report.txt" },
            },
          ],
          stopReason: "toolUse",
        },
        responseId: "resp_completed_step",
      }),
    });
    const timeline: string[] = [];
    const completedSnapshots: unknown[] = [];
    const finishParts: unknown[] = [];
    const result = await runtime.runTurn(
      makeParams(makeConfig(path.join(import.meta.dir, "fixtures", "completed-step")), {
        tools: {
          lookup: {
            execute: () => {
              timeline.push("tool");
              return "report found";
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

    expect(timeline).toEqual(["finish-step", "tool"]);
    expect(completedSnapshots).toEqual([[result.responseMessages[0]]]);
    expect(completedSnapshots[0]).toEqual([
      {
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.2",
        content: [
          {
            type: "reasoning",
            text: "Check the report first.",
            thinkingSignature: "snapshot-reasoning-signature",
          },
          {
            type: "text",
            text: "I will check the report.",
            textSignature: "snapshot-text-signature",
          },
          {
            type: "tool-call",
            toolCallId: "call_lookup|fc_lookup",
            toolName: "lookup",
            input: { path: "report.txt" },
          },
        ],
      },
    ]);
    expect(JSON.stringify(finishParts)).not.toContain("snapshot-");
    expect(
      JSON.stringify(
        normalizeModelStreamPart(finishParts[0], {
          provider: "openai",
          includeRawPart: true,
          rawPartMode: "full",
        }),
      ),
    ).not.toContain("snapshot-");
  });

  test.each(["response.incomplete", "unexpected EOF"] as const)(
    "%s preserves partial text without executing unfinished tool calls",
    async (terminal) => {
      const events: Array<Record<string, unknown>> = [
        { type: "response.created", response: { id: "resp_partial", status: "in_progress" } },
        {
          type: "response.output_item.added",
          item: { type: "message", id: "msg_partial", role: "assistant", content: [] },
        },
        {
          type: "response.content_part.added",
          part: { type: "output_text", text: "", annotations: [] },
        },
        { type: "response.output_text.delta", delta: "Partial answer" },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            id: "msg_partial",
            role: "assistant",
            content: [{ type: "output_text", text: "Partial answer", annotations: [] }],
          },
        },
        {
          type: "response.output_item.added",
          item: {
            type: "function_call",
            id: "fc_partial",
            call_id: "call_partial",
            name: "write",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_partial",
          delta: '{"path":"important.txt","content":"part',
        },
      ];
      if (terminal === "response.incomplete") {
        events.push({
          type: terminal,
          response: {
            id: "resp_partial",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
          },
        });
      }
      const realFetch = globalThis.fetch;
      const executedInputs: unknown[] = [];
      const emittedParts: unknown[] = [];
      let modelErrors = 0;
      globalThis.fetch = (async () =>
        new Response(events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""), {
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch;

      try {
        const runtime = createOpenAiResponsesRuntime({
          runStepImpl: (opts) => runOpenAiNativeResponseStep({ ...opts, apiKey: "test-api-key" }),
        });
        let failure: PartialTurnError | undefined;
        try {
          await runtime.runTurn(
            makeParams(makeConfig(path.join(import.meta.dir, "fixtures", "openai-stream")), {
              tools: {
                write: {
                  execute: (input) => {
                    executedInputs.push(input);
                    return "written";
                  },
                },
              },
              onModelStreamPart: (part) => {
                emittedParts.push(part);
              },
              onModelError: () => {
                modelErrors += 1;
              },
            }),
          );
        } catch (error) {
          failure = error as PartialTurnError;
        }

        expect(failure).toBeInstanceOf(Error);
        expect(executedInputs).toEqual([]);
        expect(modelErrors).toBe(1);
        expect(failure?.responseMessages).toEqual([
          { role: "assistant", content: [{ type: "text", text: "Partial answer" }] },
        ]);
        expect(failure?.providerState).toBeNull();
        expect(emittedParts).not.toContainEqual(expect.objectContaining({ type: "finish-step" }));
        if (terminal === "response.incomplete") {
          expect(failure?.message).toContain("max_output_tokens");
          expect(failure?.usage).toMatchObject({
            promptTokens: 12,
            completionTokens: 5,
            totalTokens: 17,
          });
          expect(failure?.requestUsages).toEqual([
            expect.objectContaining({ promptTokens: 12, completionTokens: 5, totalTokens: 17 }),
          ]);
        } else {
          expect(failure?.message).toContain("before completion");
          expect(failure?.usage).toBeUndefined();
          expect(failure?.requestUsages).toBeUndefined();
        }
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  );

  test("replays failed-turn input after partial output invalidates the saved continuation", async () => {
    const config = makeConfig(path.join(import.meta.dir, "fixtures", "failed-continuation"));
    const priorState = {
      provider: "openai" as const,
      model: config.model,
      responseId: "resp_previous_turn",
      updatedAt: "2026-03-18T12:00:00.000Z",
    };
    const history: ModelMessage[] = [
      { role: "user", content: "Prior question" },
      { role: "assistant", content: [{ type: "text", text: "Prior answer" }] },
      { role: "user", content: "Remember this failed-turn instruction" },
    ];
    const requests: Array<Record<string, unknown>> = [];
    const runtime = createOpenAiResponsesRuntime({
      runStepImpl: async (opts) => {
        requests.push({ previousResponseId: opts.previousResponseId, messages: opts.piMessages });
        if (requests.length === 1) {
          const failure = new Error("Incomplete model response") as PartialTurnError;
          failure.responseMessages = [
            { role: "assistant", content: [{ type: "text", text: "Partial answer" }] },
          ];
          throw failure;
        }
        return {
          assistant: {
            role: "assistant",
            content: [{ type: "text", text: "Recovered" }],
            stopReason: "stop",
          },
          responseId: "resp_recovered",
        };
      },
    });
    let failure: PartialTurnError | undefined;
    try {
      await runtime.runTurn(
        makeParams(config, { messages: history, allMessages: history, providerState: priorState }),
      );
    } catch (error) {
      failure = error as PartialTurnError;
    }
    expect(failure).toBeDefined();
    const resumedHistory: ModelMessage[] = [
      ...history,
      ...(failure?.responseMessages ?? []),
      { role: "user", content: "Continue" },
    ];
    await runtime.runTurn(
      makeParams(config, {
        messages: resumedHistory,
        allMessages: resumedHistory,
        providerState:
          failure && Object.hasOwn(failure, "providerState") ? failure.providerState : priorState,
      }),
    );
    expect(requests[1]?.previousResponseId).toBeUndefined();
    expect(JSON.stringify(requests[1]?.messages)).toContain(
      "Remember this failed-turn instruction",
    );
    expect(JSON.stringify(requests[1]?.messages)).toContain("Partial answer");
  });

  test("ignores commentary-phase assistant text in final runtime text and responseMessages", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openai-runtime-commentary-"));
    const runtime = createOpenAiResponsesRuntime({
      runStepImpl: async () => ({
        assistant: {
          role: "assistant",
          content: [
            { type: "text", text: "progress note", phase: "commentary" },
            { type: "text", text: "final answer", phase: "final_answer" },
          ],
          usage: { input: 1, output: 1, totalTokens: 2 },
          stopReason: "stop",
        },
        responseId: "resp_commentary",
      }),
    });

    const result = await runtime.runTurn(makeParams(makeConfig(homeDir)));

    expect(result.text).toBe("final answer");
    expect(result.responseMessages).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "final answer", phase: "final_answer" }],
      },
    ]);
  });

  test("keeps cached prompt tokens and provider-computed cost in runtime usage", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openai-runtime-cached-usage-"));
    const runtime = createOpenAiResponsesRuntime({
      runStepImpl: async () => ({
        assistant: {
          role: "assistant",
          content: [{ type: "text", text: "final answer" }],
          usage: {
            input: 80,
            output: 20,
            totalTokens: 130,
            cacheRead: 30,
            cost: {
              total: 0.00123,
            },
          },
          stopReason: "stop",
        },
        responseId: "resp_cached_usage",
      }),
    });

    const result = await runtime.runTurn(makeParams(makeConfig(homeDir)));

    expect(result.usage).toEqual({
      promptTokens: 110,
      completionTokens: 20,
      totalTokens: 130,
      cachedPromptTokens: 30,
      estimatedCostUsd: 0.00123,
    });
  });

  test("seeds first OpenAI turn from full history when no continuation state exists", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openai-runtime-seed-"));
    const nativeCalls: Array<Record<string, unknown>> = [];
    const runtime = createOpenAiResponsesRuntime({
      runStepImpl: async (opts) => {
        nativeCalls.push({
          previousResponseId: opts.previousResponseId,
          piMessages: opts.piMessages,
        });
        return {
          assistant: {
            role: "assistant",
            content: [{ type: "text", text: "seeded" }],
            usage: { input: 1, output: 1, totalTokens: 2 },
            stopReason: "stop",
          },
          responseId: "resp_seed",
        };
      },
    });

    const result = await runtime.runTurn(
      makeParams(makeConfig(homeDir), {
        messages: [{ role: "user", content: "latest" }],
        allMessages: [
          { role: "user", content: "older user" },
          { role: "assistant", content: "older assistant" },
          { role: "user", content: "latest" },
        ] as ModelMessage[],
      }),
    );

    expect(nativeCalls).toHaveLength(1);
    expect(nativeCalls[0]?.previousResponseId).toBeUndefined();
    expect((nativeCalls[0]?.piMessages as Array<unknown>) ?? []).toHaveLength(3);
    expect(result.providerState?.responseId).toBe("resp_seed");
  });

  test("chains later OpenAI steps through previous_response_id and only sends tool results", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openai-runtime-chain-"));
    const nativeCalls: Array<Record<string, unknown>> = [];
    let step = 0;
    const runtime = createOpenAiResponsesRuntime({
      runStepImpl: async (opts) => {
        step += 1;
        nativeCalls.push({
          previousResponseId: opts.previousResponseId,
          piMessages: opts.piMessages,
        });

        if (step === 1) {
          return {
            assistant: {
              role: "assistant",
              content: [
                { type: "toolCall", id: "call_1", name: "lookup", arguments: { query: "needle" } },
              ],
              usage: { input: 1, output: 1, totalTokens: 2 },
              stopReason: "toolUse",
            },
            responseId: "resp_1",
          };
        }

        return {
          assistant: {
            role: "assistant",
            content: [{ type: "text", text: "final answer" }],
            usage: { input: 1, output: 1, totalTokens: 2 },
            stopReason: "stop",
          },
          responseId: "resp_2",
        };
      },
    });

    const result = await runtime.runTurn(
      makeParams(makeConfig(homeDir), {
        messages: [{ role: "user", content: "find it" }],
        allMessages: [{ role: "user", content: "find it" }] as ModelMessage[],
        maxSteps: 2,
        tools: {
          lookup: {
            execute: async () => "found it",
          },
        },
      }),
    );

    expect(nativeCalls).toHaveLength(2);
    expect(nativeCalls[0]?.previousResponseId).toBeUndefined();
    expect(nativeCalls[1]?.previousResponseId).toBe("resp_1");
    const secondPiMessages = (nativeCalls[1]?.piMessages as Array<Record<string, unknown>>) ?? [];
    expect(secondPiMessages).toHaveLength(1);
    expect(secondPiMessages[0]?.role).toBe("toolResult");
    expect(result.providerState?.responseId).toBe("resp_2");
    expect(result.requestUsages).toEqual([
      { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    ]);
  });

  test("stops after a tool step when a task input directive requests a pause", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openai-runtime-task-pause-"));
    let modelSteps = 0;
    let toolCalls = 0;
    const runtime = createOpenAiResponsesRuntime({
      runStepImpl: async () => {
        modelSteps += 1;
        return {
          assistant: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_1", name: "requestInput", arguments: {} }],
            usage: { input: 1, output: 1, totalTokens: 2 },
            stopReason: "toolUse",
          },
          responseId: "resp_pause",
        };
      },
    });

    const result = await runtime.runTurn(
      makeParams(makeConfig(homeDir), {
        maxSteps: 3,
        shouldStopAfterToolStep: () => true,
        tools: {
          requestInput: {
            execute: async () => {
              toolCalls += 1;
              return "Task paused for input";
            },
          },
        },
      }),
    );

    expect(modelSteps).toBe(1);
    expect(toolCalls).toBe(1);
    expect(result.providerState?.responseId).toBe("resp_pause");
    expect(result.responseMessages.some((message) => message.role === "tool")).toBe(true);
  });

  test("provider-managed continuation uses overflow pointer text instead of the full spilled tool payload", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openai-runtime-overflow-"));
    const nativeCalls: Array<Record<string, unknown>> = [];
    const hugeTailMarker = "__TAIL_MARKER__";
    const hugeToolOutput = `${"0123456789abcdef".repeat(
      Math.ceil((TOOL_OUTPUT_OVERFLOW_PREVIEW_CHARS + 256) / 16),
    )}${hugeTailMarker}`;
    let step = 0;
    const runtime = createOpenAiResponsesRuntime({
      runStepImpl: async (opts) => {
        step += 1;
        nativeCalls.push({
          previousResponseId: opts.previousResponseId,
          piMessages: opts.piMessages,
        });

        if (step === 1) {
          return {
            assistant: {
              role: "assistant",
              content: [
                { type: "toolCall", id: "call_1", name: "lookup", arguments: { query: "needle" } },
              ],
              usage: { input: 1, output: 1, totalTokens: 2 },
              stopReason: "toolUse",
            },
            responseId: "resp_1",
          };
        }

        return {
          assistant: {
            role: "assistant",
            content: [{ type: "text", text: "final answer" }],
            usage: { input: 1, output: 1, totalTokens: 2 },
            stopReason: "stop",
          },
          responseId: "resp_2",
        };
      },
    });

    const result = await runtime.runTurn(
      makeParams(makeConfig(homeDir, { toolOutputOverflowChars: 80 }), {
        messages: [{ role: "user", content: "find it" }],
        allMessages: [{ role: "user", content: "find it" }] as ModelMessage[],
        maxSteps: 2,
        tools: {
          lookup: {
            execute: async () => hugeToolOutput,
          },
        },
      }),
    );

    expect(nativeCalls).toHaveLength(2);
    const secondPiMessages = (nativeCalls[1]?.piMessages as Array<Record<string, unknown>>) ?? [];
    expect(secondPiMessages).toHaveLength(1);
    expect(secondPiMessages[0]?.role).toBe("toolResult");

    const serialized = JSON.stringify(secondPiMessages[0]);
    expect(serialized).toContain("Tool output overflowed");
    expect(serialized).toContain(MODEL_SCRATCHPAD_DIRNAME);
    expect(serialized).not.toContain(hugeTailMarker);

    const scratchFiles = await fs.readdir(path.join(homeDir, MODEL_SCRATCHPAD_DIRNAME));
    expect(scratchFiles).toHaveLength(1);
    const saved = await fs.readFile(
      path.join(homeDir, MODEL_SCRATCHPAD_DIRNAME, scratchFiles[0]!),
      "utf-8",
    );
    expect(saved).toContain(hugeTailMarker);
    expect(result.providerState?.responseId).toBe("resp_2");
  });

  test("provider-managed continuation keeps oversized read results inline", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openai-runtime-read-inline-"));
    const nativeCalls: Array<Record<string, unknown>> = [];
    const hugeTailMarker = "__READ_TAIL_MARKER__";
    const hugeReadOutput = `${"0123456789abcdef".repeat(
      Math.ceil((TOOL_OUTPUT_OVERFLOW_PREVIEW_CHARS + 256) / 16),
    )}${hugeTailMarker}`;
    let step = 0;
    const runtime = createOpenAiResponsesRuntime({
      runStepImpl: async (opts) => {
        step += 1;
        nativeCalls.push({
          previousResponseId: opts.previousResponseId,
          piMessages: opts.piMessages,
        });

        if (step === 1) {
          return {
            assistant: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "call_1",
                  name: "read",
                  arguments: { filePath: "/tmp/big.txt" },
                },
              ],
              usage: { input: 1, output: 1, totalTokens: 2 },
              stopReason: "toolUse",
            },
            responseId: "resp_1",
          };
        }

        return {
          assistant: {
            role: "assistant",
            content: [{ type: "text", text: "final answer" }],
            usage: { input: 1, output: 1, totalTokens: 2 },
            stopReason: "stop",
          },
          responseId: "resp_2",
        };
      },
    });

    const result = await runtime.runTurn(
      makeParams(makeConfig(homeDir, { toolOutputOverflowChars: 80 }), {
        messages: [{ role: "user", content: "read it" }],
        allMessages: [{ role: "user", content: "read it" }] as ModelMessage[],
        maxSteps: 2,
        tools: {
          read: {
            inputSchema: z.object({ filePath: z.string() }),
            execute: async () => hugeReadOutput,
          },
        },
      }),
    );

    expect(nativeCalls).toHaveLength(2);
    const secondPiMessages = (nativeCalls[1]?.piMessages as Array<Record<string, unknown>>) ?? [];
    expect(secondPiMessages).toHaveLength(1);
    expect(secondPiMessages[0]?.role).toBe("toolResult");

    const toolContent =
      (secondPiMessages[0]?.content as Array<Record<string, unknown>> | undefined) ?? [];
    expect(toolContent).toEqual([{ type: "text", text: hugeReadOutput }]);
    expect(JSON.stringify(secondPiMessages[0])).toContain(hugeTailMarker);
    expect(JSON.stringify(secondPiMessages[0])).not.toContain("Tool output overflowed");
    await expect(fs.readdir(path.join(homeDir, MODEL_SCRATCHPAD_DIRNAME))).rejects.toThrow();
    expect(result.providerState?.responseId).toBe("resp_2");
  });

  test("chains overflowed tool results through continuation using the spill-file pointer text", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openai-runtime-overflow-chain-"));
    const nativeCalls: Array<Record<string, unknown>> = [];
    const oversized = "overflow-result-".repeat(400);
    let step = 0;
    const runtime = createOpenAiResponsesRuntime({
      runStepImpl: async (opts) => {
        step += 1;
        nativeCalls.push({
          previousResponseId: opts.previousResponseId,
          piMessages: opts.piMessages,
        });

        if (step === 1) {
          return {
            assistant: {
              role: "assistant",
              content: [
                { type: "toolCall", id: "call_1", name: "lookup", arguments: { query: "needle" } },
              ],
              usage: { input: 1, output: 1, totalTokens: 2 },
              stopReason: "toolUse",
            },
            responseId: "resp_1",
          };
        }

        return {
          assistant: {
            role: "assistant",
            content: [{ type: "text", text: "final answer" }],
            usage: { input: 1, output: 1, totalTokens: 2 },
            stopReason: "stop",
          },
          responseId: "resp_2",
        };
      },
    });

    const result = await runtime.runTurn(
      makeParams(makeConfig(homeDir, { toolOutputOverflowChars: 120 }), {
        messages: [{ role: "user", content: "find it" }],
        allMessages: [{ role: "user", content: "find it" }] as ModelMessage[],
        maxSteps: 2,
        tools: {
          lookup: {
            execute: async () => oversized,
          },
        },
      }),
    );

    expect(nativeCalls).toHaveLength(2);
    expect(nativeCalls[1]?.previousResponseId).toBe("resp_1");

    const secondPiMessages = (nativeCalls[1]?.piMessages as Array<Record<string, unknown>>) ?? [];
    expect(secondPiMessages).toHaveLength(1);
    expect(secondPiMessages[0]?.role).toBe("toolResult");

    const toolContent =
      (secondPiMessages[0]?.content as Array<Record<string, unknown>> | undefined) ?? [];
    expect(toolContent).toHaveLength(1);
    expect(toolContent[0]?.type).toBe("text");
    const pointerText = String(toolContent[0]?.text ?? "");
    expect(pointerText).toContain("Tool output overflowed");
    expect(pointerText).toContain(path.join(homeDir, ".ModelScratchpad"));
    expect(pointerText.length).toBeLessThan(oversized.length);

    expect(result.providerState?.responseId).toBe("resp_2");
  });

  test("request builder marks OpenAI tools as non-strict so optional parameters remain valid", () => {
    const request = openAiNativeInternal.buildOpenAiNativeRequest({
      provider: "openai",
      model: {
        id: "gpt-5.2",
        name: "gpt-5.2",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 32768,
      },
      systemPrompt: "You are helpful.",
      piMessages: [{ role: "user", content: "hello" }],
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: {
              filePath: { type: "string" },
              offset: { type: "integer" },
            },
            required: ["filePath"],
          },
        },
      ],
      streamOptions: {},
    });

    expect(request.tools).toEqual([
      {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            filePath: { type: "string" },
            offset: { type: "integer" },
          },
          required: ["filePath"],
        },
        strict: false,
      },
    ]);
  });

  test("OpenAI path preserves requested verbosity and continuation fields", () => {
    const request = openAiNativeInternal.buildOpenAiNativeRequest({
      provider: "openai",
      model: {
        id: "gpt-5.2",
        name: "gpt-5.2",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 32768,
      },
      systemPrompt: "You are helpful.",
      piMessages: [{ role: "user", content: "hello" }],
      tools: [],
      streamOptions: {
        textVerbosity: "high",
        maxTokens: 128,
      },
      previousResponseId: "resp_previous",
    });

    expect(request.store).toBe(true);
    expect(request.truncation).toBe("auto");
    expect(request.previous_response_id).toBe("resp_previous");
    expect(request.max_output_tokens).toBe(128);
    expect(request.text).toEqual({ verbosity: "high" });
  });

  test("OpenAI request builder normalizes reasoning effort sentinels", () => {
    const model = {
      id: "gpt-5.2",
      name: "gpt-5.2",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 32768,
    } satisfies PiModel;

    const xhighRequest = openAiNativeInternal.buildOpenAiNativeRequest({
      provider: "openai",
      model,
      systemPrompt: "You are helpful.",
      piMessages: [{ role: "user", content: "hello" }],
      tools: [],
      streamOptions: {
        reasoningEffort: "xhigh",
      },
    });
    expect(xhighRequest.reasoning).toEqual({ effort: "xhigh", summary: "auto" });

    const gpt54Request = openAiNativeInternal.buildOpenAiNativeRequest({
      provider: "openai",
      model: {
        ...model,
        id: "gpt-5.4",
        name: "gpt-5.4",
      },
      systemPrompt: "You are helpful.",
      piMessages: [{ role: "user", content: "hello" }],
      tools: [],
      streamOptions: {
        reasoningEffort: "xhigh",
      },
    });
    expect(gpt54Request.reasoning).toEqual({ effort: "xhigh", summary: "auto" });

    const gpt5Request = openAiNativeInternal.buildOpenAiNativeRequest({
      provider: "openai",
      model: {
        ...model,
        id: "gpt-5",
        name: "gpt-5",
      },
      systemPrompt: "You are helpful.",
      piMessages: [{ role: "user", content: "hello" }],
      tools: [],
      streamOptions: {
        reasoningEffort: "xhigh",
      },
    });
    expect(gpt5Request.reasoning).toEqual({ effort: "high", summary: "auto" });

    const noneRequest = openAiNativeInternal.buildOpenAiNativeRequest({
      provider: "openai",
      model,
      systemPrompt: "You are helpful.",
      piMessages: [{ role: "user", content: "hello" }],
      tools: [],
      streamOptions: {
        reasoningEffort: "none",
      },
    });
    expect(noneRequest.reasoning).toBeUndefined();

    // The Responses API has no "max" tier; downgrade to the model's ceiling.
    const maxRequest = openAiNativeInternal.buildOpenAiNativeRequest({
      provider: "openai",
      model,
      systemPrompt: "You are helpful.",
      piMessages: [{ role: "user", content: "hello" }],
      tools: [],
      streamOptions: {
        reasoningEffort: "max",
      },
    });
    expect(maxRequest.reasoning).toEqual({ effort: "xhigh", summary: "auto" });

    const maxOnLegacyRequest = openAiNativeInternal.buildOpenAiNativeRequest({
      provider: "openai",
      model: {
        ...model,
        id: "gpt-5",
        name: "gpt-5",
      },
      systemPrompt: "You are helpful.",
      piMessages: [{ role: "user", content: "hello" }],
      tools: [],
      streamOptions: {
        reasoningEffort: "max",
      },
    });
    expect(maxOnLegacyRequest.reasoning).toEqual({ effort: "high", summary: "auto" });

    // "light" maps to the nearest API-native level.
    const lightRequest = openAiNativeInternal.buildOpenAiNativeRequest({
      provider: "openai",
      model,
      systemPrompt: "You are helpful.",
      piMessages: [{ role: "user", content: "hello" }],
      tools: [],
      streamOptions: {
        reasoningEffort: "light",
      },
    });
    expect(lightRequest.reasoning).toEqual({ effort: "low", summary: "auto" });
  });

  test.each(["none", "detailed", "opaque"] as const)(
    "records and attaches usage to thrown error when turn fails mid-way: %s",
    async (partialKind) => {
      const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openai-runtime-failure-usage-"));
      let stepCount = 0;
      const runtime = createOpenAiResponsesRuntime({
        runStepImpl: async () => {
          stepCount += 1;
          if (stepCount === 1) {
            return {
              assistant: {
                role: "assistant",
                content: [{ type: "toolCall", id: "call_1", name: "some_tool", arguments: {} }],
                usage: {
                  input: 50,
                  output: 10,
                  totalTokens: 60,
                },
                stopReason: "toolUse",
              },
              responseId: "resp_step_1",
            };
          }
          const failure = new Error("API call failed on step 2") as PartialTurnError;
          if (partialKind !== "none") {
            failure.usage = { promptTokens: 3, completionTokens: 2, totalTokens: 5 };
            failure.responseMessages = [
              { role: "assistant", content: [{ type: "text", text: "Partial second answer" }] },
            ];
            if (partialKind === "detailed") failure.requestUsages = [failure.usage];
          }
          throw failure;
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
      expect(thrownError.message).toContain("API call failed on step 2");
      expect(thrownError.usage).toEqual({
        promptTokens: partialKind === "none" ? 50 : 53,
        completionTokens: partialKind === "none" ? 10 : 12,
        totalTokens: partialKind === "none" ? 60 : 65,
      });
      expect(thrownError.providerState).toBeNull();
      expect(thrownError.responseMessages).toHaveLength(partialKind === "none" ? 2 : 3);
      expect(thrownError.requestUsages).toEqual(
        partialKind === "opaque"
          ? undefined
          : [
              { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
              ...(partialKind === "detailed"
                ? [{ promptTokens: 3, completionTokens: 2, totalTokens: 5 }]
                : []),
            ],
      );
    },
  );
});
