import { describe, expect, test } from "bun:test";
import { buildNativeGoogleToolResultOutput } from "../../../src/runtime/googleNative/nativeTools";
import { mapGoogleEventToStreamParts } from "../../../src/runtime/googleNative/stream/mapToStreamParts";
import type { AssistantContentBlock } from "../../../src/runtime/googleNative/stream/types";

type ToolCallBlock = Extract<AssistantContentBlock, { type: "toolCall" | "providerToolCall" }>;

const toolCases: Array<[string, ToolCallBlock]> = [
  [
    "function_call",
    { type: "toolCall", id: "emitted", name: "bash", arguments: { initial: true } },
  ],
  [
    "google_search_call",
    {
      type: "providerToolCall",
      id: "emitted",
      name: "nativeWebSearch",
      arguments: { initial: true },
    },
  ],
  [
    "url_context_call",
    {
      type: "providerToolCall",
      id: "emitted",
      name: "nativeUrlContext",
      arguments: { initial: true },
    },
  ],
  [
    "file_search_call",
    {
      type: "providerToolCall",
      id: "emitted",
      name: "nativeFileSearch",
      arguments: { initial: true },
    },
  ],
  [
    "google_maps_call",
    {
      type: "providerToolCall",
      id: "emitted",
      name: "nativeGoogleMaps",
      arguments: { initial: true },
    },
  ],
  [
    "mcp_server_tool_call",
    {
      type: "providerToolCall",
      id: "emitted",
      name: "nativeMcpServerTool",
      arguments: { initial: true },
    },
  ],
];

describe.each(["content", "step"] as const)("Google %s tool projection", (prefix) => {
  test.each(toolCases)(
    "%s starts preserve emitted IDs and initial argument order",
    (wireType, block) => {
      const blocks = new Map<number, AssistantContentBlock>([[7, block]]);
      const event = {
        event_type: `${prefix}.start`,
        index: 7,
        [prefix]: { type: wireType, id: "wire-id", arguments: { incoming: true } },
      };
      const expectedStart = {
        type: "tool-input-start",
        id: "emitted",
        toolName: block.name,
        ...(block.type === "providerToolCall" ? { providerExecuted: true } : {}),
      };
      expect(mapGoogleEventToStreamParts(event, blocks)).toStrictEqual([
        expectedStart,
        { type: "tool-input-delta", id: "emitted", delta: '{"initial":true}' },
      ]);
      blocks.set(7, { ...block, arguments: {} });
      expect(mapGoogleEventToStreamParts(event, blocks)).toStrictEqual([expectedStart]);
      expect(block.arguments).toStrictEqual({ initial: true });
    },
  );

  test.each(toolCases)("%s deltas use only incoming record arguments", (wireType, block) => {
    const blocks = new Map<number, AssistantContentBlock>([[7, block]]);
    const event = {
      event_type: `${prefix}.delta`,
      index: 7,
      delta: { type: wireType, id: "wire-id", arguments: { incoming: true } },
    };
    expect(mapGoogleEventToStreamParts(event, blocks)).toStrictEqual([
      { type: "tool-input-delta", id: "emitted", delta: '{"incoming":true}' },
    ]);
    expect(
      mapGoogleEventToStreamParts({ ...event, delta: { type: wireType, arguments: {} } }, blocks),
    ).toStrictEqual([{ type: "tool-input-delta", id: "emitted", delta: "{}" }]);
    for (const args of [undefined, null, "{}", [], 1]) {
      expect(
        mapGoogleEventToStreamParts(
          { ...event, delta: { type: wireType, arguments: args } },
          blocks,
        ),
      ).toStrictEqual([]);
    }
    expect(block.arguments).toStrictEqual({ initial: true });
  });

  test.each(["start", "delta"] as const)(
    "%s rejects missing, mismatched, and unsupported tool blocks",
    (phase) => {
      for (const [wireType, block] of toolCases) {
        const payload = { type: wireType, arguments: { incoming: true } };
        const event = {
          event_type: `${prefix}.${phase}`,
          index: 7,
          [phase === "start" ? prefix : "delta"]: payload,
        };
        expect(mapGoogleEventToStreamParts(event, new Map())).toStrictEqual([]);
        const mismatched: AssistantContentBlock =
          block.type === "toolCall"
            ? { type: "providerToolCall", id: "wrong", name: "nativeWebSearch", arguments: {} }
            : { type: "toolCall", id: "wrong", name: "bash", arguments: {} };
        for (const existing of [mismatched, { type: "text", text: "unrelated" } as const]) {
          expect(mapGoogleEventToStreamParts(event, new Map([[7, existing]]))).toStrictEqual([]);
        }
        expect(
          mapGoogleEventToStreamParts(
            {
              ...event,
              [phase === "start" ? prefix : "delta"]: { ...payload, type: "unknown_tool_call" },
            },
            new Map([[7, block]]),
          ),
        ).toStrictEqual([]);
      }
    },
  );
});

const resultCases: Array<[string, unknown, Array<Record<string, unknown>>]> = [
  ["direct arrays", [{ title: "direct" }, null, "ignored"], [{ title: "direct" }]],
  ["nested results", { results: [{ title: "nested" }, false] }, [{ title: "nested" }]],
  ["null results", null, []],
  ["singleton objects", { title: "singleton" }, []],
];

describe.each(["nativeFileSearch", "nativeGoogleMaps"] as const)(
  "Google %s result projection",
  (name) => {
    test.each(resultCases)(
      "preserves the result envelope for %s",
      (_label, result, expectedResults) => {
        const output = buildNativeGoogleToolResultOutput(
          name,
          "emitted",
          { queries: ["ignored"], urls: ["ignored"] },
          result,
        );
        expect(output).toStrictEqual({
          provider: "google",
          status: "completed",
          callId: "emitted",
          results: expectedResults,
          raw: result,
        });
        expect(output.raw).toBe(result);
      },
    );
  },
);
