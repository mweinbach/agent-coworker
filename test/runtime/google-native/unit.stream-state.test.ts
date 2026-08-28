import { describe, expect, test } from "bun:test";
import { mapGoogleEventToStreamParts } from "../../../src/runtime/googleNative/stream/mapToStreamParts";
import { processStreamEvent } from "../../../src/runtime/googleNative/stream/processEvent";
import type {
  AssistantContentBlock,
  ProviderToolCallState,
} from "../../../src/runtime/googleNative/stream/types";

describe.each(["content", "step"] as const)("Google %s stream state", (eventPrefix) => {
  function event(phase: "start" | "delta", content: Record<string, unknown>, index = 0) {
    return {
      event_type: `${eventPrefix}.${phase}`,
      index,
      [phase === "start" ? eventPrefix : "delta"]: content,
    };
  }

  test("text starts replace blocks while deltas preserve text and annotation identity", () => {
    const oldBlock: AssistantContentBlock = { type: "text", text: "old" };
    const blocks = new Map<number, AssistantContentBlock>([[0, oldBlock]]);
    const citation = { type: "url_citation", url: "https://example.com" };

    processStreamEvent(
      event("start", { type: "text", text: "  Answer  ", annotations: [null, citation, 1] }),
      blocks,
    );
    const started = blocks.get(0);
    expect(started).not.toBe(oldBlock);
    expect(started).toEqual({ type: "text", text: "Answer", annotations: [citation] });
    processStreamEvent(
      event("delta", { type: "text", text: " more ", annotations: [{ ...citation }] }),
      blocks,
    );
    expect(blocks.get(0)).toBe(started);
    expect(started).toEqual({ type: "text", text: "Answer more ", annotations: [citation] });
    if (started?.type !== "text") throw new Error("Expected text block");
    expect(started.annotations?.[0]).toBe(citation);

    processStreamEvent(event("start", { type: "text", text: 42 }), blocks);
    expect(blocks.get(0)).toEqual({ type: "text", text: "" });
    processStreamEvent(event("delta", { type: "text", text: 42 }), blocks);
    expect(blocks.get(0)).toEqual({ type: "text", text: "42" });
  });

  test("text deltas preserve another block until a valid annotation replaces it", () => {
    const original: AssistantContentBlock = { type: "thinking", thinking: "reasoning" };
    const blocks = new Map<number, AssistantContentBlock>([[0, original]]);

    processStreamEvent(event("delta", { type: "text", text: "ignored" }), blocks);
    processStreamEvent(event("delta", { type: "text", text: { toString: false } }), blocks);
    processStreamEvent(event("delta", { type: "text_annotation", annotations: [null] }), blocks);
    expect(blocks.get(0)).toBe(original);

    const citation = { url: "https://example.com" };
    processStreamEvent(
      event("delta", { type: "text_annotation_delta", annotations: [citation] }),
      blocks,
    );
    processStreamEvent(event("delta", { type: "text", text: "answer" }), blocks);
    expect(blocks.get(0)).toEqual({ type: "text", text: "answer", annotations: [citation] });

    processStreamEvent(event("delta", { type: "text", text: " untrimmed " }, 1), blocks);
    expect(blocks.get(1)).toEqual({ type: "text", text: " untrimmed " });
  });

  test.each(["image", "audio", "video", "document"] as const)(
    "%s deltas merge only matching media and starts reset all fields",
    (type) => {
      const blocks = new Map<number, AssistantContentBlock>();
      processStreamEvent(
        event("start", { type, data: " initial ", uri: " old ", mime_type: " old/type " }),
        blocks,
      );
      processStreamEvent(
        event("delta", { type, data: null, uri: " new ", mime_type: " " }),
        blocks,
      );
      expect(blocks.get(0)).toEqual({ type, data: "initial", uri: "new", mime_type: "old/type" });
      expect(
        mapGoogleEventToStreamParts({ event_type: `${eventPrefix}.stop`, index: 0 }, blocks),
      ).toEqual([
        { type: "file", mediaType: type, data: "initial", uri: "new", mime_type: "old/type" },
      ]);

      processStreamEvent(event("start", { type, data: " replacement " }), blocks);
      expect(blocks.get(0)).toEqual({ type, data: "replacement" });
      processStreamEvent(event("start", { type: "text", text: "replace me" }), blocks);
      processStreamEvent(event("delta", { type, uri: " fresh " }), blocks);
      expect(blocks.get(0)).toEqual({ type, uri: "fresh" });
    },
  );

  test.each(["start", "delta"] as const)("function call %s can create a new block", (phase) => {
    const blocks = new Map<number, AssistantContentBlock>([[0, { type: "text", text: "old" }]]);
    const args = { command: "pwd" };
    processStreamEvent(
      event(phase, { type: "function_call", id: " call ", arguments: args, signature: " sig " }),
      blocks,
    );
    expect(blocks.get(0)).toEqual({
      type: "toolCall",
      id: "call",
      name: "tool",
      arguments: args,
      thoughtSignature: "sig",
    });
    const block = blocks.get(0);
    if (block?.type !== "toolCall") throw new Error("Expected function call");
    expect(block.arguments).toBe(args);
  });

  test("function deltas retain the emitted ID and arguments object until a new start", () => {
    const blocks = new Map<number, AssistantContentBlock>();
    processStreamEvent(
      event("start", { type: "function_call", id: "first", name: "tool", signature: "first_sig" }),
      blocks,
    );
    const block = blocks.get(0);
    if (block?.type !== "toolCall") throw new Error("Expected function call");
    const args = block.arguments;
    processStreamEvent(
      event("delta", {
        type: "function_call",
        id: "later",
        name: "bash",
        arguments: { keep: true },
      }),
      blocks,
    );
    processStreamEvent(
      event("delta", { type: "arguments_delta", arguments: '{"command":' }),
      blocks,
    );
    processStreamEvent(event("delta", { type: "arguments_delta", arguments: '"pwd"}' }), blocks);
    processStreamEvent(
      event("delta", { type: "function_call", name: " ", signature: " " }),
      blocks,
    );
    expect(blocks.get(0)).toBe(block);
    expect(block.arguments).toBe(args);
    expect(block).toEqual({
      type: "toolCall",
      id: "first",
      name: "bash",
      arguments: { keep: true, command: "pwd" },
      thoughtSignature: "first_sig",
    });

    processStreamEvent(event("start", { type: "function_call", id: "replacement" }), blocks);
    expect(blocks.get(0)).toEqual({
      type: "toolCall",
      id: "replacement",
      name: "tool",
      arguments: {},
    });
  });

  test.each([
    ["google_search", "nativeWebSearch"],
    ["url_context", "nativeUrlContext"],
    ["file_search", "nativeFileSearch"],
    ["google_maps", "nativeGoogleMaps"],
    ["mcp_server_tool", "nativeMcpServerTool"],
  ] as const)("%s starts and deltas share normalized call and result shapes", (wireName, name) => {
    for (const phase of ["start", "delta"] as const) {
      const blocks = new Map<number, AssistantContentBlock>();
      const calls = new Map<string, ProviderToolCallState>();
      const args = { query: "Gemini", name: "overridden", server_name: "overridden" };
      processStreamEvent(
        event(phase, {
          type: `${wireName}_call`,
          id: " first ",
          name: " lookup ",
          server_name: " docs ",
          arguments: args,
          signature: " call_sig ",
        }),
        blocks,
        calls,
      );
      const normalizedArgs = { query: "Gemini", name: "lookup", server_name: "docs" };
      expect(blocks.get(0)).toEqual({
        type: "providerToolCall",
        id: "first",
        name,
        arguments: normalizedArgs,
        thoughtSignature: "call_sig",
      });
      expect(calls.get("first")).toEqual({ emittedId: "first", name, arguments: normalizedArgs });
      expect(calls.get("first")?.arguments).not.toBe(args);

      processStreamEvent(
        event(
          phase,
          {
            type: `${wireName}_result`,
            call_id: " first ",
            result: { ok: true },
            is_error: true,
            signature: " result_sig ",
          },
          1,
        ),
        blocks,
        calls,
      );
      expect(blocks.get(1)).toEqual({
        type: "providerToolResult",
        callId: "first",
        name,
        result: { ok: true },
        isError: true,
        thoughtSignature: "result_sig",
      });
    }
  });

  test("provider deltas retain call and result identities while resolving later wire IDs", () => {
    const blocks = new Map<number, AssistantContentBlock>();
    const calls = new Map<string, ProviderToolCallState>();
    processStreamEvent(
      event("start", { type: "mcp_server_tool_call", id: "emitted", name: "lookup" }),
      blocks,
      calls,
    );
    const call = blocks.get(0);
    processStreamEvent(
      event("delta", {
        type: "mcp_server_tool_call",
        id: "wire",
        name: "lookup_new",
        server_name: "docs",
        arguments: { query: "Gemini" },
        signature: " call_sig ",
      }),
      blocks,
      calls,
    );
    expect(blocks.get(0)).toBe(call);
    expect(calls.get("wire")).toBe(calls.get("emitted"));
    expect(call).toEqual({
      type: "providerToolCall",
      id: "emitted",
      name: "nativeMcpServerTool",
      arguments: { name: "lookup_new", server_name: "docs", query: "Gemini" },
      thoughtSignature: "call_sig",
    });
    processStreamEvent(
      event(
        "start",
        {
          type: "mcp_server_tool_result",
          call_id: "wire",
          result: { ok: true },
          is_error: true,
          signature: "result_sig",
        },
        1,
      ),
      blocks,
      calls,
    );
    const result = blocks.get(1);
    processStreamEvent(
      event("delta", { type: "mcp_server_tool_result", call_id: "wire", signature: " " }, 1),
      blocks,
      calls,
    );
    expect(blocks.get(1)).toBe(result);
    expect(result).toEqual({
      type: "providerToolResult",
      callId: "emitted",
      name: "nativeMcpServerTool",
      result: { ok: true },
      isError: false,
      thoughtSignature: "result_sig",
    });
    expect(
      mapGoogleEventToStreamParts({ event_type: `${eventPrefix}.stop`, index: 1 }, blocks, calls),
    ).toEqual([
      {
        type: "tool-result",
        toolCallId: "emitted",
        toolName: "nativeMcpServerTool",
        output: {
          provider: "google",
          status: "completed",
          callId: "emitted",
          serverName: "docs",
          name: "lookup_new",
          result: { ok: true },
          raw: { ok: true },
        },
        providerExecuted: true,
      },
    ]);
  });

  test("thought starts preserve buffered summaries and delta signatures remain untrimmed", () => {
    const blocks = new Map<number, AssistantContentBlock>();
    processStreamEvent(
      event("delta", { type: "thought_signature", signature: " buffered " }),
      blocks,
    );
    const block = blocks.get(0);
    processStreamEvent(
      event("start", { type: "thought", summary: [{ text: " first " }, null, { text: 42 }] }),
      blocks,
    );
    processStreamEvent(
      event("delta", { type: "thought_summary", content: { type: "text", text: " next " } }),
      blocks,
    );
    expect(blocks.get(0)).toBe(block);
    expect(block).toEqual({
      type: "thinking",
      thinking: "first next ",
      thinkingSignature: " buffered ",
    });
    processStreamEvent(event("delta", { type: "thought_signature", signature: "" }), blocks);
    expect(block).toEqual({ type: "thinking", thinking: "first next ", thinkingSignature: "" });
  });

  test("model output starts preserve annotation order and ignore empty replacements", () => {
    const blocks = new Map<number, AssistantContentBlock>();
    const annotation = { url: "https://example.com" };
    processStreamEvent(
      event("start", {
        type: "model_output",
        content: [
          { text: " first ", annotations: [annotation, null] },
          { text: " second ", annotations: [annotation] },
        ],
      }),
      blocks,
    );
    const block = blocks.get(0);
    expect(block).toEqual({
      type: "text",
      text: "firstsecond",
      annotations: [annotation, annotation],
    });
    processStreamEvent(event("start", { type: "model_output", content: [null, {}] }), blocks);
    expect(blocks.get(0)).toBe(block);
  });

  test("invalid, phase-specific, and unrecognized payloads leave existing state alone", () => {
    const original: AssistantContentBlock = { type: "text", text: "untouched" };
    const blocks = new Map<number, AssistantContentBlock>([[0, original]]);
    const ignoredEvents = [
      event("delta", { type: "model_output", content: [{ text: "ignored" }] }),
      event("delta", { type: "thought", summary: [{ text: "ignored" }] }),
      ...[
        "text_annotation",
        "text_annotation_delta",
        "arguments_delta",
        "thought_summary",
        "thought_signature",
      ].map((type) =>
        event("start", {
          type,
          text: "ignored",
          annotations: [{ url: "ignored" }],
          arguments: '{"ignored":true}',
          content: { type: "text", text: "ignored" },
          signature: "ignored",
        }),
      ),
      event("start", { type: "thought", summary: [{ text: "ignored" }] }),
      event("delta", { type: "arguments_delta", arguments: '{"ignored":true}' }),
      event("start", { type: "google_search_result", result: "no call ID" }),
      event("delta", { type: "google_search_result", call_id: " " }),
      event("start", { type: "unknown" }),
      event("delta", {}),
      { event_type: "other.start", index: 0, content: { type: "text", text: "ignored" } },
      { event_type: `${eventPrefix}.start`, index: 0, [eventPrefix]: [] },
      { event_type: `${eventPrefix}.delta`, index: 0, delta: null },
    ];
    for (const ignored of ignoredEvents) {
      processStreamEvent(ignored, blocks);
      expect(blocks.get(0)).toBe(original);
      expect(original).toEqual({ type: "text", text: "untouched" });
    }
  });
});
