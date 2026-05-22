import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";
import { __internal as openAiNativeInternal } from "../src/runtime/openaiNativeResponses";
import { createOpenAiResponsesRuntime } from "../src/runtime/openaiResponsesRuntime";
import type { PiModel } from "../src/runtime/piRuntimeOptions";
import type { RuntimeRunTurnParams } from "../src/runtime/types";
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
    expect(xhighRequest.reasoning).toEqual({ effort: "high", summary: "auto" });

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
  });

  test("records and attaches usage to thrown error when turn fails mid-way", async () => {
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
        throw new Error("API call failed on step 2");
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
      promptTokens: 50,
      completionTokens: 10,
      totalTokens: 60,
    });
  });
});
