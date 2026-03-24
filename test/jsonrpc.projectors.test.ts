import { describe, expect, test } from "bun:test";

import { createJsonRpcEventProjector } from "../src/server/jsonrpc/eventProjector";
import { createThreadJournalProjector } from "../src/server/jsonrpc/journalProjector";
import type { ServerEvent } from "../src/server/protocol";

const sessionId = "session-1";
const turnId = "turn-1";
const PI_PROVIDER_CASES = [
  { provider: "anthropic", model: "claude-sonnet-4-6" },
  { provider: "baseten", model: "deepseek-r1-0528" },
  { provider: "together", model: "deepseek-ai/DeepSeek-R1" },
  { provider: "nvidia", model: "meta/llama-4-maverick-17b-128e-instruct" },
  { provider: "lmstudio", model: "local-model" },
  { provider: "opencode-go", model: "glm-5" },
  { provider: "opencode-zen", model: "kimi-k2.5" },
] as const;

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

function piChunk(
  provider: (typeof PI_PROVIDER_CASES)[number]["provider"],
  model: string,
  partType: Extract<ServerEvent, { type: "model_stream_chunk" }>["partType"],
  part: Record<string, unknown>,
): ServerEvent {
  return {
    type: "model_stream_chunk",
    sessionId,
    turnId,
    index: 0,
    provider,
    model,
    partType,
    part,
  };
}

function googleRaw(index: number, event: Record<string, unknown>): ServerEvent {
  return {
    type: "model_stream_raw",
    sessionId,
    turnId,
    index,
    provider: "google",
    model: "gemini-3.1-pro-preview-customtools",
    format: "google-interactions-v1",
    normalizerVersion: 1,
    event,
  };
}

