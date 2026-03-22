import { describe, expect, test } from "bun:test";

import { createJsonRpcLegacyEventProjector } from "../src/server/jsonrpc/legacyEventProjector";
import { createThreadJournalProjector } from "../src/server/jsonrpc/journalProjector";
import type { ServerEvent } from "../src/server/protocol";

const sessionId = "session-1";
const turnId = "turn-1";

function streamChunk(partType: Extract<ServerEvent, { type: "model_stream_chunk" }>["partType"], part: Record<string, unknown>): ServerEvent {
  return {
    type: "model_stream_chunk",
    sessionId,
    turnId,
    index: 0,
    provider: "openai",
    model: "gpt-5.4-mini",
    partType,
    part,
  };
}

describe("JSON-RPC projectors", () => {
  test("legacy projector suppresses commentary deltas and streams reasoning items from live chunks", () => {
    const outbound: Array<{ method: string; params?: any }> = [];
    const projector = createJsonRpcLegacyEventProjector({
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
    projector.handle(streamChunk("text_delta", { id: "text-1", phase: "commentary", text: "Internal commentary" }));
    projector.handle(streamChunk("reasoning_start", { id: "reasoning-1", mode: "summary" }));
    projector.handle(streamChunk("reasoning_delta", { id: "reasoning-1", mode: "summary", text: "Inspecting the reports." }));
    projector.handle(streamChunk("reasoning_end", { id: "reasoning-1", mode: "summary" }));
    projector.handle({
      type: "reasoning",
      sessionId,
      kind: "summary",
      text: "Inspecting the reports.",
    });
    projector.handle({
      type: "assistant_message",
      sessionId,
      text: "Here is the result.",
    });

    const assistantDeltas = outbound
      .filter((message) => message.method === "item/agentMessage/delta")
      .map((message) => String(message.params?.delta ?? ""));
    expect(assistantDeltas).toEqual(["Here is the result."]);

    const reasoningStarted = outbound
      .filter((message) => message.method === "item/started")
      .filter((message) => message.params?.item?.type === "reasoning");
    const reasoningDeltas = outbound.filter((message) => message.method === "item/reasoning/delta");
    const reasoningCompleted = outbound
      .filter((message) => message.method === "item/completed")
      .filter((message) => message.params?.item?.type === "reasoning");

    expect(reasoningStarted).toHaveLength(1);
    expect(reasoningDeltas).toHaveLength(1);
    expect(reasoningCompleted).toHaveLength(1);

    expect(reasoningStarted[0]?.params?.item).toMatchObject({
      type: "reasoning",
      mode: "summary",
      text: "",
    });
    expect(reasoningDeltas[0]?.params).toMatchObject({
      threadId: sessionId,
      turnId,
      mode: "summary",
      delta: "Inspecting the reports.",
    });
    expect(reasoningDeltas[0]?.params?.itemId).toBe(reasoningStarted[0]?.params?.item?.id);
    expect(reasoningCompleted[0]?.params?.item).toMatchObject({
      id: reasoningStarted[0]?.params?.item?.id,
      type: "reasoning",
      mode: "summary",
      text: "Inspecting the reports.",
    });

    const reasoningStartedIndex = outbound.findIndex((message) => message === reasoningStarted[0]);
    const reasoningDeltaIndex = outbound.findIndex((message) => message === reasoningDeltas[0]);
    const reasoningCompletedIndex = outbound.findIndex((message) => message === reasoningCompleted[0]);
    const assistantDeltaIndex = outbound.findIndex((message) =>
      message.method === "item/agentMessage/delta" && message.params?.delta === "Here is the result.",
    );
    expect(reasoningStartedIndex).toBeLessThan(reasoningDeltaIndex);
    expect(reasoningDeltaIndex).toBeLessThan(reasoningCompletedIndex);
    expect(reasoningCompletedIndex).toBeLessThan(assistantDeltaIndex);
  });

  test("journal projector suppresses commentary deltas and records streamed reasoning events from live chunks", () => {
    const emissions: Array<{ eventType: string; payload: any }> = [];
    const projector = createThreadJournalProjector({
      threadId: sessionId,
      emit: (event) => emissions.push({ eventType: event.eventType, payload: event.payload }),
    });

    projector.handle({
      type: "session_busy",
      sessionId,
      busy: true,
      turnId,
      cause: "user_message",
    });
    projector.handle(streamChunk("text_delta", { id: "text-1", phase: "commentary", text: "Internal commentary" }));
    projector.handle(streamChunk("reasoning_start", { id: "reasoning-1", mode: "summary" }));
    projector.handle(streamChunk("reasoning_delta", { id: "reasoning-1", mode: "summary", text: "Inspecting the reports." }));
    projector.handle(streamChunk("reasoning_end", { id: "reasoning-1", mode: "summary" }));
    projector.handle({
      type: "reasoning",
      sessionId,
      kind: "summary",
      text: "Inspecting the reports.",
    });
    projector.handle({
      type: "assistant_message",
      sessionId,
      text: "Here is the result.",
    });

    const assistantDeltas = emissions
      .filter((event) => event.eventType === "item/agentMessage/delta")
      .map((event) => String(event.payload?.delta ?? ""));
    expect(assistantDeltas).toEqual(["Here is the result."]);

    const reasoningStarted = emissions
      .filter((event) => event.eventType === "item/started")
      .filter((event) => event.payload?.item?.type === "reasoning");
    const reasoningDeltas = emissions.filter((event) => event.eventType === "item/reasoning/delta");
    const reasoningCompleted = emissions
      .filter((event) => event.eventType === "item/completed")
      .filter((event) => event.payload?.item?.type === "reasoning");

    expect(reasoningStarted).toHaveLength(1);
    expect(reasoningDeltas).toHaveLength(1);
    expect(reasoningCompleted).toHaveLength(1);

    expect(reasoningStarted[0]?.payload?.item).toMatchObject({
      type: "reasoning",
      mode: "summary",
      text: "",
    });
    expect(reasoningDeltas[0]?.payload).toMatchObject({
      threadId: sessionId,
      turnId,
      mode: "summary",
      delta: "Inspecting the reports.",
    });
    expect(reasoningDeltas[0]?.payload?.itemId).toBe(reasoningStarted[0]?.payload?.item?.id);
    expect(reasoningCompleted[0]?.payload?.item).toMatchObject({
      id: reasoningStarted[0]?.payload?.item?.id,
      type: "reasoning",
      mode: "summary",
      text: "Inspecting the reports.",
    });
  });
});
