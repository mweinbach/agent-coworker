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
import { __internal as citationMetadataInternal } from "../../../src/server/citationMetadata";
import type { RuntimeRunTurnParams } from "../../../src/runtime/types";
import {
  googleSseResponse,
  liveGoogleTest,
  makeConfig,
  makeParams,
} from "./fixtures";

describe("google native interactions request building", () => {

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

});
