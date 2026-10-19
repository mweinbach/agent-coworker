import { describe, expect, test } from "bun:test";
import { mapGoogleEventToStreamParts } from "../../../src/runtime/googleNative/stream/mapToStreamParts";
import { processStreamEvent } from "../../../src/runtime/googleNative/stream/processEvent";
import {
  type GoogleInteractionsContentBlock,
  type GoogleInteractionsProviderToolCallState,
  mapGoogleInteractionsEventToStreamParts,
  processGoogleInteractionsStreamEvent,
} from "../../../src/shared/googleInteractionsStreamParts";

describe.each([
  ["native", processStreamEvent, mapGoogleEventToStreamParts],
  ["replay", processGoogleInteractionsStreamEvent, mapGoogleInteractionsEventToStreamParts],
] as const)("Google %s provider tool arguments", (_name, processEvent, mapEvent) => {
  describe.each(["content", "step"] as const)("%s events", (eventPrefix) => {
    test.each([
      ["google_search", "nativeWebSearch", "queries", ["Gemini news"]],
      ["url_context", "nativeUrlContext", "urls", ["https://example.com"]],
    ] as const)(
      "%s results include arguments streamed after the call ID changes",
      (wireName, toolName, field, values) => {
        const blocks = new Map<number, GoogleInteractionsContentBlock>();
        const calls = new Map<string, GoogleInteractionsProviderToolCallState>();
        const parts: Array<Record<string, unknown>> = [];
        const argumentsJson = JSON.stringify({ [field]: values });
        const chunks = [argumentsJson.slice(0, 5), argumentsJson.slice(5)];
        const events = [
          {
            event_type: `${eventPrefix}.start`,
            index: 0,
            [eventPrefix]: { type: `${wireName}_call`, id: "emitted", arguments: { keep: true } },
          },
          {
            event_type: `${eventPrefix}.delta`,
            index: 0,
            delta: { type: `${wireName}_call`, id: "wire" },
          },
          ...chunks.map((chunk) => ({
            event_type: `${eventPrefix}.delta`,
            index: 0,
            delta: { type: "arguments_delta", arguments: chunk },
          })),
          { event_type: `${eventPrefix}.stop`, index: 0 },
          {
            event_type: `${eventPrefix}.start`,
            index: 1,
            [eventPrefix]: {
              type: `${wireName}_result`,
              call_id: "wire",
              result: [{ title: "Result" }],
            },
          },
          { event_type: `${eventPrefix}.stop`, index: 1 },
        ];
        for (const event of events) {
          processEvent(event, blocks, calls);
          parts.push(...mapEvent(event, blocks, calls));
        }

        expect(parts).toEqual([
          { type: "tool-input-start", id: "emitted", toolName, providerExecuted: true },
          { type: "tool-input-delta", id: "emitted", delta: '{"keep":true}' },
          ...chunks.map((chunk) => ({ type: "tool-input-delta", id: "emitted", delta: chunk })),
          { type: "tool-input-end", id: "emitted", toolName, providerExecuted: true },
          {
            type: "tool-result",
            toolCallId: "emitted",
            toolName,
            providerExecuted: true,
            output: {
              provider: "google",
              status: "completed",
              callId: "emitted",
              [field]: values,
              results: [{ title: "Result" }],
              raw: [{ title: "Result" }],
            },
          },
        ]);
        for (const id of ["emitted", "wire"]) {
          expect(calls.get(id)?.arguments).toEqual({ keep: true, [field]: values });
        }
        expect(blocks.get(0)).toEqual({
          type: "providerToolCall",
          id: "emitted",
          name: toolName,
          arguments: { keep: true, [field]: values },
        });
      },
    );
  });
});

