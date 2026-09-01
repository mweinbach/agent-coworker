import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Interactions } from "@google/genai";
import { createGoogleInteractionsRuntime } from "../../../src/runtime/googleInteractionsRuntime";
import type { GoogleNativeStepRequest } from "../../../src/runtime/googleNative/types";
import {
  __internal as googleNativeInternal,
  runGoogleNativeInteractionStep,
} from "../../../src/runtime/googleNativeInteractions";
import type { PartialTurnError } from "../../../src/runtime/types";
import { __internal as citationMetadataInternal } from "../../../src/server/citationMetadata";
import type { ModelMessage } from "../../../src/types";
import {
  googleSseResponse,
  liveGoogleApiKey,
  liveGoogleTest,
  makeConfig,
  makeParams,
} from "./fixtures";

async function runGoogleEventFixture(
  events: Array<Record<string, unknown>>,
  overrides: Partial<GoogleNativeStepRequest> = {},
) {
  const realFetch = globalThis.fetch;
  googleNativeInternal.__testResetGoogleInteractionsClientCache();
  globalThis.fetch = (async () => googleSseResponse(events)) as typeof fetch;
  try {
    return await runGoogleNativeInteractionStep({
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
      messages: [{ role: "user", content: "Hello" }],
      tools: [],
      streamOptions: {},
      ...overrides,
    });
  } finally {
    globalThis.fetch = realFetch;
    googleNativeInternal.__testResetGoogleInteractionsClientCache();
  }
}

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
      const request = input instanceof Request ? input.clone() : new Request(input, init);
      seen.push({
        url: request.url,
        body: JSON.parse(await request.text()) as Record<string, unknown>,
      });
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

  test.each(["content", "step"] as const)(
    "rejects %s stream EOF without completion and retains partial text",
    async (prefix) => {
      const error = await runGoogleEventFixture([
        {
          event_type: "interaction.created",
          interaction: { id: "partial", status: "in_progress" },
        },
        { event_type: `${prefix}.start`, index: 0, [prefix]: { type: "text", text: "Partial" } },
        { event_type: `${prefix}.delta`, index: 0, delta: { type: "text", text: " answer" } },
        { event_type: `${prefix}.stop`, index: 0 },
      ]).then(
        () => undefined,
        (failure: PartialTurnError) => failure,
      );

      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain("before interaction completion");
      expect(error?.responseMessages).toEqual([
        { role: "assistant", content: [{ type: "text", text: "Partial answer" }] },
      ]);
      expect(error?.providerState).toBeUndefined();
    },
  );

  test.each([
    "failed",
    "cancelled",
    "incomplete",
    "budget_exceeded",
    "queued",
    "in_progress",
    "future_terminal",
    undefined,
  ])("rejects terminal status %s and retains usage without unexecuted calls", async (status) => {
    const error = await runGoogleEventFixture([
      { event_type: "step.start", index: 0, step: { type: "text", text: "Partial answer" } },
      { event_type: "step.stop", index: 0 },
      {
        event_type: "step.start",
        index: 1,
        step: {
          type: "function_call",
          id: "unexecuted",
          name: "bash",
          arguments: { command: "pwd" },
        },
      },
      { event_type: "step.stop", index: 1 },
      {
        event_type: "interaction.completed",
        interaction: {
          id: "failed-interaction",
          status,
          usage: { total_input_tokens: 7, total_output_tokens: 3, total_tokens: 10 },
        },
      },
    ]).then(
      () => undefined,
      (failure: PartialTurnError) => failure,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(status ?? "unknown");
    expect(error?.responseMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Partial answer" }] },
    ]);
    expect(error?.usage).toMatchObject({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });
    expect(error?.requestUsages).toEqual([error?.usage]);
    if (status === "cancelled") expect(error?.name).toBe("AbortError");
  });

  test("rejects a failed status update even without a completion event", async () => {
    await expect(
      runGoogleEventFixture([
        { event_type: "interaction.status_update", interaction_id: "failed", status: "failed" },
      ]),
    ).rejects.toThrow("failed");
  });

  test("accepts requires_action only after the tool block finishes", async () => {
    const events: Array<Record<string, unknown>> = [
      {
        event_type: "step.start",
        index: 0,
        step: { type: "function_call", id: "call", name: "read" },
      },
      {
        event_type: "step.delta",
        index: 0,
        delta: { type: "arguments_delta", arguments: '{"path":' },
      },
      {
        event_type: "step.delta",
        index: 0,
        delta: { type: "arguments_delta", arguments: '"report.md"}' },
      },
      { event_type: "step.stop", index: 0 },
      {
        event_type: "interaction.completed",
        interaction: { id: "pending-tool", status: "requires_action" },
      },
    ];

    const result = await runGoogleEventFixture(events);
    expect(result.assistant.stopReason).toBe("tool_calls");
    expect(result.assistant.content).toEqual([
      { type: "toolCall", id: "call", name: "read", arguments: { path: "report.md" } },
    ]);
    await expect(
      runGoogleEventFixture(events.filter((event) => event.event_type !== "step.stop")),
    ).rejects.toThrow("unfinished content");
  });

  test.each(['{"path":', "{invalid}", "[]", "null", "42", '{"path":"report.md"}garbage'])(
    "rejects malformed tool arguments %s before emitting a tool call",
    async (argumentsJson) => {
      const parts: Array<Record<string, unknown>> = [];
      await expect(
        runGoogleEventFixture(
          [
            {
              event_type: "step.start",
              index: 0,
              step: { type: "function_call", id: "invalid", name: "read" },
            },
            {
              event_type: "step.delta",
              index: 0,
              delta: { type: "arguments_delta", arguments: argumentsJson },
            },
            { event_type: "step.stop", index: 0 },
            {
              event_type: "interaction.completed",
              interaction: { id: "invalid", status: "requires_action" },
            },
          ],
          {
            onEvent: (part) => {
              parts.push(part);
            },
          },
        ),
      ).rejects.toThrow("JSON arguments");
      expect(parts.some((part) => part.type === "tool-call")).toBe(false);
    },
  );

  test("stream failures retain partial reasoning and media without an unfinished local call", async () => {
    const error = await runGoogleEventFixture([
      {
        event_type: "step.start",
        index: 0,
        step: {
          type: "thought",
          signature: "thought-sig",
          summary: [{ type: "text", text: "Partial reasoning" }],
        },
      },
      { event_type: "step.stop", index: 0 },
      {
        event_type: "step.start",
        index: 1,
        step: { type: "image", data: "aW1hZ2U=", mime_type: "image/png" },
      },
      { event_type: "step.stop", index: 1 },
      {
        event_type: "step.start",
        index: 2,
        step: { type: "function_call", id: "unfinished", name: "read" },
      },
      { event_type: "error", error: { message: "Provider stream failed" } },
    ]).then(
      () => undefined,
      (failure: PartialTurnError) => failure,
    );

    expect(error?.message).toBe("Provider stream failed");
    expect(error?.responseMessages).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Partial reasoning",
            thinkingSignature: "thought-sig",
            providerOptions: { google: { thoughtSignature: "thought-sig" } },
          },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
      },
    ]);
  });

  test("preserves abort errors while attaching partial text", async () => {
    const abortError = new DOMException("Request aborted", "AbortError");
    const error = await runGoogleEventFixture(
      [
        { event_type: "step.start", index: 0, step: { type: "text", text: "Partial answer" } },
        { event_type: "step.stop", index: 0 },
        {
          event_type: "interaction.completed",
          interaction: { id: "aborted", status: "completed" },
        },
      ],
      {
        onEvent: (part) => {
          if (part.type === "text-delta") throw abortError;
        },
      },
    ).then(
      () => undefined,
      (failure: PartialTurnError) => failure,
    );

    expect(error).toBe(abortError);
    expect(error?.responseMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Partial answer" }] },
    ]);
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
