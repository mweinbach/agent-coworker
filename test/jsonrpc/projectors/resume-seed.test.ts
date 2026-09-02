import { describe, expect, test } from "bun:test";

import { createJsonRpcNotificationProjector } from "../../../src/server/jsonrpc/notificationProjector";
import { createThreadJournalNotificationProjector } from "../../../src/server/jsonrpc/threadJournalNotificationProjector";
import type { SessionEvent } from "../../../src/server/protocol";
import type { ProjectedItem } from "../../../src/shared/projectedItems";
import { googleRaw, sessionId, streamChunk, turnId } from "./fixtures";

type Notification = { method: string; params?: { item?: ProjectedItem; delta?: string } };

const busy: SessionEvent = {
  type: "session_busy",
  sessionId,
  busy: true,
  turnId,
  cause: "user_message",
};
const finished: SessionEvent = {
  type: "session_busy",
  sessionId,
  busy: false,
  turnId,
  outcome: "completed",
};

function openaiRaw(event: Record<string, unknown>): SessionEvent {
  return {
    type: "model_stream_raw",
    sessionId,
    turnId,
    index: 0,
    provider: "openai",
    model: "gpt-5.4-mini",
    format: "openai-responses-v1",
    normalizerVersion: 1,
    event,
  };
}

const cases: Array<{
  name: string;
  prefix: SessionEvent[];
  continuation: SessionEvent[];
  expected: Partial<ProjectedItem>;
}> = [
  {
    name: "a buffered second assistant occurrence",
    prefix: [
      busy,
      streamChunk("text_delta", { id: "s0", text: "First answer." }),
      streamChunk("text_end", { id: "s0" }),
      streamChunk("text_delta", { id: "s0", text: "Second" }),
    ],
    continuation: [
      streamChunk("text_delta", { id: "s0", text: " answer." }),
      streamChunk("text_end", { id: "s0" }),
    ],
    expected: { id: `agentMessage:${turnId}:2`, type: "agentMessage", text: "Second answer." },
  },
  {
    name: "a buffered reused reasoning stream",
    prefix: [
      busy,
      streamChunk("reasoning_delta", { id: "r0", mode: "reasoning", text: "First thought." }),
      streamChunk("reasoning_end", { id: "r0", mode: "reasoning" }),
      streamChunk("reasoning_delta", { id: "r0", mode: "reasoning", text: "Second" }),
    ],
    continuation: [
      streamChunk("reasoning_delta", { id: "r0", mode: "reasoning", text: " thought." }),
      streamChunk("reasoning_end", { id: "r0", mode: "reasoning" }),
    ],
    expected: { id: `reasoning:${turnId}:r0:2`, type: "reasoning", text: "Second thought." },
  },
  {
    name: "partial arguments for a reused tool call",
    prefix: [
      busy,
      streamChunk("tool_input_start", { id: "call", toolName: "webSearch" }),
      streamChunk("tool_call", {
        toolCallId: "call",
        toolName: "webSearch",
        input: { query: "first" },
      }),
      streamChunk("tool_result", { toolCallId: "call", toolName: "webSearch", output: "first" }),
      streamChunk("tool_input_start", { id: "call", toolName: "webSearch" }),
      streamChunk("tool_input_delta", { id: "call", delta: '{"query":"sec' }),
    ],
    continuation: [
      streamChunk("tool_input_delta", { id: "call", delta: 'ond"}' }),
      streamChunk("tool_input_end", { id: "call", toolName: "webSearch" }),
      streamChunk("tool_result", { toolCallId: "call", toolName: "webSearch", output: "second" }),
    ],
    expected: {
      type: "toolCall",
      state: "output-available",
      args: { query: "second" },
      result: "second",
    },
  },
  {
    name: "the raw OpenAI stream decoder",
    prefix: [
      busy,
      openaiRaw({
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "message-1", type: "message", role: "assistant", content: [] },
      }),
      openaiRaw({
        type: "response.content_part.added",
        item_id: "message-1",
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      }),
      openaiRaw({ type: "response.output_text.delta", item_id: "message-1", delta: "Raw " }),
    ],
    continuation: [
      openaiRaw({ type: "response.output_text.delta", item_id: "message-1", delta: "answer." }),
      openaiRaw({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "message-1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Raw answer.", annotations: [] }],
        },
      }),
    ],
    expected: { type: "agentMessage", text: "Raw answer." },
  },
  {
    name: "the raw Google stream decoder",
    prefix: [
      busy,
      googleRaw(0, { event_type: "content.start", index: 0, content: { type: "text" } }),
      googleRaw(1, {
        event_type: "content.delta",
        index: 0,
        delta: { type: "text", text: "Raw " },
      }),
    ],
    continuation: [
      googleRaw(2, {
        event_type: "content.delta",
        index: 0,
        delta: { type: "text", text: "answer." },
      }),
      googleRaw(3, { event_type: "content.stop", index: 0 }),
    ],
    expected: { type: "agentMessage", text: "Raw answer." },
  },
  {
    name: "a user message accepted before its turn starts",
    prefix: [
      {
        type: "user_message",
        sessionId,
        text: "Start here.",
        clientMessageId: "client-message",
        annotations: [{ type: "file", path: "notes.txt" }],
      },
    ],
    continuation: [busy],
    expected: {
      id: `userMessage:${turnId}:client-message`,
      type: "userMessage",
      clientMessageId: "client-message",
      content: [{ type: "text", text: "Start here." }],
      annotations: [{ type: "file", path: "notes.txt" }],
    },
  },
];

describe("projection resume seeds", () => {
  for (const scenario of cases) {
    test(`preserves ${scenario.name} without sharing mutable state`, () => {
      const canonical: Notification[] = [];
      const resumed: Notification[] = [];
      const journal = createThreadJournalNotificationProjector({
        threadId: sessionId,
        emit: (event) => {
          canonical.push({
            method: event.eventType,
            params: event.payload as Notification["params"],
          });
        },
      });
      let live: ReturnType<typeof createJsonRpcNotificationProjector> | undefined;
      try {
        for (const event of scenario.prefix) journal.handle(event);
        const beforeCapture = canonical.length;
        const seed = journal.captureSeed();
        const savedSeed = structuredClone(seed);
        expect(canonical).toHaveLength(beforeCapture);
        expect(Object.hasOwn(seed, "opts")).toBe(false);

        live = createJsonRpcNotificationProjector({
          threadId: sessionId,
          projectionSeed: seed,
          send: (message) => resumed.push(message as Notification),
        });
        for (const event of scenario.continuation) live.handle(event);
        expect(seed).toEqual(savedSeed);
        expect(journal.captureSeed()).toEqual(savedSeed);

        canonical.length = 0;
        for (const event of scenario.continuation) journal.handle(event);
        const completed = (messages: Notification[]) =>
          messages
            .filter((message) => message.method === "item/completed")
            .map((message) => message.params?.item);
        expect(completed(resumed)).toEqual(completed(canonical));
        expect(completed(resumed).at(-1)).toMatchObject(scenario.expected);
      } finally {
        live?.handle(finished);
        journal.handle(finished);
      }
    });
  }
});