describe.each([
  ["native", processStreamEvent, mapGoogleEventToStreamParts],
  ["replay", processGoogleInteractionsStreamEvent, mapGoogleInteractionsEventToStreamParts],
] as const)("Google %s argument buffering", (_name, processEvent, mapEvent) => {
  describe.each(["content", "step"] as const)("%s events", (prefix) => {
    test.each(["function_call", "google_search_call"] as const)(
      "%s keeps a literal __jsonDelta argument separate from streamed JSON",
      (type) => {
        const blocks = new Map<number, GoogleInteractionsContentBlock>();
        const calls = new Map<string, GoogleInteractionsProviderToolCallState>();
        processEvent(
          {
            event_type: `${prefix}.start`,
            index: 0,
            [prefix]: {
              type,
              id: "call",
              ...(type === "function_call" ? { name: "read" } : {}),
              arguments: { __jsonDelta: "literal", keep: true },
            },
          },
          blocks,
          calls,
        );
        const block = blocks.get(0);
        if (block?.type !== "toolCall" && block?.type !== "providerToolCall") {
          throw new Error("Expected a tool call");
        }
        const argumentsRecord = block.arguments;
        processEvent(
          {
            event_type: `${prefix}.delta`,
            index: 0,
            delta: { type: "arguments_delta", arguments: '{"path":' },
          },
          blocks,
          calls,
        );
        expect(argumentsRecord).toEqual({ __jsonDelta: "literal", keep: true });
        for (const chunk of ['"report.md"}', " \n"]) {
          processEvent(
            {
              event_type: `${prefix}.delta`,
              index: 0,
              delta: { type: "arguments_delta", arguments: chunk },
            },
            blocks,
            calls,
          );
        }
        const stop = { event_type: `${prefix}.stop`, index: 0 };
        processEvent(stop, blocks, calls);
        mapEvent(stop, blocks, calls);
        expect(block.arguments).toBe(argumentsRecord);
        expect(block.arguments).toEqual({ __jsonDelta: "literal", keep: true, path: "report.md" });
      },
    );
  });
});

describe.each([
  ["native", processStreamEvent, mapGoogleEventToStreamParts],
  ["replay", processGoogleInteractionsStreamEvent, mapGoogleInteractionsEventToStreamParts],
] as const)("Google %s tool-argument finalization", (_name, processEvent, mapEvent) => {
  describe.each(["content", "step"] as const)("%s events", (prefix) => {
    function startCall(type: "function_call" | "google_search_call") {
      const blocks = new Map<number, GoogleInteractionsContentBlock>();
      const calls = new Map<string, GoogleInteractionsProviderToolCallState>();
      processEvent(
        {
          event_type: `${prefix}.start`,
          index: 0,
          [prefix]: {
            type,
            id: "call",
            ...(type === "function_call" ? { name: "read" } : {}),
            arguments: { keep: true },
          },
        },
        blocks,
        calls,
      );
      const block = blocks.get(0);
      if (block?.type !== "toolCall" && block?.type !== "providerToolCall") {
        throw new Error("Expected a tool call");
      }
      return { blocks, calls, block };
    }

    function pushDelta(
      blocks: Map<number, GoogleInteractionsContentBlock>,
      calls: Map<string, GoogleInteractionsProviderToolCallState>,
      delta: string,
    ) {
      processEvent(
        {
          event_type: `${prefix}.delta`,
          index: 0,
          delta: { type: "arguments_delta", arguments: delta },
        },
        blocks,
        calls,
      );
    }

    function finish(
      blocks: Map<number, GoogleInteractionsContentBlock>,
      calls: Map<string, GoogleInteractionsProviderToolCallState>,
    ) {
      const event = { event_type: `${prefix}.stop`, index: 0 };
      processEvent(event, blocks, calls);
      return () => mapEvent(event, blocks, calls);
    }

    function toolName(type: "function_call" | "google_search_call") {
      return type === "function_call" ? "read" : "nativeWebSearch";
    }

    test.each([
      ["function_call", "{"],
      ["google_search_call", "{"],
      ["function_call", "[1]"],
      ["google_search_call", "null"],
      ["function_call", '"text"'],
    ] as const)("%s rejects %j and keeps the original arguments", (type, payload) => {
      const started = startCall(type);
      const argumentsRecord = started.block.arguments;
      pushDelta(started.blocks, started.calls, payload);
      const stop = finish(started.blocks, started.calls);
      const message = `Invalid JSON arguments for Google tool call "${toolName(type)}".`;
      expect(stop).toThrow(message);
      expect(stop).toThrow(message);
      expect(started.block.arguments).toBe(argumentsRecord);
      expect(started.block.arguments).toEqual({ keep: true });
      if (type === "google_search_call") {
        expect(started.calls.get("call")?.arguments).toBe(argumentsRecord);
      }
    });

    test.each(["function_call", "google_search_call"] as const)(
      "%s rejects trailing garbage after a complete argument object",
      (type) => {
        const started = startCall(type);
        pushDelta(started.blocks, started.calls, '{"path":"a"}');
        expect(started.block.arguments).toEqual({ keep: true, path: "a" });
        pushDelta(started.blocks, started.calls, "x");
        expect(finish(started.blocks, started.calls)).toThrow(
          `Invalid JSON arguments for Google tool call "${toolName(type)}".`,
        );
        expect(started.block.arguments).toEqual({ keep: true, path: "a" });
        if (type === "google_search_call") {
          expect(started.calls.get("call")?.arguments).toBe(started.block.arguments);
        }
      },
    );
  });
});
