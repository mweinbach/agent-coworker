import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createOpenAiResponsesRuntime } from "../src/runtime/openaiResponsesRuntime";
import { writeCodexAuthMaterial } from "../src/providers/codex-auth";
import { getModels as getPiModels } from "@mariozechner/pi-ai";
import { __internal as openAiNativeInternal } from "../src/runtime/openaiNativeResponses";
import type { RuntimeRunTurnParams } from "../src/runtime/types";
import type { AgentConfig, ModelMessage } from "../src/types";

function makeConfig(homeDir: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: "openai",
    model: "gpt-5.2",
    subAgentModel: "gpt-5.2",
    workingDirectory: homeDir,
    outputDirectory: path.join(homeDir, "output"),
    uploadsDirectory: path.join(homeDir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectAgentDir: path.join(homeDir, ".agent-project"),
    userAgentDir: path.join(homeDir, ".agent"),
    builtInDir: homeDir,
    builtInConfigDir: path.join(homeDir, "config"),
    skillsDirs: [],
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
  const models = (getPiModels("openai-codex" as any) as Array<{ id?: string }> | undefined) ?? [];
  return models[0]?.id ?? "gpt-5-codex";
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
        subAgentModel: pickCodexModelId(),
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
        subAgentModel: modelId,
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

  test("request builder disables strict tools and unsupported continuation fields for codex chatgpt backend", () => {
    const request = openAiNativeInternal.buildOpenAiNativeRequest({
      provider: "codex-cli",
      model: {
        id: "gpt-5-codex",
        name: "gpt-5-codex",
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
        id: "gpt-5-codex",
        name: "gpt-5-codex",
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
