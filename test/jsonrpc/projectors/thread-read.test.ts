import { describe, expect, test } from "bun:test";

import { createThreadJournalNotificationProjector } from "../../../src/server/jsonrpc/threadJournalNotificationProjector";
import { createThreadTurnProjector } from "../../../src/server/jsonrpc/threadReadProjector";
import { sessionId, streamChunk, turnId } from "./fixtures";

describe("JSON-RPC projectors", () => {
  test.each([
    ["longer", "I checked the result.", "I checked the result. It failed; do not deploy."],
    ["shorter", "I checked the result. It failed; do not deploy.", "I checked the result."],
    ["reformatted", "Hello world", "Hello\nworld, with an important update."],
    ["same-text", "I checked the result.", "I checked the result."],
    ["whitespace-equivalent", "Hello world", "Hello\nworld"],
  ])(
    "preserves a %s assistant segment that shares an earlier segment's prefix",
    (_, first, next) => {
      const replay = createThreadTurnProjector();
      let seq = 0;
      const journal = createThreadJournalNotificationProjector({
        threadId: sessionId,
        emit: (event) => replay.handle({ ...event, seq: ++seq }),
      });
      journal.handle({
        type: "session_busy",
        sessionId,
        turnId,
        busy: true,
        cause: "user_message",
      });
      journal.handle(streamChunk("text_delta", { id: "first", text: first }));
      journal.handle(streamChunk("text_end", { id: "first" }));
      journal.handle(
        streamChunk("tool_call", {
          toolCallId: "check",
          toolName: "read",
          input: { path: "result" },
        }),
      );
      journal.handle(
        streamChunk("tool_result", { toolCallId: "check", toolName: "read", output: "failed" }),
      );
      journal.handle(streamChunk("text_delta", { id: "second", text: next }));
      journal.handle(streamChunk("text_end", { id: "second" }));
      journal.handle({
        type: "session_busy",
        sessionId,
        turnId,
        busy: false,
        outcome: "completed",
      });

      const assistantItems = replay
        .build()[0]
        ?.items.filter((item) => item.type === "agentMessage");
      expect(assistantItems?.map((item) => ({ id: item.id, text: item.text }))).toEqual([
        { id: `agentMessage:${turnId}`, text: first },
        { id: `agentMessage:${turnId}:2`, text: next },
      ]);
    },
  );

  test("threadReadProjector deduplicates near-duplicate assistant items from journal replay", () => {
    // Simulate the journal entries that would be persisted when the streaming
    // + assistant_message duplicate was created before the server-side fix.
    const projector = createThreadTurnProjector();

    // Turn starts
    projector.handle({
      seq: 1,
      threadId: sessionId,
      ts: "2026-01-01T00:00:00Z",
      eventType: "turn/started",
      turnId,
      itemId: null,
      requestId: null,
      payload: { threadId: sessionId, turn: { id: turnId, status: "inProgress" } },
    });
    // First streaming segment
    projector.handle({
      seq: 2,
      threadId: sessionId,
      ts: "2026-01-01T00:00:01Z",
      eventType: "item/started",
      turnId,
      itemId: `agentMessage:${turnId}`,
      requestId: null,
      payload: {
        threadId: sessionId,
        turnId,
        item: { id: `agentMessage:${turnId}`, type: "agentMessage", text: "" },
      },
    });
    projector.handle({
      seq: 3,
      threadId: sessionId,
      ts: "2026-01-01T00:00:02Z",
      eventType: "item/completed",
      turnId,
      itemId: `agentMessage:${turnId}`,
      requestId: null,
      payload: {
        threadId: sessionId,
        turnId,
        item: { id: `agentMessage:${turnId}`, type: "agentMessage", text: "Hello world" },
      },
    });
    // Reasoning
    projector.handle({
      seq: 4,
      threadId: sessionId,
      ts: "2026-01-01T00:00:03Z",
      eventType: "item/started",
      turnId,
      itemId: `reasoning:${turnId}:r1`,
      requestId: null,
      payload: {
        threadId: sessionId,
        turnId,
        item: { id: `reasoning:${turnId}:r1`, type: "reasoning", mode: "reasoning", text: "" },
      },
    });
    projector.handle({
      seq: 5,
      threadId: sessionId,
      ts: "2026-01-01T00:00:04Z",
      eventType: "item/completed",
      turnId,
      itemId: `reasoning:${turnId}:r1`,
      requestId: null,
      payload: {
        threadId: sessionId,
        turnId,
        item: {
          id: `reasoning:${turnId}:r1`,
          type: "reasoning",
          mode: "reasoning",
          text: "Thinking.",
        },
      },
    });
    // Second streaming segment
    projector.handle({
      seq: 6,
      threadId: sessionId,
      ts: "2026-01-01T00:00:05Z",
      eventType: "item/started",
      turnId,
      itemId: `agentMessage:${turnId}`,
      requestId: null,
      payload: {
        threadId: sessionId,
        turnId,
        item: { id: `agentMessage:${turnId}`, type: "agentMessage", text: "" },
      },
    });
    projector.handle({
      seq: 7,
      threadId: sessionId,
      ts: "2026-01-01T00:00:06Z",
      eventType: "item/completed",
      turnId,
      itemId: `agentMessage:${turnId}`,
      requestId: null,
      payload: {
        threadId: sessionId,
        turnId,
        item: { id: `agentMessage:${turnId}`, type: "agentMessage", text: "More text" },
      },
    });
    // The duplicate: assistant_message fallback created a third occurrence
    // with the full concatenated text including paragraph breaks.
    projector.handle({
      seq: 8,
      threadId: sessionId,
      ts: "2026-01-01T00:00:07Z",
      eventType: "item/started",
      turnId,
      itemId: `agentMessage:${turnId}`,
      requestId: null,
      payload: {
        threadId: sessionId,
        turnId,
        item: { id: `agentMessage:${turnId}`, type: "agentMessage", text: "" },
      },
    });
    projector.handle({
      seq: 9,
      threadId: sessionId,
      ts: "2026-01-01T00:00:08Z",
      eventType: "item/completed",
      turnId,
      itemId: `agentMessage:${turnId}`,
      requestId: null,
      payload: {
        threadId: sessionId,
        turnId,
        item: {
          id: `agentMessage:${turnId}`,
          type: "agentMessage",
          text: "Hello world\n\nMore text",
        },
      },
    });
    // Turn completes
    projector.handle({
      seq: 10,
      threadId: sessionId,
      ts: "2026-01-01T00:00:09Z",
      eventType: "turn/completed",
      turnId,
      itemId: null,
      requestId: null,
      payload: { threadId: sessionId, turn: { id: turnId, status: "completed" } },
    });

    const turns = projector.build();
    expect(turns).toHaveLength(1);
    const items = turns[0]!.items;

    const agentMessages = items.filter((item) => item.type === "agentMessage");
    // Must have 2 segments, NOT 3 (the duplicate should be filtered).
    expect(agentMessages).toHaveLength(2);
    expect(agentMessages.map((item) => item.text)).toEqual(["Hello world", "More text"]);
  });
});