describe("JSON-RPC projectors", () => {
  test("legacy projector emits a visible user item when a steer commits during an active turn", () => {
    const outbound: Array<{ method: string; params?: any }> = [];
    const projector = createJsonRpcEventProjector({
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
    projector.handle({
      type: "user_message",
      sessionId,
      text: "tighten the scope",
      clientMessageId: "steer-1",
    });

    const userStarted = outbound.find((message) =>
      message.method === "item/started" && message.params?.item?.type === "userMessage"
    );
    const userCompleted = outbound.find((message) =>
      message.method === "item/completed" && message.params?.item?.type === "userMessage"
    );

    expect(userStarted?.params?.item).toMatchObject({
      id: `userMessage:${turnId}:steer-1`,
      type: "userMessage",
      clientMessageId: "steer-1",
      content: [{ type: "text", text: "tighten the scope" }],
    });
    expect(userCompleted?.params?.item).toEqual(userStarted?.params?.item);
  });

  test("journal projector emits a visible user item when a steer commits during an active turn", () => {
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
    projector.handle({
      type: "user_message",
      sessionId,
      text: "tighten the scope",
      clientMessageId: "steer-1",
    });

    const userStarted = emissions.find((event) =>
      event.eventType === "item/started" && event.payload?.item?.type === "userMessage"
    );
    const userCompleted = emissions.find((event) =>
      event.eventType === "item/completed" && event.payload?.item?.type === "userMessage"
    );

    expect(userStarted?.payload?.item).toMatchObject({
      id: `userMessage:${turnId}:steer-1`,
      type: "userMessage",
      clientMessageId: "steer-1",
      content: [{ type: "text", text: "tighten the scope" }],
    });
    expect(userCompleted?.payload?.item).toEqual(userStarted?.payload?.item);
  });

  test("legacy projector suppresses commentary deltas and streams reasoning items from live chunks", () => {
    const outbound: Array<{ method: string; params?: any }> = [];
    const projector = createJsonRpcEventProjector({
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

  test("legacy projector splits assistant segments when reasoning resumes within the same turn", () => {
    const outbound: Array<{ method: string; params?: any }> = [];
    const projector = createJsonRpcEventProjector({
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
    projector.handle(streamChunk("text_delta", { id: "s0", text: "First answer." }));
    projector.handle(streamChunk("reasoning_start", { id: "r1", mode: "reasoning" }));
    projector.handle(streamChunk("reasoning_delta", { id: "r1", mode: "reasoning", text: "Need one more step." }));
    projector.handle(streamChunk("reasoning_end", { id: "r1", mode: "reasoning" }));
    projector.handle(streamChunk("text_delta", { id: "s0", text: "\n\nSecond answer." }));
    projector.handle({
      type: "assistant_message",
      sessionId,
      text: "First answer.\n\nSecond answer.",
    });

    const assistantStarted = outbound
      .filter((message) => message.method === "item/started")
      .filter((message) => message.params?.item?.type === "agentMessage");
    const assistantCompleted = outbound
      .filter((message) => message.method === "item/completed")
      .filter((message) => message.params?.item?.type === "agentMessage");
    const reasoningCompleted = outbound
      .filter((message) => message.method === "item/completed")
      .filter((message) => message.params?.item?.type === "reasoning");

    expect(assistantStarted).toHaveLength(2);
    expect(assistantCompleted).toHaveLength(2);
    expect(assistantStarted.map((message) => message.params?.item?.id)).toEqual([
      `agentMessage:${turnId}`,
      `agentMessage:${turnId}:2`,
    ]);
    expect(assistantCompleted.map((message) => String(message.params?.item?.text ?? ""))).toEqual([
      "First answer.",
      "\n\nSecond answer.",
    ]);

    const firstAssistantCompletedIndex = outbound.findIndex((message) => message === assistantCompleted[0]);
    const reasoningCompletedIndex = outbound.findIndex((message) => message === reasoningCompleted[0]);
    const secondAssistantStartedIndex = outbound.findIndex((message) => message === assistantStarted[1]);
    expect(firstAssistantCompletedIndex).toBeLessThan(reasoningCompletedIndex);
    expect(reasoningCompletedIndex).toBeLessThan(secondAssistantStartedIndex);
  });

  test("journal projector splits assistant segments when reasoning resumes within the same turn", () => {
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
    projector.handle(streamChunk("text_delta", { id: "s0", text: "First answer." }));
    projector.handle(streamChunk("reasoning_start", { id: "r1", mode: "reasoning" }));
    projector.handle(streamChunk("reasoning_delta", { id: "r1", mode: "reasoning", text: "Need one more step." }));
    projector.handle(streamChunk("reasoning_end", { id: "r1", mode: "reasoning" }));
    projector.handle(streamChunk("text_delta", { id: "s0", text: "\n\nSecond answer." }));
    projector.handle({
      type: "assistant_message",
      sessionId,
      text: "First answer.\n\nSecond answer.",
    });

    const assistantStarted = emissions
      .filter((event) => event.eventType === "item/started")
      .filter((event) => event.payload?.item?.type === "agentMessage");
    const assistantCompleted = emissions
      .filter((event) => event.eventType === "item/completed")
      .filter((event) => event.payload?.item?.type === "agentMessage");
    const reasoningCompleted = emissions
      .filter((event) => event.eventType === "item/completed")
      .filter((event) => event.payload?.item?.type === "reasoning");

    expect(assistantStarted).toHaveLength(2);
    expect(assistantCompleted).toHaveLength(2);
    expect(assistantStarted.map((event) => event.payload?.item?.id)).toEqual([
      `agentMessage:${turnId}`,
      `agentMessage:${turnId}:2`,
    ]);
    expect(assistantCompleted.map((event) => String(event.payload?.item?.text ?? ""))).toEqual([
      "First answer.",
      "\n\nSecond answer.",
    ]);

    const firstAssistantCompletedIndex = emissions.findIndex((event) => event === assistantCompleted[0]);
    const reasoningCompletedIndex = emissions.findIndex((event) => event === reasoningCompleted[0]);
    const secondAssistantStartedIndex = emissions.findIndex((event) => event === assistantStarted[1]);
    expect(firstAssistantCompletedIndex).toBeLessThan(reasoningCompletedIndex);
    expect(reasoningCompletedIndex).toBeLessThan(secondAssistantStartedIndex);
  });

  test("legacy projector drops a cumulative final assistant message when streamed output only differs by leading boundary whitespace", () => {
    const outbound: Array<{ method: string; params?: any }> = [];
    const projector = createJsonRpcEventProjector({
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
    projector.handle(streamChunk("text_delta", { id: "s0", text: "\n\n" }));
    projector.handle(streamChunk("reasoning_start", { id: "r1", mode: "reasoning" }));
    projector.handle(streamChunk("reasoning_delta", { id: "r1", mode: "reasoning", text: "Checking the benchmarks." }));
    projector.handle(streamChunk("reasoning_end", { id: "r1", mode: "reasoning" }));
    projector.handle(streamChunk("text_delta", { id: "s0", text: "\n\nFinal answer." }));
    projector.handle({
      type: "assistant_message",
      sessionId,
      text: "Final answer.",
    });

    const assistantCompleted = outbound
      .filter((message) => message.method === "item/completed")
      .filter((message) => message.params?.item?.type === "agentMessage");

    expect(assistantCompleted).toHaveLength(1);
    expect(String(assistantCompleted[0]?.params?.item?.text ?? "")).toBe("Final answer.");
  });

  test("journal projector drops a cumulative final assistant message when streamed output only differs by leading boundary whitespace", () => {
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
    projector.handle(streamChunk("text_delta", { id: "s0", text: "\n\n" }));
    projector.handle(streamChunk("reasoning_start", { id: "r1", mode: "reasoning" }));
    projector.handle(streamChunk("reasoning_delta", { id: "r1", mode: "reasoning", text: "Checking the benchmarks." }));
    projector.handle(streamChunk("reasoning_end", { id: "r1", mode: "reasoning" }));
    projector.handle(streamChunk("text_delta", { id: "s0", text: "\n\nFinal answer." }));
    projector.handle({
      type: "assistant_message",
      sessionId,
      text: "Final answer.",
    });

    const assistantCompleted = emissions
      .filter((event) => event.eventType === "item/completed")
      .filter((event) => event.payload?.item?.type === "agentMessage");

    expect(assistantCompleted).toHaveLength(1);
    expect(String(assistantCompleted[0]?.payload?.item?.text ?? "")).toBe("Final answer.");
  });

  test("legacy projector replays raw Gemini search tool items and drops aggregate final reasoning duplicates", () => {
    const outbound: Array<{ method: string; params?: any }> = [];
    const projector = createJsonRpcEventProjector({
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
    projector.handle(googleRaw(0, { event_type: "interaction.start" }));
    projector.handle(googleRaw(1, { event_type: "content.start", index: 0, content: { type: "thought" } }));
    projector.handle(googleRaw(2, {
      event_type: "content.delta",
      index: 0,
      delta: { type: "thought_summary", content: { type: "text", text: "First pass." } },
    }));
    projector.handle(googleRaw(3, { event_type: "content.stop", index: 0 }));
    projector.handle(googleRaw(4, {
      event_type: "content.start",
      index: 1,
      content: { type: "google_search_call", id: "search-call" },
    }));
    projector.handle(googleRaw(5, {
      event_type: "content.delta",
      index: 1,
      delta: { type: "google_search_call", id: "search-call", arguments: { queries: ["Project Hail Mary movie reviews"] } },
    }));
    projector.handle(googleRaw(6, { event_type: "content.stop", index: 1 }));
    projector.handle(googleRaw(7, {
      event_type: "content.start",
      index: 2,
      content: {
        type: "google_search_result",
        call_id: "search-call",
        result: {
          results: [{ title: "MovieWeb" }],
          sources: [{ url: "https://example.com/review" }],
        },
      },
    }));
    projector.handle(googleRaw(8, { event_type: "content.stop", index: 2 }));
    projector.handle(googleRaw(9, { event_type: "content.start", index: 3, content: { type: "thought" } }));
    projector.handle(googleRaw(10, {
      event_type: "content.delta",
      index: 3,
      delta: { type: "thought_summary", content: { type: "text", text: "Second pass." } },
    }));
    projector.handle(googleRaw(11, { event_type: "content.stop", index: 3 }));
    projector.handle({
      type: "reasoning",
      sessionId,
      kind: "reasoning",
      text: "First pass.\n\nSecond pass.",
    });
    projector.handle({
      type: "assistant_message",
      sessionId,
      text: "Final answer.",
    });

    const completedReasoning = outbound
      .filter((message) => message.method === "item/completed")
      .filter((message) => message.params?.item?.type === "reasoning")
      .map((message) => String(message.params?.item?.text ?? ""));
    expect(completedReasoning).toEqual(["First pass.", "Second pass."]);

    const toolStarted = outbound
      .filter((message) => message.method === "item/started")
      .filter((message) => message.params?.item?.type === "toolCall");
    const toolCompleted = outbound
      .filter((message) => message.method === "item/completed")
      .filter((message) => message.params?.item?.type === "toolCall");
    const toolOutputAvailable = toolCompleted.filter(
      (message) => message.params?.item?.state === "output-available",
    );

    expect(toolStarted).toHaveLength(1);
    expect(toolCompleted.map((message) => message.params?.item?.state)).toEqual([
      "input-available",
      "output-available",
    ]);
    expect(toolStarted[0]?.params?.item).toMatchObject({
      type: "toolCall",
      toolName: "nativeWebSearch",
      state: "input-streaming",
    });
    expect(toolOutputAvailable).toHaveLength(1);
    expect(toolOutputAvailable[0]?.params?.item).toMatchObject({
      type: "toolCall",
      toolName: "nativeWebSearch",
      state: "output-available",
      args: { queries: ["Project Hail Mary movie reviews"] },
      result: {
        provider: "google",
        status: "completed",
        queries: ["Project Hail Mary movie reviews"],
        results: [{ title: "MovieWeb" }],
        sources: [{ url: "https://example.com/review" }],
      },
    });
  });

  test("journal projector replays raw Gemini search tool items and drops aggregate final reasoning duplicates", () => {
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
    projector.handle(googleRaw(0, { event_type: "interaction.start" }));
    projector.handle(googleRaw(1, { event_type: "content.start", index: 0, content: { type: "thought" } }));
    projector.handle(googleRaw(2, {
      event_type: "content.delta",
      index: 0,
      delta: { type: "thought_summary", content: { type: "text", text: "First pass." } },
    }));
    projector.handle(googleRaw(3, { event_type: "content.stop", index: 0 }));
    projector.handle(googleRaw(4, {
      event_type: "content.start",
      index: 1,
      content: { type: "google_search_call", id: "search-call" },
    }));
    projector.handle(googleRaw(5, {
      event_type: "content.delta",
      index: 1,
      delta: { type: "google_search_call", id: "search-call", arguments: { queries: ["Project Hail Mary movie reviews"] } },
    }));
    projector.handle(googleRaw(6, { event_type: "content.stop", index: 1 }));
    projector.handle(googleRaw(7, {
      event_type: "content.start",
      index: 2,
      content: {
        type: "google_search_result",
        call_id: "search-call",
        result: {
          results: [{ title: "MovieWeb" }],
          sources: [{ url: "https://example.com/review" }],
        },
      },
    }));
    projector.handle(googleRaw(8, { event_type: "content.stop", index: 2 }));
    projector.handle(googleRaw(9, { event_type: "content.start", index: 3, content: { type: "thought" } }));
    projector.handle(googleRaw(10, {
      event_type: "content.delta",
      index: 3,
      delta: { type: "thought_summary", content: { type: "text", text: "Second pass." } },
    }));
    projector.handle(googleRaw(11, { event_type: "content.stop", index: 3 }));
    projector.handle({
      type: "reasoning",
      sessionId,
      kind: "reasoning",
      text: "First pass.\n\nSecond pass.",
    });
    projector.handle({
      type: "assistant_message",
      sessionId,
      text: "Final answer.",
    });

    const completedReasoning = emissions
      .filter((event) => event.eventType === "item/completed")
      .filter((event) => event.payload?.item?.type === "reasoning")
      .map((event) => String(event.payload?.item?.text ?? ""));
    expect(completedReasoning).toEqual(["First pass.", "Second pass."]);

    const toolStarted = emissions
      .filter((event) => event.eventType === "item/started")
      .filter((event) => event.payload?.item?.type === "toolCall");
    const toolCompleted = emissions
      .filter((event) => event.eventType === "item/completed")
      .filter((event) => event.payload?.item?.type === "toolCall");
    const toolOutputAvailable = toolCompleted.filter(
      (event) => event.payload?.item?.state === "output-available",
    );

    expect(toolStarted).toHaveLength(1);
    expect(toolCompleted.map((event) => event.payload?.item?.state)).toEqual([
      "input-available",
      "output-available",
    ]);
    expect(toolStarted[0]?.payload?.item).toMatchObject({
      type: "toolCall",
      toolName: "nativeWebSearch",
      state: "input-streaming",
    });
    expect(toolOutputAvailable).toHaveLength(1);
    expect(toolOutputAvailable[0]?.payload?.item).toMatchObject({
      type: "toolCall",
      toolName: "nativeWebSearch",
      state: "output-available",
      args: { queries: ["Project Hail Mary movie reviews"] },
      result: {
        provider: "google",
        status: "completed",
        queries: ["Project Hail Mary movie reviews"],
        results: [{ title: "MovieWeb" }],
        sources: [{ url: "https://example.com/review" }],
      },
    });
  });

  for (const { provider, model } of PI_PROVIDER_CASES) {
    test(`projectors keep repeated PI reasoning and tool occurrences distinct for ${provider}`, () => {
      const outbound: Array<{ method: string; params?: any }> = [];
      const emissions: Array<{ eventType: string; payload: any }> = [];
      const legacy = createJsonRpcEventProjector({
        threadId: sessionId,
        send: (message) => outbound.push(message as { method: string; params?: any }),
      });
      const journal = createThreadJournalProjector({
        threadId: sessionId,
        emit: (event) => emissions.push({ eventType: event.eventType, payload: event.payload }),
      });
      const both = [legacy, journal] as const;

      for (const projector of both) {
        projector.handle({
          type: "session_busy",
          sessionId,
          busy: true,
          turnId,
          cause: "user_message",
        });
        projector.handle(piChunk(provider, model, "reasoning_start", { id: "s0", mode: "reasoning" }));
        projector.handle(piChunk(provider, model, "reasoning_delta", { id: "s0", mode: "reasoning", text: "First step." }));
        projector.handle(piChunk(provider, model, "reasoning_end", { id: "s0", mode: "reasoning" }));
        projector.handle(piChunk(provider, model, "tool_input_start", { id: "tool_call_0", toolName: "webSearch" }));
        projector.handle(piChunk(provider, model, "tool_input_delta", { id: "tool_call_0", delta: "{\"query\":\"first\"}" }));
        projector.handle(piChunk(provider, model, "tool_input_end", { id: "tool_call_0", toolName: "webSearch" }));
        projector.handle(piChunk(provider, model, "tool_call", {
          toolCallId: "tool_call_0",
          toolName: "webSearch",
          input: { query: "first" },
        }));
        projector.handle(piChunk(provider, model, "tool_result", {
          toolCallId: "tool_call_0",
          toolName: "webSearch",
          output: { result: "first" },
        }));
        projector.handle(piChunk(provider, model, "reasoning_start", { id: "s0", mode: "reasoning" }));
        projector.handle(piChunk(provider, model, "reasoning_delta", { id: "s0", mode: "reasoning", text: "Second step." }));
        projector.handle(piChunk(provider, model, "reasoning_end", { id: "s0", mode: "reasoning" }));
        projector.handle(piChunk(provider, model, "tool_input_start", { id: "tool_call_0", toolName: "webSearch" }));
        projector.handle(piChunk(provider, model, "tool_input_delta", { id: "tool_call_0", delta: "{\"query\":\"second\"}" }));
        projector.handle(piChunk(provider, model, "tool_input_end", { id: "tool_call_0", toolName: "webSearch" }));
        projector.handle(piChunk(provider, model, "tool_call", {
          toolCallId: "tool_call_0",
          toolName: "webSearch",
          input: { query: "second" },
        }));
        projector.handle(piChunk(provider, model, "tool_result", {
          toolCallId: "tool_call_0",
          toolName: "webSearch",
          output: { result: "second" },
        }));
        projector.handle({
          type: "reasoning",
          sessionId,
          kind: "reasoning",
          text: "First step.\n\nSecond step.",
        });
        projector.handle({
          type: "assistant_message",
          sessionId,
          text: "Final answer.",
        });
      }

      const legacyCompletedReasoning = outbound
        .filter((message) => message.method === "item/completed")
        .filter((message) => message.params?.item?.type === "reasoning");
      expect(legacyCompletedReasoning.map((message) => message.params?.item?.text)).toEqual([
        "First step.",
        "Second step.",
      ]);
      expect(new Set(legacyCompletedReasoning.map((message) => message.params?.item?.id)).size).toBe(2);

      const legacyCompletedTools = outbound
        .filter((message) => message.method === "item/completed")
        .filter((message) => message.params?.item?.type === "toolCall");
      const legacyFinalTools = legacyCompletedTools.filter(
        (message) => message.params?.item?.state === "output-available",
      );
      expect(legacyFinalTools.map((message) => message.params?.item?.args)).toEqual([
        { query: "first" },
        { query: "second" },
      ]);
      expect(new Set(legacyFinalTools.map((message) => message.params?.item?.id)).size).toBe(2);

      const journalCompletedReasoning = emissions
        .filter((event) => event.eventType === "item/completed")
        .filter((event) => event.payload?.item?.type === "reasoning");
      expect(journalCompletedReasoning.map((event) => event.payload?.item?.text)).toEqual([
        "First step.",
        "Second step.",
      ]);
      expect(new Set(journalCompletedReasoning.map((event) => event.payload?.item?.id)).size).toBe(2);

      const journalCompletedTools = emissions
        .filter((event) => event.eventType === "item/completed")
        .filter((event) => event.payload?.item?.type === "toolCall");
      const journalFinalTools = journalCompletedTools.filter(
        (event) => event.payload?.item?.state === "output-available",
      );
      expect(journalFinalTools.map((event) => event.payload?.item?.args)).toEqual([
        { query: "first" },
        { query: "second" },
      ]);
      expect(new Set(journalFinalTools.map((event) => event.payload?.item?.id)).size).toBe(2);
    });
  }
});
