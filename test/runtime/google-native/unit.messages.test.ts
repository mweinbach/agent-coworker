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
import { googleSseResponse, liveGoogleTest, makeConfig, makeParams } from "./fixtures";

describe("google native interactions request building", () => {
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
});
