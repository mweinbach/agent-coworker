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
});
