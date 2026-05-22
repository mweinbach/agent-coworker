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
});
