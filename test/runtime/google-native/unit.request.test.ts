import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Interactions } from "@google/genai";
import { createGoogleInteractionsRuntime } from "../../../src/runtime/googleInteractionsRuntime";
import {
  __internal as googleNativeInternal,
  runGoogleNativeInteractionStep,
} from "../../../src/runtime/googleNativeInteractions";
import type { RuntimeRunTurnParams } from "../../../src/runtime/types";
import { __internal as citationMetadataInternal } from "../../../src/server/citationMetadata";
import type { ModelMessage } from "../../../src/types";
import {
  googleSseResponse,
  liveGoogleApiKey,
  liveGoogleTest,
  makeConfig,
  makeParams,
} from "./fixtures";

describe("google native interactions request building", () => {
  test("SDK Interactions contract stays aligned with request and stream shapes", () => {
    const userStep = {
      type: "user_input",
      content: [{ type: "text", text: "Hello" }],
    } satisfies Interactions.UserInputStep;
    const modelStep = {
      type: "model_output",
      content: [{ type: "text", text: "Hi" }],
    } satisfies Interactions.ModelOutputStep;
    const request = {
      model: "gemini-3-flash-preview",
      input: [userStep, modelStep],
      stream: true,
      generation_config: { thinking_summaries: "auto" },
      response_mime_type: "application/json",
      response_format: { type: "json_schema" },
    } satisfies Interactions.CreateModelInteractionParamsStreaming;
    const event = {
      event_type: "step.start",
      index: 0,
      step: modelStep,
    } satisfies Interactions.InteractionSSEEvent;

    expect(request.input).toHaveLength(2);
    expect(event.event_type).toBe("step.start");
  });

  test("runGoogleNativeInteractionStep posts the expected Interactions body through the SDK", async () => {
    const realFetch = globalThis.fetch;
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    googleNativeInternal.__testResetGoogleInteractionsClientCache();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const bodyText =
        typeof init?.body === "string" ? init.body : await new Response(init?.body).text();
      seen.push({ url: String(input), body: JSON.parse(bodyText) as Record<string, unknown> });
      return googleSseResponse([
        {
          event_type: "interaction.created",
          interaction: { id: "mock-interaction", status: "in_progress" },
        },
        {
          event_type: "step.start",
          index: 0,
          step: { type: "model_output", content: [{ type: "text", text: "Hello" }] },
        },
        { event_type: "step.delta", index: 0, delta: { type: "text", text: " world" } },
        { event_type: "step.stop", index: 0 },
        {
          event_type: "interaction.completed",
          interaction: {
            id: "mock-interaction",
            status: "completed",
            usage: {
              total_input_tokens: 7,
              total_output_tokens: 5,
              total_cached_tokens: 3,
              total_cache_write_tokens: 2,
              total_thought_tokens: 4,
              total_tokens: 17,
            },
          },
        },
      ]);
    }) as typeof fetch;

    try {
      const result = await runGoogleNativeInteractionStep({
        model: {
          id: "gemini-3-flash-preview",
          name: "Gemini 3 Flash Preview",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 1_048_576,
          maxTokens: 65_536,
        },
        apiKey: "test-google-api-key",
        systemPrompt: "You are helpful.",
        messages: [{ role: "user", content: "Hello" }] as ModelMessage[],
        tools: [{ name: "bash", description: "Run bash", parameters: { type: "object" } }],
        streamOptions: {
          thinkingSummaries: "auto",
          responseMimeType: "application/json",
          responseFormat: { type: "json_schema" },
        },
      });

      expect(seen).toHaveLength(1);
      expect(seen[0]?.url).toContain("/v1beta/interactions");
      expect(seen[0]?.body).toMatchObject({
        model: "gemini-3-flash-preview",
        stream: true,
        store: true,
        system_instruction: "You are helpful.",
        response_mime_type: "application/json",
        response_format: { type: "json_schema" },
        generation_config: { thinking_summaries: "auto" },
      });
      expect(seen[0]?.body.input).toEqual([
        { type: "user_input", content: [{ type: "text", text: "Hello" }] },
      ]);
      expect(result.interactionId).toBe("mock-interaction");
      expect(result.assistant.content).toEqual([{ type: "text", text: "Hello world" }]);
      expect(result.assistant.usage).toEqual({
        input: 7,
        output: 5,
        cacheRead: 3,
        cacheWrite: 2,
        reasoningOutputTokens: 4,
        totalTokens: 17,
      });
    } finally {
      globalThis.fetch = realFetch;
      googleNativeInternal.__testResetGoogleInteractionsClientCache();
    }
  });

  test("runGoogleNativeInteractionStep preserves top-level interaction_id from status updates", async () => {
    const realFetch = globalThis.fetch;
    googleNativeInternal.__testResetGoogleInteractionsClientCache();
    globalThis.fetch = (async () =>
      googleSseResponse([
        {
          event_type: "interaction.status_update",
          interaction_id: "status-interaction",
          status: "running",
        },
        {
          event_type: "step.start",
          index: 0,
          step: { type: "model_output", content: [{ type: "text", text: "Status" }] },
        },
        { event_type: "step.delta", index: 0, delta: { type: "text", text: " id" } },
        { event_type: "step.stop", index: 0 },
        {
          event_type: "interaction.completed",
          interaction: { status: "completed" },
        },
      ])) as typeof fetch;

    try {
      const result = await runGoogleNativeInteractionStep({
        model: {
          id: "gemini-3-flash-preview",
          name: "Gemini 3 Flash Preview",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 1_048_576,
          maxTokens: 65_536,
        },
        apiKey: "test-google-api-key",
        systemPrompt: "You are helpful.",
        messages: [{ role: "user", content: "Hello" }] as ModelMessage[],
        tools: [],
        streamOptions: { thinkingSummaries: "auto" },
      });

      expect(result.interactionId).toBe("status-interaction");
      expect(result.assistant.content).toEqual([{ type: "text", text: "Status id" }]);
    } finally {
      globalThis.fetch = realFetch;
      googleNativeInternal.__testResetGoogleInteractionsClientCache();
    }
  });

  liveGoogleTest(
    "live Google Interactions smoke streams text when explicitly enabled",
    async () => {
      const result = await runGoogleNativeInteractionStep({
        model: {
          id: "gemini-3-flash-preview",
          name: "Gemini 3 Flash Preview",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 1_048_576,
          maxTokens: 65_536,
        },
        apiKey: liveGoogleApiKey,
        systemPrompt: "Reply with exactly: pong",
        messages: [{ role: "user", content: "ping" }] as ModelMessage[],
        tools: [],
        streamOptions: { thinkingSummaries: "none" },
      });

      expect(result.interactionId).toBeTruthy();
      expect(Array.isArray(result.assistant.content)).toBe(true);
    },
  );

  test("buildGoogleNativeRequest produces correct structure", () => {
    const request = googleNativeInternal.buildGoogleNativeRequest({
      model: {
        id: "gemini-3-flash-preview",
        name: "Gemini 3 Flash Preview",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_048_576,
        maxTokens: 65_536,
      },
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "Hello" }] as ModelMessage[],
      tools: [{ name: "bash", description: "Run bash commands", parameters: { type: "object" } }],
      streamOptions: {
        thinkingLevel: "high",
        temperature: 0.7,
      },
    });

    expect(request.model).toBe("gemini-3-flash-preview");
    expect(request.system_instruction).toBe("You are helpful.");
    expect(request.stream).toBe(true);
    expect(request.store).toBe(true);
    expect(Array.isArray(request.input)).toBe(true);
    expect(Array.isArray(request.tools)).toBe(true);
    expect((request.input as Array<Record<string, unknown>>)[0]).toEqual({
      type: "user_input",
      content: [{ type: "text", text: "Hello" }],
    });

    const genConfig = request.generation_config as Record<string, unknown>;
    expect(genConfig.thinking_level).toBe("high");
    expect(genConfig.temperature).toBe(0.7);
  });

  test("buildGoogleNativeRequest adds Google Search and URL Context when native web search is enabled", () => {
    const request = googleNativeInternal.buildGoogleNativeRequest({
      model: {
        id: "gemini-3-flash-preview",
        name: "Gemini 3 Flash Preview",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_048_576,
        maxTokens: 65_536,
      },
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "Find coffee shops near me" }] as ModelMessage[],
      tools: [
        { name: "bash", description: "Run bash commands", parameters: { type: "object" } },
        { name: "webFetch", description: "Fetch a web page", parameters: { type: "object" } },
      ],
      streamOptions: {
        nativeWebSearch: true,
      },
    });

    expect(request.tools).toEqual([
      {
        type: "function",
        name: "bash",
        description: "Run bash commands",
        parameters: { type: "object" },
      },
      {
        type: "function",
        name: "webFetch",
        description: "Fetch a web page",
        parameters: { type: "object" },
      },
      { type: "google_search", search_types: ["web_search"] },
      { type: "url_context" },
    ]);
  });

  test("buildGoogleNativeRequest omits provider-native Google tools when no web-capable tool survives filtering", () => {
    const request = googleNativeInternal.buildGoogleNativeRequest({
      model: {
        id: "gemini-3-flash-preview",
        name: "Gemini 3 Flash Preview",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_048_576,
        maxTokens: 65_536,
      },
      systemPrompt: "You are helpful.",
      messages: [
        { role: "user", content: "Find coffee shops near me and read their websites" },
      ] as ModelMessage[],
      tools: [{ name: "bash", description: "Run bash commands", parameters: { type: "object" } }],
      streamOptions: {
        nativeWebSearch: true,
      },
    });

    expect(request.tools).toEqual([
      {
        type: "function",
        name: "bash",
        description: "Run bash commands",
        parameters: { type: "object" },
      },
    ]);
  });

  test("unsupported Gemini thinking levels are omitted for the selected model", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "google-interactions-thinking-"));
    const seenStreamOptions: Array<Record<string, unknown>> = [];
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async (opts) => {
        seenStreamOptions.push({ ...opts.streamOptions });
        return {
          assistant: {
            role: "assistant",
            api: "google-interactions",
            provider: "google",
            model: "gemini-3.1-pro-preview",
            content: [{ type: "text", text: "ok" }],
            usage: { input: 1, output: 1, totalTokens: 2 },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          interactionId: "omit-unsupported-thinking",
        };
      },
    });

    await runtime.runTurn(
      makeParams(
        makeConfig(homeDir, {
          model: "gemini-3.1-pro-preview",
          preferredChildModel: "gemini-3.1-pro-preview",
          providerOptions: {
            google: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingLevel: "minimal",
              },
            },
          },
        }),
      ),
    );

    expect(seenStreamOptions).toHaveLength(1);
    expect(seenStreamOptions[0]?.thinkingLevel).toBeUndefined();
    expect(seenStreamOptions[0]?.thinkingSummaries).toBe("auto");
  });
});
