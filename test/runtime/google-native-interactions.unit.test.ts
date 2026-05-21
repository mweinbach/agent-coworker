import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Interactions } from "@google/genai";
import { createGoogleInteractionsRuntime } from "../../src/runtime/googleInteractionsRuntime";
import {
  __internal as googleNativeInternal,
  runGoogleNativeInteractionStep,
} from "../../src/runtime/googleNativeInteractions";
import { __internal as citationMetadataInternal } from "../../src/server/citationMetadata";
import type { RuntimeRunTurnParams } from "../../src/runtime/types";
import {
  googleSseResponse,
  liveGoogleTest,
  makeConfig,
  makeParams,
} from "./google-native/fixtures";

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

  test("convertMessagesToInteractionsInput preserves roleful conversation turns", () => {
    const input = googleNativeInternal.convertMessagesToInteractionsInput([
      { role: "user", content: "Hello world" },
      { role: "assistant", content: [{ type: "text", text: "Hi there." }] },
      { role: "user", content: "What is my name?" },
    ] as ModelMessage[]);

    expect(input).toEqual([
      { type: "user_input", content: [{ type: "text", text: "Hello world" }] },
      { type: "model_output", content: [{ type: "text", text: "Hi there." }] },
      { type: "user_input", content: [{ type: "text", text: "What is my name?" }] },
    ]);
  });

  test("convertMessagesToInteractionsInput preserves assistant string turns", () => {
    const input = googleNativeInternal.convertMessagesToInteractionsInput([
      { role: "user", content: "Hello world" },
      { role: "assistant", content: "Hi there." },
      { role: "user", content: "What did you just say?" },
    ] as ModelMessage[]);

    expect(input).toEqual([
      { type: "user_input", content: [{ type: "text", text: "Hello world" }] },
      { type: "model_output", content: [{ type: "text", text: "Hi there." }] },
      { type: "user_input", content: [{ type: "text", text: "What did you just say?" }] },
    ]);
  });

  test("convertMessagesToInteractionsInput preserves assistant output_text parts", () => {
    const input = googleNativeInternal.convertMessagesToInteractionsInput([
      {
        role: "assistant",
        content: [{ type: "output_text", text: "Saved response." }],
      },
    ] as ModelMessage[]);

    expect(input).toEqual([
      {
        type: "model_output",
        content: [{ type: "text", text: "Saved response." }],
      },
    ]);
  });

  test("convertMessagesToInteractionsInput preserves multimodal user input", () => {
    const input = googleNativeInternal.convertMessagesToInteractionsInput([
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image" },
          { type: "image", data: "abc123", mimeType: "image/png" },
          { type: "audio", data: "def456", mimeType: "audio/mp3" },
          { type: "document", data: "ghi789", mimeType: "application/pdf" },
          { type: "video", data: "jkl012", mimeType: "video/mp4" },
        ],
      },
    ] as ModelMessage[]);

    expect(input).toEqual([
      {
        type: "user_input",
        content: [
          { type: "text", text: "Describe this image" },
          { type: "image", data: "abc123", mime_type: "image/png" },
          { type: "audio", data: "def456", mime_type: "audio/mp3" },
          { type: "document", data: "ghi789", mime_type: "application/pdf" },
          { type: "video", data: "jkl012", mime_type: "video/mp4" },
        ],
      },
    ]);
  });

  test("convertMessagesToInteractionsInput omits unsupported binary tool result bytes", () => {
    const input = googleNativeInternal.convertMessagesToInteractionsInput([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_read_audio",
            toolName: "read",
            output: {
              type: "content",
              content: [
                { type: "text", text: "Audio file: clip.mp3" },
                { type: "audio", data: "def456", mimeType: "audio/mpeg" },
                { type: "video", data: "ghi789", mimeType: "video/mp4" },
                { type: "document", data: "jkl012", mimeType: "application/pdf" },
              ],
            },
          },
        ],
      },
    ] as ModelMessage[]);

    expect(input).toEqual([
      {
        type: "function_result",
        call_id: "call_read_audio",
        name: "read",
        result: [
          { type: "text", text: "Audio file: clip.mp3" },
          {
            type: "text",
            text: "[audio (audio/mpeg) tool result omitted: Gemini Interactions function_result supports text and image content only.]",
          },
          {
            type: "text",
            text: "[video (video/mp4) tool result omitted: Gemini Interactions function_result supports text and image content only.]",
          },
          {
            type: "text",
            text: "[document (application/pdf) tool result omitted: Gemini Interactions function_result supports text and image content only.]",
          },
        ],
        is_error: false,
      },
    ]);
  });

  test("convertMessagesToInteractionsInput preserves URI media blocks accepted by the SDK", () => {
    const input = googleNativeInternal.convertMessagesToInteractionsInput([
      {
        role: "user",
        content: [
          { type: "image", uri: "gs://bucket/image.png", mimeType: "image/png" },
          { type: "document", uri: "gs://bucket/file.pdf" },
        ],
      },
    ] as ModelMessage[]);

    expect(input).toEqual([
      {
        type: "user_input",
        content: [
          { type: "image", uri: "gs://bucket/image.png", mime_type: "image/png" },
          { type: "document", uri: "gs://bucket/file.pdf" },
        ],
      },
    ]);
  });

  test("convertMessagesToInteractionsInput handles assistant tool calls with repaired thought signatures", () => {
    const input = googleNativeInternal.convertMessagesToInteractionsInput([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_123|fc_456",
            toolName: "bash",
            input: { command: "ls" },
            providerOptions: { google: { thoughtSignature: "sig_123" } },
          },
        ],
      },
    ] as ModelMessage[]);

    expect(input.length).toBe(1);
    expect(input[0]).toEqual({
      type: "function_call",
      id: "call_123",
      name: "bash",
      arguments: { command: "ls" },
      signature: "sig_123",
    });
  });

  test("convertMessagesToInteractionsInput round-trips native Google tool history", () => {
    const input = googleNativeInternal.convertMessagesToInteractionsInput([
      {
        role: "assistant",
        content: [
          {
            type: "providerToolCall",
            id: "gs_1",
            name: "nativeWebSearch",
            arguments: { queries: ["latest Gemini announcements"] },
            providerOptions: { google: { thoughtSignature: "sig_call" } },
          },
          {
            type: "providerToolResult",
            callId: "gs_1",
            name: "nativeWebSearch",
            result: [{ search_suggestions: "Latest Gemini announcements" }],
            providerOptions: { google: { thoughtSignature: "sig_result" } },
          },
          {
            type: "providerToolCall",
            id: "uc_1",
            name: "nativeUrlContext",
            arguments: { urls: ["https://example.com"] },
          },
          {
            type: "providerToolResult",
            callId: "uc_1",
            name: "nativeUrlContext",
            result: { url: "https://example.com", status: "ok" },
          },
        ],
      },
    ] as ModelMessage[]);

    expect(input).toEqual([
      {
        type: "google_search_call",
        id: "gs_1",
        arguments: { queries: ["latest Gemini announcements"] },
        signature: "sig_call",
      },
      {
        type: "google_search_result",
        call_id: "gs_1",
        result: [{ search_suggestions: "Latest Gemini announcements" }],
        signature: "sig_result",
      },
      {
        type: "url_context_call",
        id: "uc_1",
        arguments: { urls: ["https://example.com"] },
      },
      {
        type: "url_context_result",
        call_id: "uc_1",
        result: { url: "https://example.com", status: "ok" },
      },
    ]);
  });

  test("convertMessagesToInteractionsInput drops native code execution history", () => {
    const result = { outcome: "OUTCOME_OK", output: "sum=5117\n" };
    const input = googleNativeInternal.convertMessagesToInteractionsInput([
      {
        role: "assistant",
        content: [
          {
            type: "providerToolCall",
            id: "ce_1",
            name: "codeExecution",
            arguments: { code: "print('sum=5117')", language: "python" },
            providerOptions: { google: { thoughtSignature: "sig_code_call" } },
          },
          {
            type: "providerToolResult",
            callId: "ce_1",
            name: "codeExecution",
            result,
            providerOptions: { google: { thoughtSignature: "sig_code_result" } },
          },
        ],
      },
    ] as ModelMessage[]);

    expect(input).toEqual([]);
  });

  test("convertMessagesToInteractionsInput handles rich tool results", () => {
    const input = googleNativeInternal.convertMessagesToInteractionsInput([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_123|fc_456",
            toolName: "read",
            output: {
              type: "content",
              content: [
                { type: "text", text: "image attached" },
                { type: "image", data: "abc123", mimeType: "image/png" },
              ],
            },
            isError: false,
          },
        ],
      },
    ] as ModelMessage[]);

    expect(input).toEqual([
      {
        type: "function_result",
        call_id: "call_123",
        name: "read",
        result: [
          { type: "text", text: "image attached" },
          { type: "image", data: "abc123", mime_type: "image/png" },
        ],
        is_error: false,
      },
    ]);
  });

  test("googleTurnMessagesToModelMessages converts native SDK output block names", () => {
    const messages = googleNativeInternal.googleTurnMessagesToModelMessages([
      {
        role: "assistant",
        content: [
          {
            type: "thought",
            signature: "sig_thought",
            summary: [{ type: "text", text: "Reasoning summary." }],
          },
          {
            type: "function_call",
            id: "call_1",
            name: "bash",
            arguments: { command: "pwd" },
            signature: "sig_call",
          },
          {
            type: "google_search_call",
            id: "gs_1",
            arguments: { queries: ["Gemini"] },
          },
          {
            type: "google_search_result",
            call_id: "gs_1",
            result: [{ search_suggestions: "Gemini" }],
          },
        ],
      },
    ]);

    expect(messages).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Reasoning summary.",
            thinkingSignature: "sig_thought",
            providerOptions: { google: { thoughtSignature: "sig_thought" } },
          },
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "bash",
            input: { command: "pwd" },
            thoughtSignature: "sig_call",
            providerOptions: { google: { thoughtSignature: "sig_call" } },
          },
          {
            type: "providerToolCall",
            id: "gs_1",
            name: "nativeWebSearch",
            arguments: { queries: ["Gemini"] },
          },
          {
            type: "providerToolResult",
            callId: "gs_1",
            name: "nativeWebSearch",
            result: [{ search_suggestions: "Gemini" }],
          },
        ],
      },
    ]);
  });

  test("convertToolsToInteractionsTools maps to function type", () => {
    const tools = googleNativeInternal.convertToolsToInteractionsTools([
      {
        name: "readFile",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);

    expect(tools.length).toBe(1);
    expect(tools[0].type).toBe("function");
    expect(tools[0].name).toBe("readFile");
    expect(tools[0].description).toBe("Read a file");
  });

  test("processStreamEvent handles SDK v2 step events and arguments deltas", () => {
    const blocks = new Map();

    googleNativeInternal.processStreamEvent(
      {
        event_type: "step.start",
        index: 0,
        step: { type: "function_call", id: "call_v2", name: "bash", arguments: {} },
      },
      blocks,
    );
    googleNativeInternal.processStreamEvent(
      {
        event_type: "step.delta",
        index: 0,
        delta: { type: "arguments_delta", arguments: '{"command":"pwd"}' },
      },
      blocks,
    );

    expect(blocks.get(0)).toEqual({
      type: "toolCall",
      id: "call_v2",
      name: "bash",
      arguments: { command: "pwd" },
    });
    expect(
      googleNativeInternal.mapGoogleEventToStreamParts(
        { event_type: "step.stop", index: 0 },
        blocks,
      ),
    ).toEqual([
      { type: "tool-input-end", id: "call_v2" },
      { type: "tool-call", toolCallId: "call_v2", toolName: "bash", input: { command: "pwd" } },
    ]);
  });

  test("processStreamEvent preserves SDK text_annotation deltas", () => {
    const blocks = new Map();

    googleNativeInternal.processStreamEvent(
      { event_type: "content.start", index: 0, content: { type: "text" } },
      blocks,
    );
    googleNativeInternal.processStreamEvent(
      { event_type: "content.delta", index: 0, delta: { type: "text", text: "Answer" } },
      blocks,
    );
    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.delta",
        index: 0,
        delta: {
          type: "text_annotation",
          annotations: [{ type: "url_citation", url: "https://example.com" }],
        },
      },
      blocks,
    );

    expect(blocks.get(0)).toEqual({
      type: "text",
      text: "Answer",
      annotations: [{ type: "url_citation", url: "https://example.com" }],
    });
  });

  test("processStreamEvent accumulates text content", () => {
    const blocks = new Map();

    googleNativeInternal.processStreamEvent(
      { event_type: "content.start", index: 0, content: { type: "text", text: "" } },
      blocks,
    );
    googleNativeInternal.processStreamEvent(
      { event_type: "content.delta", index: 0, delta: { type: "text", text: "Hello" } },
      blocks,
    );
    googleNativeInternal.processStreamEvent(
      { event_type: "content.delta", index: 0, delta: { type: "text", text: " world" } },
      blocks,
    );

    const block = blocks.get(0);
    expect(block).toBeDefined();
    expect(block.type).toBe("text");
    expect(block.text).toBe("Hello world");
  });

  test("processStreamEvent handles current SDK model_output and media steps", () => {
    const blocks = new Map();

    googleNativeInternal.processStreamEvent(
      {
        event_type: "step.start",
        index: 0,
        step: { type: "model_output", content: [{ type: "text", text: "Hello" }] },
      },
      blocks,
    );
    googleNativeInternal.processStreamEvent(
      { event_type: "step.delta", index: 0, delta: { type: "text", text: " world" } },
      blocks,
    );
    googleNativeInternal.processStreamEvent(
      {
        event_type: "step.start",
        index: 1,
        step: { type: "image", uri: "gs://bucket/image.png", mime_type: "image/png" },
      },
      blocks,
    );

    expect(blocks.get(0)).toEqual({ type: "text", text: "Hello world" });
    expect(blocks.get(1)).toEqual({
      type: "image",
      uri: "gs://bucket/image.png",
      mime_type: "image/png",
    });
    expect(
      googleNativeInternal.mapGoogleEventToStreamParts(
        { event_type: "step.stop", index: 1 },
        blocks,
      ),
    ).toEqual([
      { type: "file", mediaType: "image", uri: "gs://bucket/image.png", mime_type: "image/png" },
    ]);
  });

  test("processStreamEvent normalizes additional provider-executed Google tools", () => {
    const blocks = new Map();
    const providerToolCallsById = new Map();

    googleNativeInternal.processStreamEvent(
      {
        event_type: "step.start",
        index: 0,
        step: {
          type: "mcp_server_tool_call",
          id: "mcp_1",
          name: "lookup",
          server_name: "docs",
          arguments: { query: "Gemini" },
        },
      },
      blocks,
      providerToolCallsById,
    );
    googleNativeInternal.processStreamEvent(
      {
        event_type: "step.start",
        index: 1,
        step: {
          type: "mcp_server_tool_result",
          call_id: "mcp_1",
          result: { ok: true },
        },
      },
      blocks,
      providerToolCallsById,
    );

    expect(blocks.get(0)).toMatchObject({
      type: "providerToolCall",
      id: "mcp_1",
      name: "nativeMcpServerTool",
      arguments: { query: "Gemini", name: "lookup", server_name: "docs" },
    });
    expect(
      googleNativeInternal.mapGoogleEventToStreamParts(
        { event_type: "step.stop", index: 1 },
        blocks,
        providerToolCallsById,
      ),
    ).toEqual([
      {
        type: "tool-result",
        toolCallId: "mcp_1",
        toolName: "nativeMcpServerTool",
        output: {
          provider: "google",
          status: "completed",
          callId: "mcp_1",
          serverName: "docs",
          name: "lookup",
          result: { ok: true },
          raw: { ok: true },
        },
        providerExecuted: true,
      },
    ]);
  });

  test("Google interaction error classification distinguishes retryable and schema failures", () => {
    expect(googleNativeInternal.classifyGoogleInteractionError(new Error("503 unavailable"))).toBe(
      "retryable",
    );
    expect(googleNativeInternal.isRetryableGoogleInteractionError(new Error("429 quota"))).toBe(
      true,
    );
    expect(googleNativeInternal.classifyGoogleInteractionError(new Error("400 schema error"))).toBe(
      "schema",
    );
    const sizeLimitError = new Error(
      "The generated response exceeds the maximum allowed size limit (temporary limitation).",
    );
    expect(googleNativeInternal.classifyGoogleInteractionError(sizeLimitError)).toBe("output_size");
    expect(googleNativeInternal.isRetryableGoogleInteractionError(sizeLimitError)).toBe(false);
    expect(
      googleNativeInternal.classifyGoogleInteractionError(
        new Error("Gemini generated response exceeded the provider size limit."),
      ),
    ).toBe("output_size");
  });

  test("enrichTextBlockAnnotations resolves Google grounding redirects for final text blocks", async () => {
    const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    let fetchCalls = 0;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL) => {
        fetchCalls += 1;
        const url =
          input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
        if (url.includes("/grounding-api-redirect/example")) {
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://www.foxnews.com/live-news/new-york-laguardia-plane-crash-march-23",
            },
          });
        }

        const response = new Response(
          `<html><head><title>LaGuardia collision: 2 pilots killed after Air Canada jet hits fire truck, forcing airport closure</title></head></html>`,
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
            },
          },
        );
        Object.defineProperty(response, "url", {
          configurable: true,
          value: "https://www.foxnews.com/live-news/new-york-laguardia-plane-crash-march-23",
        });
        return response;
      },
    });

    try {
      const block = {
        type: "text" as const,
        text: "Answer",
        annotations: [
          {
            type: "url_citation",
            url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/example",
            title: "foxnews.com",
            start_index: 0,
            end_index: 6,
          },
        ],
      };

      await googleNativeInternal.enrichTextBlockAnnotations(block);
      expect(fetchCalls).toBe(2);

      expect(block.annotations).toEqual([
        {
          type: "url_citation",
          url: "https://www.foxnews.com/live-news/new-york-laguardia-plane-crash-march-23",
          title:
            "LaGuardia collision: 2 pilots killed after Air Canada jet hits fire truck, forcing airport closure",
          start_index: 0,
          end_index: 6,
        },
      ]);
    } finally {
      citationMetadataInternal.clearCitationResolutionCache();
      if (originalFetchDescriptor) {
        Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
      }
    }
  });

  test("queueTextBlockAnnotationEnrichment keeps slow citation fetches off the text-end hot path", async () => {
    const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    const fetchStarted = Promise.withResolvers<void>();
    const responseGate = Promise.withResolvers<Response>();
    let fetchCalls = 0;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL) => {
        fetchCalls += 1;
        const url =
          input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
        if (url.includes("/grounding-api-redirect/slow-example")) {
          fetchStarted.resolve();
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://www.foxnews.com/live-news/new-york-laguardia-plane-crash-march-23",
            },
          });
        }

        return await responseGate.promise;
      },
    });

    try {
      const block = {
        type: "text" as const,
        text: "Answer",
        annotations: [
          {
            type: "url_citation",
            url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/slow-example",
            title: "foxnews.com",
            start_index: 0,
            end_index: 6,
          },
        ],
      };
      const blocks = new Map([[0, block]]);
      const providerToolCallsById = new Map();
      const pendingAnnotationEnrichments: Array<Promise<void>> = [];

      googleNativeInternal.queueTextBlockAnnotationEnrichment(pendingAnnotationEnrichments, block);
      await fetchStarted.promise;
      expect(fetchCalls).toBe(1);

      expect(
        googleNativeInternal.mapGoogleEventToStreamParts(
          { event_type: "content.stop", index: 0 },
          blocks,
          providerToolCallsById,
        ),
      ).toEqual([
        {
          type: "text-end",
          id: "s0",
          annotations: [
            {
              type: "url_citation",
              url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/slow-example",
              title: "foxnews.com",
              start_index: 0,
              end_index: 6,
            },
          ],
        },
      ]);

      const response = new Response(
        `<html><head><title>LaGuardia collision: 2 pilots killed after Air Canada jet hits fire truck, forcing airport closure</title></head></html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        },
      );
      Object.defineProperty(response, "url", {
        configurable: true,
        value: "https://www.foxnews.com/live-news/new-york-laguardia-plane-crash-march-23",
      });
      responseGate.resolve(response);

      await Promise.all(pendingAnnotationEnrichments);
      expect(fetchCalls).toBe(2);

      expect(block.annotations).toEqual([
        {
          type: "url_citation",
          url: "https://www.foxnews.com/live-news/new-york-laguardia-plane-crash-march-23",
          title:
            "LaGuardia collision: 2 pilots killed after Air Canada jet hits fire truck, forcing airport closure",
          start_index: 0,
          end_index: 6,
        },
      ]);
    } finally {
      citationMetadataInternal.clearCitationResolutionCache();
      if (originalFetchDescriptor) {
        Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
      }
    }
  });

  test("processStreamEvent handles function_call content", () => {
    const blocks = new Map();

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 0,
        content: {
          type: "function_call",
          id: "call_abc",
          name: "readFile",
          arguments: { path: "/tmp/test.txt" },
        },
      },
      blocks,
    );

    const block = blocks.get(0);
    expect(block).toBeDefined();
    expect(block.type).toBe("toolCall");
    expect(block.id).toBe("call_abc");
    expect(block.name).toBe("readFile");
    expect(block.arguments).toEqual({ path: "/tmp/test.txt" });
  });

  test("processStreamEvent updates function_call name from later delta", () => {
    const blocks = new Map();

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 0,
        content: {
          type: "function_call",
          id: "call_abc",
        },
      },
      blocks,
    );
    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.delta",
        index: 0,
        delta: {
          type: "function_call",
          name: "webSearch",
          arguments: { query: "NVIDIA GTC 2026 dates announcements keynote" },
          signature: "sig_call",
        },
      },
      blocks,
    );

    const block = blocks.get(0);
    expect(block).toBeDefined();
    expect(block.type).toBe("toolCall");
    expect(block.id).toBe("call_abc");
    expect(block.name).toBe("webSearch");
    expect(block.arguments).toEqual({ query: "NVIDIA GTC 2026 dates announcements keynote" });
    expect(block.thoughtSignature).toBe("sig_call");
  });

  test("processStreamEvent keeps the first emitted function_call id stable", () => {
    const blocks = new Map();

    const startEvent = {
      event_type: "content.start",
      index: 0,
      content: {
        type: "function_call",
        name: "bash",
      },
    };
    googleNativeInternal.processStreamEvent(startEvent, blocks);

    const startBlock = blocks.get(0);
    expect(startBlock).toBeDefined();
    expect(startBlock.type).toBe("toolCall");
    const fallbackId = startBlock.id;

    expect(googleNativeInternal.mapGoogleEventToStreamParts(startEvent, blocks)).toEqual([
      { type: "tool-input-start", id: fallbackId, toolName: "bash" },
    ]);

    const deltaEvent = {
      event_type: "content.delta",
      index: 0,
      delta: {
        type: "function_call",
        id: "call_real",
        arguments: { command: "ls" },
      },
    };
    googleNativeInternal.processStreamEvent(deltaEvent, blocks);

    const block = blocks.get(0);
    expect(block).toBeDefined();
    expect(block.type).toBe("toolCall");
    expect(block.id).toBe(fallbackId);
    expect(block.arguments).toEqual({ command: "ls" });

    expect(googleNativeInternal.mapGoogleEventToStreamParts(deltaEvent, blocks)).toEqual([
      { type: "tool-input-delta", id: fallbackId, delta: '{"command":"ls"}' },
    ]);

    expect(
      googleNativeInternal.mapGoogleEventToStreamParts(
        { event_type: "content.stop", index: 0 },
        blocks,
      ),
    ).toEqual([
      { type: "tool-input-end", id: fallbackId },
      { type: "tool-call", toolCallId: fallbackId, toolName: "bash", input: { command: "ls" } },
    ]);
  });

  test("processStreamEvent keeps the first emitted native provider tool id stable", () => {
    const blocks = new Map();
    const providerToolCallsById = new Map();

    const startEvent = {
      event_type: "content.start",
      index: 0,
      content: {
        type: "google_search_call",
      },
    };
    googleNativeInternal.processStreamEvent(startEvent, blocks, providerToolCallsById);

    const startBlock = blocks.get(0);
    expect(startBlock).toBeDefined();
    expect(startBlock.type).toBe("providerToolCall");
    const fallbackId = startBlock.id;

    expect(
      googleNativeInternal.mapGoogleEventToStreamParts(startEvent, blocks, providerToolCallsById),
    ).toEqual([
      {
        type: "tool-input-start",
        id: fallbackId,
        toolName: "nativeWebSearch",
        providerExecuted: true,
      },
    ]);

    const deltaEvent = {
      event_type: "content.delta",
      index: 0,
      delta: {
        type: "google_search_call",
        id: "gs_real",
        arguments: { queries: ["latest Gemini announcements"] },
      },
    };
    googleNativeInternal.processStreamEvent(deltaEvent, blocks, providerToolCallsById);

    const block = blocks.get(0);
    expect(block).toBeDefined();
    expect(block.type).toBe("providerToolCall");
    expect(block.id).toBe(fallbackId);
    expect(block.arguments).toEqual({ queries: ["latest Gemini announcements"] });

    expect(
      googleNativeInternal.mapGoogleEventToStreamParts(deltaEvent, blocks, providerToolCallsById),
    ).toEqual([
      {
        type: "tool-input-delta",
        id: fallbackId,
        delta: '{"queries":["latest Gemini announcements"]}',
      },
    ]);

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 1,
        content: {
          type: "google_search_result",
          call_id: "gs_real",
          result: [{ search_suggestions: "Latest Gemini announcements" }],
        },
      },
      blocks,
      providerToolCallsById,
    );

    expect(
      googleNativeInternal.mapGoogleEventToStreamParts(
        { event_type: "content.stop", index: 1 },
        blocks,
        providerToolCallsById,
      ),
    ).toEqual([
      {
        type: "tool-result",
        toolCallId: fallbackId,
        toolName: "nativeWebSearch",
        output: {
          provider: "google",
          status: "completed",
          callId: fallbackId,
          queries: ["latest Gemini announcements"],
          results: [{ search_suggestions: "Latest Gemini announcements" }],
          raw: [{ search_suggestions: "Latest Gemini announcements" }],
        },
        providerExecuted: true,
      },
    ]);
  });

  test("identifies native code execution stream content as disabled", () => {
    expect(googleNativeInternal.isGoogleCodeExecutionContentType("code_execution_call")).toBe(true);
    expect(googleNativeInternal.isGoogleCodeExecutionContentType("code_execution_result")).toBe(
      true,
    );
    expect(googleNativeInternal.isGoogleCodeExecutionContentType("google_search_call")).toBe(false);
  });

  test("processStreamEvent ignores native code execution blocks", () => {
    const blocks = new Map();
    const providerToolCallsById = new Map();

    const startEvent = {
      event_type: "content.start",
      index: 0,
      content: {
        type: "code_execution_call",
      },
    };
    googleNativeInternal.processStreamEvent(startEvent, blocks, providerToolCallsById);

    expect(blocks.get(0)).toBeUndefined();
    expect(
      googleNativeInternal.mapGoogleEventToStreamParts(startEvent, blocks, providerToolCallsById),
    ).toEqual([]);

    const deltaEvent = {
      event_type: "content.delta",
      index: 0,
      delta: {
        type: "code_execution_call",
        id: "code_real",
        arguments: { code: "print(6 * 7)", language: "python" },
      },
    };
    googleNativeInternal.processStreamEvent(deltaEvent, blocks, providerToolCallsById);

    expect(blocks.get(0)).toBeUndefined();
    expect(
      googleNativeInternal.mapGoogleEventToStreamParts(deltaEvent, blocks, providerToolCallsById),
    ).toEqual([]);

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 1,
        content: {
          type: "code_execution_result",
          call_id: "code_real",
          result: "42\n",
        },
      },
      blocks,
      providerToolCallsById,
    );

    expect(
      googleNativeInternal.mapGoogleEventToStreamParts(
        { event_type: "content.stop", index: 1 },
        blocks,
        providerToolCallsById,
      ),
    ).toEqual([]);
  });

  test("processStreamEvent handles thought content with signature", () => {
    const blocks = new Map();

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 0,
        content: { type: "thought", signature: "sig_abc" },
      },
      blocks,
    );
    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.delta",
        index: 0,
        delta: { type: "thought_summary", content: { type: "text", text: "Thinking about it..." } },
      },
      blocks,
    );
    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.delta",
        index: 0,
        delta: { type: "thought_signature", signature: "sig_final" },
      },
      blocks,
    );

    const block = blocks.get(0);
    expect(block).toBeDefined();
    expect(block.type).toBe("thinking");
    expect(block.thinking).toBe("Thinking about it...");
    expect(block.thinkingSignature).toBe("sig_final");
  });

  test("processStreamEvent preserves thought summaries that arrive before thought start", () => {
    const blocks = new Map();

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.delta",
        index: 0,
        delta: { type: "thought_summary", content: { type: "text", text: "Buffered reasoning." } },
      },
      blocks,
    );
    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.delta",
        index: 0,
        delta: { type: "thought_signature", signature: "sig_buffered" },
      },
      blocks,
    );
    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 0,
        content: { type: "thought" },
      },
      blocks,
    );

    const block = blocks.get(0);
    expect(block).toBeDefined();
    expect(block.type).toBe("thinking");
    expect(block.thinking).toBe("Buffered reasoning.");
    expect(block.thinkingSignature).toBe("sig_buffered");
  });

  test("mapGoogleEventToStreamParts emits normalized model stream parts", () => {
    const blocks = new Map();

    googleNativeInternal.processStreamEvent(
      { event_type: "content.start", index: 0, content: { type: "text", text: "" } },
      blocks,
    );
    expect(
      googleNativeInternal.mapGoogleEventToStreamParts(
        { event_type: "content.start", index: 0, content: { type: "text", text: "" } },
        blocks,
      ),
    ).toEqual([{ type: "text-start", id: "s0" }]);

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 1,
        content: { type: "thought", signature: "sig_1" },
      },
      blocks,
    );
    expect(
      googleNativeInternal.mapGoogleEventToStreamParts(
        {
          event_type: "content.delta",
          index: 1,
          delta: { type: "thought_summary", content: { type: "text", text: "Thinking..." } },
        },
        blocks,
      ),
    ).toEqual([{ type: "reasoning-delta", id: "s1", text: "Thinking..." }]);

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 2,
        content: {
          type: "function_call",
          id: "call_1",
          name: "bash",
          arguments: { command: "ls" },
        },
      },
      blocks,
    );
    expect(
      googleNativeInternal.mapGoogleEventToStreamParts(
        {
          event_type: "content.stop",
          index: 2,
        },
        blocks,
      ),
    ).toEqual([
      { type: "tool-input-end", id: "call_1" },
      { type: "tool-call", toolCallId: "call_1", toolName: "bash", input: { command: "ls" } },
    ]);
  });

  test("mapGoogleEventToStreamParts emits tool calls with names learned from deltas", () => {
    const blocks = new Map();

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 0,
        content: { type: "function_call", id: "call_1" },
      },
      blocks,
    );
    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.delta",
        index: 0,
        delta: {
          type: "function_call",
          name: "webSearch",
          arguments: { query: "NVIDIA GTC 2026 dates announcements keynote" },
        },
      },
      blocks,
    );

    expect(
      googleNativeInternal.mapGoogleEventToStreamParts(
        { event_type: "content.stop", index: 0 },
        blocks,
      ),
    ).toEqual([
      { type: "tool-input-end", id: "call_1" },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "webSearch",
        input: { query: "NVIDIA GTC 2026 dates announcements keynote" },
      },
    ]);
  });

  test("mapGoogleEventToStreamParts normalizes native Google tool calls and results", () => {
    const blocks = new Map();
    const providerToolCallsById = new Map();

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 0,
        content: {
          type: "google_search_call",
          id: "gs_1",
          arguments: { queries: ["latest Gemini announcements"] },
        },
      },
      blocks,
      providerToolCallsById,
    );

    expect(
      googleNativeInternal.mapGoogleEventToStreamParts(
        {
          event_type: "content.stop",
          index: 0,
        },
        blocks,
        providerToolCallsById,
      ),
    ).toEqual([
      { type: "tool-input-end", id: "gs_1", toolName: "nativeWebSearch", providerExecuted: true },
    ]);

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 1,
        content: {
          type: "google_search_result",
          call_id: "gs_1",
          result: [{ search_suggestions: "Latest Gemini announcements" }],
        },
      },
      blocks,
      providerToolCallsById,
    );

    expect(
      googleNativeInternal.mapGoogleEventToStreamParts(
        {
          event_type: "content.stop",
          index: 1,
        },
        blocks,
        providerToolCallsById,
      ),
    ).toEqual([
      {
        type: "tool-result",
        toolCallId: "gs_1",
        toolName: "nativeWebSearch",
        output: {
          provider: "google",
          status: "completed",
          callId: "gs_1",
          queries: ["latest Gemini announcements"],
          results: [{ search_suggestions: "Latest Gemini announcements" }],
          raw: [{ search_suggestions: "Latest Gemini announcements" }],
        },
        providerExecuted: true,
      },
    ]);
  });

  test("mapGoogleEventToStreamParts preserves native Google search sources for citation fallbacks", () => {
    const blocks = new Map();
    const providerToolCallsById = new Map();

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 0,
        content: {
          type: "google_search_call",
          id: "gs_2",
          arguments: { queries: ["latest Gemini announcements"] },
        },
      },
      blocks,
      providerToolCallsById,
    );

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 1,
        content: {
          type: "google_search_result",
          call_id: "gs_2",
          result: {
            results: [{ search_suggestions: "Latest Gemini announcements" }],
            sources: [{ title: "Gemini update", url: "https://example.com/gemini-update" }],
          },
        },
      },
      blocks,
      providerToolCallsById,
    );

    expect(
      googleNativeInternal.mapGoogleEventToStreamParts(
        {
          event_type: "content.stop",
          index: 1,
        },
        blocks,
        providerToolCallsById,
      ),
    ).toEqual([
      {
        type: "tool-result",
        toolCallId: "gs_2",
        toolName: "nativeWebSearch",
        output: {
          provider: "google",
          status: "completed",
          callId: "gs_2",
          queries: ["latest Gemini announcements"],
          results: [{ search_suggestions: "Latest Gemini announcements" }],
          sources: [{ title: "Gemini update", url: "https://example.com/gemini-update" }],
          raw: {
            results: [{ search_suggestions: "Latest Gemini announcements" }],
            sources: [{ title: "Gemini update", url: "https://example.com/gemini-update" }],
          },
        },
        providerExecuted: true,
      },
    ]);
  });

  test("mapGoogleEventToStreamParts preserves singleton native URL context result objects", () => {
    const blocks = new Map();
    const providerToolCallsById = new Map();

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 0,
        content: {
          type: "url_context_call",
          id: "uc_1",
          arguments: { urls: ["https://example.com"] },
        },
      },
      blocks,
      providerToolCallsById,
    );

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 1,
        content: {
          type: "url_context_result",
          call_id: "uc_1",
          result: { url: "https://example.com", status: "ok" },
        },
      },
      blocks,
      providerToolCallsById,
    );

    expect(
      googleNativeInternal.mapGoogleEventToStreamParts(
        {
          event_type: "content.stop",
          index: 1,
        },
        blocks,
        providerToolCallsById,
      ),
    ).toEqual([
      {
        type: "tool-result",
        toolCallId: "uc_1",
        toolName: "nativeUrlContext",
        output: {
          provider: "google",
          status: "completed",
          callId: "uc_1",
          urls: ["https://example.com"],
          results: [{ url: "https://example.com", status: "ok" }],
          raw: { url: "https://example.com", status: "ok" },
        },
        providerExecuted: true,
      },
    ]);
  });

  test("mapGoogleEventToStreamParts carries assistant text annotations through text-end", () => {
    const blocks = new Map();
    const providerToolCallsById = new Map();

    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.start",
        index: 0,
        content: { type: "text", text: "Coffee shops" },
      },
      blocks,
      providerToolCallsById,
    );
    googleNativeInternal.processStreamEvent(
      {
        event_type: "content.delta",
        index: 0,
        delta: {
          type: "text",
          text: " nearby",
          annotations: [
            {
              type: "place_citation",
              start_index: 0,
              end_index: 12,
              name: "Blue Bottle Coffee",
              url: "https://maps.google.com/?cid=123",
            },
          ],
        },
      },
      blocks,
      providerToolCallsById,
    );

    expect(
      googleNativeInternal.mapGoogleEventToStreamParts(
        { event_type: "content.stop", index: 0 },
        blocks,
        providerToolCallsById,
      ),
    ).toEqual([
      {
        type: "text-end",
        id: "s0",
        annotations: [
          {
            type: "place_citation",
            start_index: 0,
            end_index: 12,
            name: "Blue Bottle Coffee",
            url: "https://maps.google.com/?cid=123",
          },
        ],
      },
    ]);
  });

  test("resolveGoogleApiKey throws when no key is available", () => {
    const origEnv1 = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const origEnv2 = process.env.GOOGLE_API_KEY;
    const origEnv3 = process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      expect(() => googleNativeInternal.resolveGoogleApiKey()).toThrow("No API key");
    } finally {
      if (origEnv1) process.env.GOOGLE_GENERATIVE_AI_API_KEY = origEnv1;
      if (origEnv2) process.env.GOOGLE_API_KEY = origEnv2;
      if (origEnv3) process.env.GEMINI_API_KEY = origEnv3;
    }
  });

  test("resolveGoogleApiKey uses explicit key when provided", () => {
    expect(googleNativeInternal.resolveGoogleApiKey("my-key")).toBe("my-key");
  });
});
