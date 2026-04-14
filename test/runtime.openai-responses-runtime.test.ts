import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { createOpenAiResponsesRuntime } from "../src/runtime/openaiResponsesRuntime";
import { defaultSupportedModel } from "../src/models/registry";
import { writeCodexAuthMaterial } from "../src/providers/codex-auth";
import { __internal as openAiNativeInternal } from "../src/runtime/openaiNativeResponses";
import {
  MODEL_SCRATCHPAD_DIRNAME,
  TOOL_OUTPUT_OVERFLOW_PREVIEW_CHARS,
} from "../src/shared/toolOutputOverflow";
import type { RuntimeRunTurnParams } from "../src/runtime/types";
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
    projectAgentDir: path.join(homeDir, ".agent-project"),
    userAgentDir: path.join(homeDir, ".agent"),
    builtInDir: homeDir,
    builtInConfigDir: path.join(homeDir, "config"),
    skillsDirs: [path.join(homeDir, ".cowork", "skills")],
    memoryDirs: [],
    configDirs: [],
    ...overrides,
  };
}

function makeParams(config: AgentConfig, overrides: Partial<RuntimeRunTurnParams> = {}): RuntimeRunTurnParams {
  return {
    config,
    system: "You are helpful.",
    messages: [{ role: "user", content: "hello" }] as ModelMessage[],
    tools: {},
    maxSteps: 1,
    ...overrides,
  };
}

