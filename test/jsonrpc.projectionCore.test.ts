import { describe, expect, test } from "bun:test";

import { createProjectionCore } from "../src/server/jsonrpc/projectionCore";
import type { ProjectedEvent } from "../src/server/jsonrpc/projectionCore.types";
import type { ServerEvent } from "../src/server/protocol";

const sessionId = "session-1";
const turnId = "turn-1";

function streamChunk(
  partType: Extract<ServerEvent, { type: "model_stream_chunk" }>["partType"],
  part: Record<string, unknown>,
  overrides?: Partial<Extract<ServerEvent, { type: "model_stream_chunk" }>>,
): ServerEvent {
  return {
    type: "model_stream_chunk",
    sessionId,
    turnId,
    index: 0,
    provider: "openai",
    model: "gpt-5.4-mini",
    partType,
    part,
    ...overrides,
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

function openAiRaw(index: number, event: Record<string, unknown>): ServerEvent {
  return {
    type: "model_stream_raw",
    sessionId,
    turnId,
    index,
    provider: "openai",
    model: "gpt-5.4-mini",
    format: "openai-responses-v1",
    normalizerVersion: 1,
    event,
  };
}

function createCore(
  opts?: {
    threadId?: string;
    initialActiveTurnId?: string | null;
    initialAgentText?: string | null;
  },
) {
  const events: ProjectedEvent[] = [];
  const core = createProjectionCore({
    threadId: opts?.threadId ?? sessionId,
    initialActiveTurnId: opts?.initialActiveTurnId,
    initialAgentText: opts?.initialAgentText,
    sink: {
      emit: (event) => events.push(event),
    },
  });
  return { core, events };
}

function projectedOfType<TType extends ProjectedEvent["type"]>(
  events: ProjectedEvent[],
  type: TType,
): Array<Extract<ProjectedEvent, { type: TType }>> {
  return events.filter((event): event is Extract<ProjectedEvent, { type: TType }> => event.type === type);
}

describe("projectionCore", () => {
  test("completes assistant output before reasoning and tools", () => {
    const { core, events } = createCore();

    core.handle({
      type: "session_busy",
      sessionId,
      busy: true,
      turnId,
      cause: "user_message",
    });
    core.handle(streamChunk("text_delta", { id: "text-1", text: "First answer." }));
    core.handle(streamChunk("reasoning_start", { id: "reasoning-1", mode: "summary" }));
    core.handle(streamChunk("reasoning_delta", { id: "reasoning-1", mode: "summary", text: "Checking details." }));
    core.handle(streamChunk("reasoning_end", { id: "reasoning-1", mode: "summary" }));
    core.handle(streamChunk("tool_call", { toolCallId: "tool-1", toolName: "read", input: { path: "/tmp/test.txt" } }));
    core.handle(streamChunk("tool_result", { toolCallId: "tool-1", toolName: "read", output: { ok: true } }));

    const assistantCompleted = projectedOfType(events, "item/completed")
      .find((event) => event.item.type === "agentMessage");
    const reasoningStarted = projectedOfType(events, "item/started")
      .find((event) => event.item.type === "reasoning");
    const toolStarted = projectedOfType(events, "item/started")
      .find((event) => event.item.type === "toolCall");

    expect(assistantCompleted?.item).toMatchObject({
      type: "agentMessage",
      text: "First answer.",
    });
    expect(reasoningStarted?.item).toMatchObject({
      type: "reasoning",
      mode: "summary",
      text: "",
    });
    expect(toolStarted?.item).toMatchObject({
      type: "toolCall",
      toolName: "read",
      state: "input-streaming",
    });

    expect(events.findIndex((event) => event === assistantCompleted))
      .toBeLessThan(events.findIndex((event) => event === reasoningStarted));
    expect(events.findIndex((event) => event === reasoningStarted))
      .toBeLessThan(events.findIndex((event) => event === toolStarted));
  });

  test("drops commentary assistant deltas", () => {
    const { core, events } = createCore();

    core.handle({
      type: "session_busy",
      sessionId,
      busy: true,
      turnId,
      cause: "user_message",
    });
    core.handle(streamChunk("text_delta", { id: "text-1", phase: "commentary", text: "Internal note" }));

    expect(projectedOfType(events, "item/agentMessage/delta")).toHaveLength(0);
    expect(projectedOfType(events, "item/started").filter((event) => event.item.type === "agentMessage")).toHaveLength(0);
  });

  test("dedupes duplicate final reasoning when it matches streamed reasoning", () => {
    const { core, events } = createCore();

    core.handle({
      type: "session_busy",
      sessionId,
      busy: true,
      turnId,
      cause: "user_message",
    });
    core.handle(streamChunk("reasoning_start", { id: "reasoning-1", mode: "summary" }));
    core.handle(streamChunk("reasoning_delta", { id: "reasoning-1", mode: "summary", text: "Inspecting the reports." }));
    core.handle(streamChunk("reasoning_end", { id: "reasoning-1", mode: "summary" }));
    core.handle({
      type: "reasoning",
      sessionId,
      kind: "summary",
      text: "Inspecting the reports.",
    });

    const completedReasoning = projectedOfType(events, "item/completed")
      .filter((event) => event.item.type === "reasoning");
    expect(completedReasoning).toHaveLength(1);
    expect(completedReasoning[0]?.item).toMatchObject({
      type: "reasoning",
      text: "Inspecting the reports.",
    });
  });

  test("tracks repeated tool occurrences for the same key", () => {
    const { core, events } = createCore();

    core.handle({
      type: "session_busy",
      sessionId,
      busy: true,
      turnId,
      cause: "user_message",
    });
    core.handle(streamChunk("tool_call", { toolCallId: "tool-1", toolName: "read", input: { path: "/tmp/a.txt" } }));
    core.handle(streamChunk("tool_result", { toolCallId: "tool-1", toolName: "read", output: { ok: true } }));
    core.handle(streamChunk("tool_call", { toolCallId: "tool-1", toolName: "read", input: { path: "/tmp/b.txt" } }, { index: 1 }));
    core.handle(streamChunk("tool_result", { toolCallId: "tool-1", toolName: "read", output: { ok: true, second: true } }, { index: 1 }));

    const completedToolItems = projectedOfType(events, "item/completed")
      .filter((event) => event.item.type === "toolCall")
      .map((event) => event.item.id);

    expect(completedToolItems).toEqual([
      `toolCall:${turnId}:tool-1`,
      `toolCall:${turnId}:tool-1:2`,
    ]);
  });

  test("splits assistant segments when reasoning interleaves", () => {
    const { core, events } = createCore();

    core.handle({
      type: "session_busy",
      sessionId,
      busy: true,
      turnId,
      cause: "user_message",
    });
    core.handle(streamChunk("text_delta", { id: "s0", text: "First answer." }));
    core.handle(streamChunk("reasoning_start", { id: "r1", mode: "reasoning" }));
    core.handle(streamChunk("reasoning_delta", { id: "r1", mode: "reasoning", text: "Need one more step." }));
    core.handle(streamChunk("reasoning_end", { id: "r1", mode: "reasoning" }));
    core.handle(streamChunk("text_delta", { id: "s0", text: "\n\nSecond answer." }));
    core.handle({
      type: "assistant_message",
      sessionId,
      text: "First answer.\n\nSecond answer.",
    });

    const assistantStarted = projectedOfType(events, "item/started")
      .filter((event) => event.item.type === "agentMessage");
    const assistantCompleted = projectedOfType(events, "item/completed")
      .filter((event) => event.item.type === "agentMessage");

    expect(assistantStarted.map((event) => event.item.id)).toEqual([
      `agentMessage:${turnId}`,
      `agentMessage:${turnId}:2`,
    ]);
    expect(assistantCompleted.map((event) => event.item.text)).toEqual([
      "First answer.",
      "\n\nSecond answer.",
    ]);
  });

  test("uses assistant history to emit only the final remainder", () => {
    const { core, events } = createCore();

    core.handle({
      type: "session_busy",
      sessionId,
      busy: true,
      turnId,
      cause: "user_message",
    });
    core.handle(streamChunk("text_delta", { id: "s0", text: "First answer." }));
    core.handle(streamChunk("text_end", { id: "s0" }));
    core.handle({
      type: "assistant_message",
      sessionId,
      text: "First answer.\n\nSecond answer.",
    });

    const assistantDeltas = projectedOfType(events, "item/agentMessage/delta")
      .map((event) => event.delta);
    const assistantCompleted = projectedOfType(events, "item/completed")
      .filter((event) => event.item.type === "agentMessage")
      .map((event) => event.item.text);

    expect(assistantDeltas).toEqual([
      "First answer.",
      "\n\nSecond answer.",
    ]);
    expect(assistantCompleted).toEqual([
      "First answer.",
      "\n\nSecond answer.",
    ]);
  });

  test("replays raw google interactions reasoning and tool activity", () => {
    const { core, events } = createCore();

    core.handle({
      type: "session_busy",
      sessionId,
      busy: true,
      turnId,
      cause: "user_message",
    });
    core.handle(googleRaw(0, { event_type: "interaction.start" }));
    core.handle(googleRaw(1, { event_type: "content.start", index: 0, content: { type: "thought" } }));
    core.handle(googleRaw(2, {
      event_type: "content.delta",
      index: 0,
      delta: { type: "thought_summary", content: { type: "text", text: "First pass." } },
    }));
    core.handle(googleRaw(3, { event_type: "content.stop", index: 0 }));
    core.handle(googleRaw(4, {
      event_type: "content.start",
      index: 1,
      content: { type: "google_search_call", id: "search-call" },
    }));
    core.handle(googleRaw(5, {
      event_type: "content.delta",
      index: 1,
      delta: { type: "google_search_call", id: "search-call", arguments: { queries: ["Project Hail Mary movie reviews"] } },
    }));
    core.handle(googleRaw(6, { event_type: "content.stop", index: 1 }));
    core.handle(googleRaw(7, {
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
    core.handle(googleRaw(8, { event_type: "content.stop", index: 2 }));
    core.handle({
      type: "reasoning",
      sessionId,
      kind: "reasoning",
      text: "First pass.",
    });

    const completedReasoning = projectedOfType(events, "item/completed")
      .filter((event) => event.item.type === "reasoning")
      .map((event) => event.item.text);
    const completedTool = projectedOfType(events, "item/completed")
      .find((event) => event.item.type === "toolCall");

    expect(completedReasoning).toEqual(["First pass."]);
    expect(completedTool?.item).toMatchObject({
      type: "toolCall",
      toolName: "nativeWebSearch",
      state: "output-available",
      args: { queries: ["Project Hail Mary movie reviews"] },
    });
  });

  test("replays raw openai responses and ignores duplicate normalized chunks for raw-backed turns", () => {
    const { core, events } = createCore();

    core.handle({
      type: "session_busy",
      sessionId,
      busy: true,
      turnId,
      cause: "user_message",
    });
    core.handle(openAiRaw(0, {
      type: "response.output_item.added",
      item: { type: "reasoning", id: "rs_1", summary: [] },
    }));
    core.handle(openAiRaw(1, {
      type: "response.reasoning_summary_part.added",
      part: { type: "summary_text", text: "" },
    }));
    core.handle(openAiRaw(2, {
      type: "response.reasoning_summary_text.delta",
      delta: "Raw plan.",
    }));
    core.handle(openAiRaw(3, {
      type: "response.output_item.done",
      item: { type: "reasoning", id: "rs_1", summary: [{ text: "Raw plan." }] },
    }));
    core.handle(openAiRaw(4, {
      type: "response.output_item.added",
      item: { type: "message", id: "msg_1", content: [] },
    }));
    core.handle(openAiRaw(5, {
      type: "response.content_part.added",
      part: { type: "output_text", text: "" },
    }));
    core.handle(openAiRaw(6, {
      type: "response.output_text.delta",
      delta: "Raw answer.",
    }));
    core.handle(openAiRaw(7, {
      type: "response.output_item.done",
      item: { type: "message", id: "msg_1", content: [{ type: "output_text", text: "Raw answer." }] },
    }));
    core.handle(streamChunk("reasoning_delta", { id: "reasoning-duplicate", mode: "summary", text: "Ignored normalized reasoning." }, { index: 1 }));
    core.handle(streamChunk("text_delta", { id: "text-duplicate", text: "Ignored normalized text." }, { index: 2 }));

    const reasoningDeltas = projectedOfType(events, "item/reasoning/delta")
      .map((event) => event.delta);
    const assistantDeltas = projectedOfType(events, "item/agentMessage/delta")
      .map((event) => event.delta);

    expect(reasoningDeltas).toEqual(["Raw plan."]);
    expect(assistantDeltas).toEqual(["Raw answer."]);
  });

  test("clears per-turn reasoning dedupe on session_busy completion", () => {
    const { core, events } = createCore();
    const turnTwo = "turn-2";

    core.handle({
      type: "session_busy",
      sessionId,
      busy: true,
      turnId,
      cause: "user_message",
    });
    core.handle({
      type: "reasoning",
      sessionId,
      kind: "summary",
      text: "Repeated thought.",
    });
    core.handle({
      type: "session_busy",
      sessionId,
      busy: false,
      turnId,
      outcome: "completed",
    });
    core.handle({
      type: "session_busy",
      sessionId,
      busy: true,
      turnId: turnTwo,
      cause: "user_message",
    });
    core.handle({
      type: "reasoning",
      sessionId,
      kind: "summary",
      text: "Repeated thought.",
    });

    const reasoningCompleted = projectedOfType(events, "item/completed")
      .filter((event) => event.item.type === "reasoning");
    const turnCompleted = projectedOfType(events, "turn/completed");

    expect(reasoningCompleted).toHaveLength(2);
    expect(turnCompleted).toEqual([{
      type: "turn/completed",
      turnId,
      turn: {
        id: turnId,
        status: "completed",
      },
    }]);
  });

  test("supports reconnect bootstrap for finish-only assistant completions", () => {
    const { core, events } = createCore({
      initialActiveTurnId: turnId,
      initialAgentText: "Hello",
    });

    core.handle({
      type: "assistant_message",
      sessionId,
      text: "Hello world",
    });

    expect(projectedOfType(events, "item/started")).toHaveLength(0);
    expect(projectedOfType(events, "item/completed")).toEqual([{
      type: "item/completed",
      turnId,
      item: {
        id: `agentMessage:${turnId}`,
        type: "agentMessage",
        text: "Hello world",
      },
    }]);
  });
});
