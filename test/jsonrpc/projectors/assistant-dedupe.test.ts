import { describe, expect, test } from "bun:test";

import { createJsonRpcNotificationProjector } from "../../../src/server/jsonrpc/notificationProjector";
import { sessionId, streamChunk, turnId } from "./fixtures";

describe("JSON-RPC projectors", () => {
  test("notification projector deduplicates assistant_message when streaming segments lack paragraph separators in concatenated history", () => {
    const outbound: Array<{ method: string; params?: any }> = [];
    const projector = createJsonRpcNotificationProjector({
      threadId: sessionId,
      send: (message) => outbound.push(message as { method: string; params?: any }),
    });

    projector.handle({
      type: "session_busy",
      sessionId,
      busy: true,
      turnId,
      cause: "user_message",
    });
    // Stream first text segment
    projector.handle(streamChunk("text_delta", { id: "s0", text: "Hello world" }));
    // Reasoning interrupts — flushes the first segment
    projector.handle(streamChunk("reasoning_start", { id: "r1", mode: "reasoning" }));
    projector.handle(
      streamChunk("reasoning_delta", { id: "r1", mode: "reasoning", text: "Let me think." }),
    );
    projector.handle(streamChunk("reasoning_end", { id: "r1", mode: "reasoning" }));
    // Stream second text segment (without leading \n\n — provider-dependent)
    projector.handle(streamChunk("text_delta", { id: "s0", text: "More text" }));
    // Final events from the runtime adapter — the assistant_message text includes
    // paragraph separators that were not present in the raw streaming deltas.
    projector.handle({
      type: "reasoning",
      sessionId,
      kind: "reasoning",
      text: "Let me think.",
    });
    projector.handle({
      type: "assistant_message",
      sessionId,
      text: "Hello world\n\nMore text",
    });

    const assistantCompleted = outbound
      .filter((message) => message.method === "item/completed")
      .filter((message) => message.params?.item?.type === "agentMessage");

    // Must have exactly 2 assistant items (one per segment), NOT a third
    // duplicate from the assistant_message fallback.
    expect(assistantCompleted).toHaveLength(2);
    expect(assistantCompleted.map((message) => String(message.params?.item?.text ?? ""))).toEqual([
      "Hello world",
      "More text",
    ]);
  });

  test("notification projector deduplicates assistant_message when final text equals history after normalization", () => {
    const outbound: Array<{ method: string; params?: any }> = [];
    const projector = createJsonRpcNotificationProjector({
      threadId: sessionId,
      send: (message) => outbound.push(message as { method: string; params?: any }),
    });

    projector.handle({
      type: "session_busy",
      sessionId,
      busy: true,
      turnId,
      cause: "user_message",
    });
    // Stream text with trailing whitespace
    projector.handle(streamChunk("text_delta", { id: "s0", text: "The answer.\n\n" }));
    // Reasoning flushes the segment (history = "The answer.\n\n")
    projector.handle(streamChunk("reasoning_start", { id: "r1", mode: "reasoning" }));
    projector.handle(
      streamChunk("reasoning_delta", { id: "r1", mode: "reasoning", text: "Done." }),
    );
    projector.handle(streamChunk("reasoning_end", { id: "r1", mode: "reasoning" }));
    // Final assistant_message has the text without trailing whitespace
    projector.handle({
      type: "assistant_message",
      sessionId,
      text: "The answer.",
    });

    const assistantCompleted = outbound
      .filter((message) => message.method === "item/completed")
      .filter((message) => message.params?.item?.type === "agentMessage");

    expect(assistantCompleted).toHaveLength(1);
    expect(String(assistantCompleted[0]?.params?.item?.text ?? "")).toBe("The answer.\n\n");
  });
});
