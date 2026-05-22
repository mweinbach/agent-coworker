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

});
