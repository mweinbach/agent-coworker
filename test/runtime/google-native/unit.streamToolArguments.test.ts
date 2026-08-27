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