function pickCodexModelId(): string {
  return defaultSupportedModel("codex-cli").id;
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
              content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: { query: "needle" } }],
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
              content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: { query: "needle" } }],
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
    const saved = await fs.readFile(path.join(homeDir, MODEL_SCRATCHPAD_DIRNAME, scratchFiles[0]!), "utf-8");
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
              content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { filePath: "/tmp/big.txt" } }],
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

    const toolContent = (secondPiMessages[0]?.content as Array<Record<string, unknown>> | undefined) ?? [];
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
              content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: { query: "needle" } }],
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

    const toolContent = (secondPiMessages[0]?.content as Array<Record<string, unknown>> | undefined) ?? [];
    expect(toolContent).toHaveLength(1);
    expect(toolContent[0]?.type).toBe("text");
    const pointerText = String(toolContent[0]?.text ?? "");
    expect(pointerText).toContain("Tool output overflowed");
    expect(pointerText).toContain(path.join(homeDir, ".ModelScratchpad"));
    expect(pointerText.length).toBeLessThan(oversized.length);

    expect(result.providerState?.responseId).toBe("resp_2");
  });

  test("codex chatgpt backend always seeds from full history and does not persist provider continuation state", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-runtime-seed-"));
    await writeCodexAuthMaterial(
      {
        rootDir: path.join(homeDir, ".cowork"),
        authDir: path.join(homeDir, ".cowork", "auth"),
      },
      {
        accessToken: "tok_live",
        refreshToken: "refresh_live",
        accountId: "acct_123",
        expiresAtMs: Date.now() + 10 * 60_000,
        issuer: "https://auth.example.invalid",
        clientId: "client-id",
      },
    );

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
            content: [{ type: "text", text: "codex seeded" }],
            usage: { input: 1, output: 1, totalTokens: 2 },
            stopReason: "stop",
          },
          responseId: "resp_codex",
        };
      },
    });

    const result = await runtime.runTurn(
      makeParams(makeConfig(homeDir, {
        provider: "codex-cli",
        model: pickCodexModelId(),
        preferredChildModel: pickCodexModelId(),
      }), {
        messages: [{ role: "user", content: "latest" }],
        allMessages: [
          { role: "user", content: "older user" },
          { role: "assistant", content: "older assistant" },
          { role: "user", content: "latest" },
        ] as ModelMessage[],
        providerState: {
          provider: "codex-cli",
          model: pickCodexModelId(),
          responseId: "resp_previous",
          updatedAt: new Date().toISOString(),
          accountId: "acct_123",
        },
      }),
    );

    expect(nativeCalls).toHaveLength(1);
    expect(nativeCalls[0]?.previousResponseId).toBeUndefined();
    expect((nativeCalls[0]?.piMessages as Array<unknown>) ?? []).toHaveLength(3);
    expect(result.providerState).toBeUndefined();
  });

  test("codex chatgpt backend replays the assistant tool call locally before sending tool outputs", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-runtime-tool-loop-"));
    const modelId = pickCodexModelId();
    await writeCodexAuthMaterial(
      {
        rootDir: path.join(homeDir, ".cowork"),
        authDir: path.join(homeDir, ".cowork", "auth"),
      },
      {
        accessToken: "tok_live",
        refreshToken: "refresh_live",
        accountId: "acct_123",
        expiresAtMs: Date.now() + 10 * 60_000,
        issuer: "https://auth.example.invalid",
        clientId: "client-id",
      },
    );

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
              content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: { query: "needle" } }],
              usage: { input: 1, output: 1, totalTokens: 2 },
              stopReason: "toolUse",
            },
            responseId: "resp_codex_tool_1",
          };
        }

        return {
          assistant: {
            role: "assistant",
            content: [{ type: "text", text: "final answer" }],
            usage: { input: 1, output: 1, totalTokens: 2 },
            stopReason: "stop",
          },
          responseId: "resp_codex_tool_2",
        };
      },
    });

    const result = await runtime.runTurn(
      makeParams(makeConfig(homeDir, {
        provider: "codex-cli",
        model: modelId,
        preferredChildModel: modelId,
      }), {
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
    expect(nativeCalls[1]?.previousResponseId).toBeUndefined();

    const secondPiMessages = (nativeCalls[1]?.piMessages as Array<Record<string, unknown>>) ?? [];
    expect(secondPiMessages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
    expect((secondPiMessages[1]?.content as Array<Record<string, unknown>> | undefined)?.[0]).toEqual({
      type: "toolCall",
      id: "call_1",
      name: "lookup",
      arguments: { query: "needle" },
    });
    expect(secondPiMessages[2]?.toolCallId).toBe("call_1");
    expect(result.providerState).toBeUndefined();
  });

  test("injects a reminder message into the next responses step after malformed tool-call format errors", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openai-runtime-tool-format-reminder-"));
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
              content: [{ type: "toolCall", id: "call_bad", name: "tool", arguments: {} }],
              usage: { input: 1, output: 1, totalTokens: 2 },
              stopReason: "toolUse",
            },
            responseId: "resp_1",
          };
        }

        return {
          assistant: {
            role: "assistant",
            content: [{ type: "text", text: "fixed" }],
            usage: { input: 1, output: 1, totalTokens: 2 },
            stopReason: "stop",
          },
          responseId: "resp_2",
        };
      },
    });

    await runtime.runTurn(
      makeParams(makeConfig(homeDir, {
        provider: "openai",
        model: "gpt-5.4",
        preferredChildModel: "gpt-5.4",
      }), {
        maxSteps: 2,
        tools: {
          read: {
            inputSchema: z.object({ filePath: z.string() }),
            execute: async () => "unused",
          },
        },
      }),
    );

    expect(nativeCalls).toHaveLength(2);
    const secondPiMessages = (nativeCalls[1]?.piMessages as Array<Record<string, unknown>>) ?? [];
    expect(secondPiMessages.some((message) => message.role === "toolResult" && message.toolName === "tool")).toBe(true);
    expect(secondPiMessages.some((message) => {
      if (message.role !== "assistant") return false;
      return JSON.stringify(message.content).includes("Possible invalid tool call format detected");
    })).toBe(true);
  });

  test("request builder disables strict tools and unsupported continuation fields for codex chatgpt backend", () => {
    const request = openAiNativeInternal.buildOpenAiNativeRequest({
      provider: "codex-cli",
      model: {
        id: "gpt-5.4",
        name: "gpt-5.4",
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 32768,
      },
      systemPrompt: "You are helpful.",
      piMessages: [{ role: "user", content: "hello" }],
      tools: [{
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
      }],
      streamOptions: {
        maxTokens: 128,
        textVerbosity: "low",
      },
      previousResponseId: "resp_previous",
    });

    expect(request.store).toBe(false);
    expect("truncation" in request).toBe(false);
    expect("previous_response_id" in request).toBe(false);
    expect("max_output_tokens" in request).toBe(false);
    expect(request.text).toEqual({ verbosity: "medium" });
    expect(request.tool_choice).toBe("auto");
    expect(request.parallel_tool_calls).toBe(true);
    expect(request.include).toBeUndefined();
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

  test("request builder omits both native and legacy web search tools when the native backend is disabled", () => {
    const request = openAiNativeInternal.buildOpenAiNativeRequest({
      provider: "codex-cli",
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
      tools: [{
        name: "webSearch",
        description: "Search the web",
        parameters: { type: "object", properties: {}, required: [] },
      }],
      streamOptions: {
        webSearchMode: "disabled",
      },
    });

    expect(request.tools).toEqual([
      {
        type: "function",
        name: "webSearch",
        description: "Search the web",
        parameters: { type: "object", properties: {}, required: [] },
        strict: false,
      },
    ]);
    expect(request.include).toBeUndefined();
  });

  test("request builder keeps legacy webSearch when codex is explicitly configured for exa", () => {
    const request = openAiNativeInternal.buildOpenAiNativeRequest({
      provider: "codex-cli",
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
      tools: [{
        name: "webSearch",
        description: "Search the web",
        parameters: { type: "object", properties: {}, required: [] },
      }],
      streamOptions: {
        webSearchBackend: "exa",
        webSearchMode: "live",
      },
    });

    expect(request.tools).toEqual([{
      type: "function",
      name: "webSearch",
      description: "Search the web",
      parameters: { type: "object", properties: {}, required: [] },
      strict: false,
    }]);
    expect(request.include).toBeUndefined();
  });

  test("request builder sends cached native web search with normalized filters and merged include fields", () => {
    const request = openAiNativeInternal.buildOpenAiNativeRequest({
      provider: "codex-cli",
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
      tools: [{
        name: "webSearch",
        description: "Search the web",
        parameters: { type: "object", properties: {}, required: [] },
      }],
      streamOptions: {
        reasoningEffort: "high",
        webSearchMode: "cached",
        webSearchContextSize: "high",
        webSearchAllowedDomains: [
          " https://OpenAI.com/docs ",
          "openai.com",
          "https://example.com/foo/",
          "",
        ],
        webSearchLocation: {
          country: "US",
          city: "New York",
          timezone: "America/New_York",
        },
      },
    });

    expect(request.include).toEqual(["reasoning.encrypted_content"]);
    expect(request.tools).toEqual([
      {
        type: "function",
        name: "webSearch",
        description: "Search the web",
        parameters: { type: "object", properties: {}, required: [] },
        strict: false,
      },
    ]);
  });

  test("request builder strips legacy local webSearch when native web search is enabled", () => {
    const request = openAiNativeInternal.buildOpenAiNativeRequest({
      provider: "codex-cli",
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
          name: "webSearch",
          description: "Search the web",
          parameters: { type: "object", properties: {}, required: [] },
        },
        {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: {}, required: [] },
        },
      ],
      streamOptions: {
        webSearchBackend: "native",
        webSearchMode: "live",
      },
    });

    expect(request.tools).toEqual([
      {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: {}, required: [] },
        strict: false,
      },
      {
        type: "web_search",
        external_web_access: true,
      },
    ]);
    expect(request.include).toEqual(["web_search_call.action.sources"]);
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
      tools: [{
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
      }],
      streamOptions: {},
    });

    expect(request.tools).toEqual([{
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
    }]);
  });

  test("codex api-key path keeps the normal OpenAI base URL", () => {
    const baseUrl = openAiNativeInternal.resolveOpenAiClientBaseUrl({
      provider: "codex-cli",
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
      streamOptions: {},
    });

    expect(baseUrl).toBe("https://api.openai.com/v1");
  });

  test("codex chatgpt backend adds the official originator header", () => {
    const headers = openAiNativeInternal.resolveOpenAiClientHeaders({
      provider: "codex-cli",
      model: {
        id: "gpt-5.4",
        name: "gpt-5.4",
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 32768,
      },
      headers: {
        authorization: "Bearer token",
      },
      systemPrompt: "You are helpful.",
      piMessages: [{ role: "user", content: "hello" }],
      tools: [],
      streamOptions: {},
    });

    expect(headers).toMatchObject({
      authorization: "Bearer token",
      originator: "codex_cli_rs",
    });
  });

  test("codex api-key path preserves requested verbosity and continuation fields", () => {
    const request = openAiNativeInternal.buildOpenAiNativeRequest({
      provider: "codex-cli",
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
});
