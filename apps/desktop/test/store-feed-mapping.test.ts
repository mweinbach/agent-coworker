import { describe, expect, test } from "bun:test";

import type { TranscriptEvent } from "../src/app/types";
import {
  createThreadModelStreamRuntime,
  extractAgentStateFromTranscript,
  extractUsageStateFromTranscript,
  mapTranscriptToFeed,
  reasoningInsertBeforeAssistantAfterStreamReplay,
} from "../src/app/store.feedMapping";

describe("desktop transcript feed mapping", () => {
  test("anchors late final reasoning before streamed assistant output", () => {
    const runtime = createThreadModelStreamRuntime();
    runtime.lastAssistantTurnId = "turn-live";
    runtime.lastAssistantStreamKeyByTurn.set("turn-live", "assistant:turn-live");
    runtime.assistantItemIdByStream.set("assistant:turn-live", "assistant-item-1");

    expect(reasoningInsertBeforeAssistantAfterStreamReplay(runtime)).toBe("assistant-item-1");
  });

  test("dedupes streamed reasoning against legacy reasoning finals while preserving trace order", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-1",
          index: 0,
          provider: "openai",
          model: "gpt-5.2",
          partType: "reasoning_delta",
          part: { id: "r1", mode: "summary", text: "thinking" },
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-1",
          index: 1,
          provider: "openai",
          model: "gpt-5.2",
          partType: "tool_call",
          part: { toolCallId: "tool-1", toolName: "read", input: { path: "README.md" } },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-1",
          index: 2,
          provider: "openai",
          model: "gpt-5.2",
          partType: "tool_result",
          part: { toolCallId: "tool-1", toolName: "read", output: { chars: 42 } },
        },
      },
      {
        ts: "2024-01-01T00:00:04.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "reasoning_summary", text: "thinking" },
      },
      {
        ts: "2024-01-01T00:00:05.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "assistant_message", text: "Done." },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);

    expect(feed.map((item) => item.kind)).toEqual(["reasoning", "tool", "message"]);

    const reasoning = feed.filter((item) => item.kind === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.text).toBe("thinking");

    const tool = feed.find((item) => item.kind === "tool");
    expect(tool?.kind).toBe("tool");
    if (!tool || tool.kind !== "tool") throw new Error("Expected tool feed item");
    expect(tool.name).toBe("read");
    expect(tool.state).toBe("output-available");
  });

  test("dedupes final reasoning against streamed reasoning from the latest step in the same turn", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        threadId: "thread-1",
        direction: "client",
        payload: { type: "user_message", text: "tell me about gtc this year" },
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-1",
          index: 0,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "start",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-1",
          index: 1,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "reasoning_delta",
          part: { id: "s0", mode: "reasoning", text: "Searching for the latest GTC details." },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-1",
          index: 2,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "tool_call",
          part: { toolCallId: "tool-1", toolName: "webSearch", input: { query: "NVIDIA GTC 2026" } },
        },
      },
      {
        ts: "2024-01-01T00:00:04.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-1",
          index: 3,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "tool_result",
          part: { toolCallId: "tool-1", toolName: "webSearch", output: "result" },
        },
      },
      {
        ts: "2024-01-01T00:00:05.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-1",
          index: 4,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "start",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:05.500Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-1",
          index: 5,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "reasoning_delta",
          part: { id: "s1", mode: "reasoning", text: "Verifying the final conference details." },
        },
      },
      {
        ts: "2024-01-01T00:00:06.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-1",
          index: 6,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "tool_call",
          part: { toolCallId: "tool-2", toolName: "webSearch", input: { query: "NVIDIA GTC 2027" } },
        },
      },
      {
        ts: "2024-01-01T00:00:07.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-1",
          index: 7,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "tool_result",
          part: { toolCallId: "tool-2", toolName: "webSearch", output: "result-2" },
        },
      },
      {
        ts: "2024-01-01T00:00:08.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "reasoning", kind: "reasoning", text: "Searching for the latest GTC details." },
      },
      {
        ts: "2024-01-01T00:00:09.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "assistant_message", text: "Here is the summary." },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);
    const reasoning = feed.filter((item) => item.kind === "reasoning");
    const tools = feed.filter((item) => item.kind === "tool");

    expect(reasoning).toHaveLength(2);
    expect(reasoning.map((item) => item.text)).toEqual([
      "Searching for the latest GTC details.",
      "Verifying the final conference details.",
    ]);
    if (tools[0]?.kind !== "tool" || tools[1]?.kind !== "tool") throw new Error("Expected tool feed items");
    expect(tools).toHaveLength(2);
    expect(tools.map((tool) => tool.args)).toEqual([{ query: "NVIDIA GTC 2026" }, { query: "NVIDIA GTC 2027" }]);
    expect(tools.map((tool) => tool.result)).toEqual(["result", "result-2"]);
    expect(feed.map((item) => item.kind)).toEqual(["message", "reasoning", "tool", "reasoning", "tool", "message"]);
  });

  test("dedupes aggregate final reasoning across streamed steps on normalized turns", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        threadId: "thread-1",
        direction: "client",
        payload: { type: "user_message", text: "what changed?" },
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-agg-1",
          index: 0,
          provider: "opencode-zen",
          model: "minimax-m2.5-free",
          partType: "start",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-agg-1",
          index: 1,
          provider: "opencode-zen",
          model: "minimax-m2.5-free",
          partType: "reasoning_delta",
          part: { id: "s0", mode: "reasoning", text: "First check." },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-agg-1",
          index: 2,
          provider: "opencode-zen",
          model: "minimax-m2.5-free",
          partType: "start",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:04.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-agg-1",
          index: 3,
          provider: "opencode-zen",
          model: "minimax-m2.5-free",
          partType: "reasoning_delta",
          part: { id: "s1", mode: "reasoning", text: "Second check." },
        },
      },
      {
        ts: "2024-01-01T00:00:05.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-agg-1",
          index: 4,
          provider: "opencode-zen",
          model: "minimax-m2.5-free",
          partType: "text_delta",
          part: { id: "a0", text: "Final answer." },
        },
      },
      {
        ts: "2024-01-01T00:00:06.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "reasoning", kind: "reasoning", text: "First check.\n\nSecond check." },
      },
      {
        ts: "2024-01-01T00:00:07.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "assistant_message", text: "Final answer." },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);
    const reasoning = feed.filter((item) => item.kind === "reasoning");

    expect(reasoning.map((item) => item.text)).toEqual(["First check.", "Second check."]);
    expect(feed.map((item) => item.kind)).toEqual(["message", "reasoning", "reasoning", "message"]);
  });

  test("allows final reasoning after a repeated start when the latest step had no streamed reasoning", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        threadId: "thread-1",
        direction: "client",
        payload: { type: "user_message", text: "tell me about gtc this year" },
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-2",
          index: 0,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "start",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-2",
          index: 1,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "reasoning_delta",
          part: { id: "s0", mode: "reasoning", text: "Initial research pass." },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-2",
          index: 2,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "start",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:04.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "reasoning", kind: "reasoning", text: "Final synthesis after the second step." },
      },
      {
        ts: "2024-01-01T00:00:05.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "assistant_message", text: "Here is the summary." },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);
    const reasoning = feed.filter((item) => item.kind === "reasoning");

    expect(reasoning).toHaveLength(2);
    expect(reasoning.map((item) => item.text)).toEqual([
      "Initial research pass.",
      "Final synthesis after the second step.",
    ]);
  });

  test("dedupes repeated-start legacy reasoning when it matches an earlier streamed step", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        threadId: "thread-1",
        direction: "client",
        payload: { type: "user_message", text: "tell me about gtc this year" },
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-3",
          index: 0,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "start",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-3",
          index: 1,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "reasoning_delta",
          part: { id: "s0", mode: "reasoning", text: "Searching for the latest GTC details." },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-google-3",
          index: 2,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          partType: "start",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:04.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "reasoning", kind: "reasoning", text: "Searching for the latest GTC details." },
      },
      {
        ts: "2024-01-01T00:00:05.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "assistant_message", text: "Here is the summary." },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);
    const reasoning = feed.filter((item) => item.kind === "reasoning");

    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.text).toBe("Searching for the latest GTC details.");
    expect(feed.map((item) => item.kind)).toEqual(["message", "reasoning", "message"]);
  });

  test("preserves transcript event order instead of sorting by timestamps", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:10.000Z",
        threadId: "thread-1",
        direction: "client",
        payload: { type: "user_message", text: "Start" },
      },
      {
        ts: "2024-01-01T00:00:30.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "reasoning_summary", text: "Inspecting files." },
      },
      {
        ts: "2024-01-01T00:00:05.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "assistant_message", text: "Done." },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);

    expect(feed.map((item) => item.kind)).toEqual(["message", "reasoning", "message"]);
    expect(feed[0]?.kind).toBe("message");
    expect(feed[1]?.kind).toBe("reasoning");
    expect(feed[2]?.kind).toBe("message");
  });

  test("suppresses agent lifecycle transcript events from feed and rebuilds latest agent state", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "agent_spawned",
          sessionId: "thread-session",
          agent: {
            agentId: "agent-1",
            parentSessionId: "thread-session",
            role: "research",
            mode: "collaborative",
            depth: 1,
            effectiveModel: "gpt-5.4",
            title: "Review notes",
            provider: "codex-cli",
            createdAt: "2024-01-01T00:00:01.000Z",
            updatedAt: "2024-01-01T00:00:01.000Z",
            lifecycleState: "active",
            executionState: "running",
            busy: true,
          },
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "agent_status",
          sessionId: "thread-session",
          agent: {
            agentId: "agent-1",
            parentSessionId: "thread-session",
            role: "research",
            mode: "collaborative",
            depth: 1,
            effectiveModel: "gpt-5.4",
            title: "Review notes",
            provider: "codex-cli",
            createdAt: "2024-01-01T00:00:01.000Z",
            updatedAt: "2024-01-01T00:00:02.000Z",
            lifecycleState: "active",
            executionState: "completed",
            busy: false,
            lastMessagePreview: "Done.",
          },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "assistant_message", text: "Parent reply." },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);
    const agents = extractAgentStateFromTranscript(transcript);

    expect(feed).toHaveLength(1);
    expect(feed[0]?.kind).toBe("message");
    expect(agents).toHaveLength(1);
    expect(agents[0]?.agentId).toBe("agent-1");
    expect(agents[0]?.executionState).toBe("completed");
    expect(agents[0]?.lastMessagePreview).toBe("Done.");
  });

  test("replays raw model stream events and ignores stale normalized reasoning chunks", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-raw",
          index: 0,
          provider: "openai",
          model: "gpt-5.2",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_item.added",
            item: { type: "reasoning", id: "rs_1", summary: [] },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-raw",
          index: 1,
          provider: "openai",
          model: "gpt-5.2",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.reasoning_summary_part.added",
            part: { text: "" },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-raw",
          index: 2,
          provider: "openai",
          model: "gpt-5.2",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.reasoning_summary_text.delta",
            delta: "raw reasoning",
          },
        },
      },
      {
        ts: "2024-01-01T00:00:04.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-raw",
          index: 3,
          provider: "openai",
          model: "gpt-5.2",
          partType: "reasoning_delta",
          part: { id: "r1", mode: "summary", text: "stale reasoning" },
        },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);

    const reasoning = feed.filter((item) => item.kind === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.text).toBe("raw reasoning");
  });

  test("keeps separate assistant text streams within one turn", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-2",
          index: 0,
          provider: "openai",
          model: "gpt-5.2",
          partType: "text_delta",
          part: { id: "txt_1", text: "First note." },
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-2",
          index: 1,
          provider: "openai",
          model: "gpt-5.2",
          partType: "text_delta",
          part: { id: "txt_2", text: "Second note." },
        },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);

    const assistant = feed.filter((item) => item.kind === "message" && item.role === "assistant");
    expect(assistant).toHaveLength(2);
    expect(assistant.map((item) => item.text)).toEqual(["First note.", "Second note."]);
  });

  test("does not create a blank assistant message for whitespace-only streamed text", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        threadId: "thread-1",
        direction: "client",
        payload: { type: "user_message", text: "research it" },
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-whitespace",
          index: 0,
          provider: "opencode-zen",
          model: "nemotron-3-super-free",
          partType: "reasoning_delta",
          part: { id: "r1", mode: "reasoning", text: "Plan the work first." },
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-whitespace",
          index: 1,
          provider: "opencode-zen",
          model: "nemotron-3-super-free",
          partType: "text_delta",
          part: { id: "txt_1", text: "\n" },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-whitespace",
          index: 2,
          provider: "opencode-zen",
          model: "nemotron-3-super-free",
          partType: "tool_call",
          part: { toolCallId: "tool-1", toolName: "todoWrite", input: { todos: [{ content: "Task", status: "pending" }] } },
        },
      },
      {
        ts: "2024-01-01T00:00:04.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-whitespace",
          index: 3,
          provider: "opencode-zen",
          model: "nemotron-3-super-free",
          partType: "reasoning_delta",
          part: { id: "r2", mode: "reasoning", text: "Start with the first topic." },
        },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);

    expect(feed.map((item) => item.kind)).toEqual(["message", "reasoning", "tool", "reasoning"]);
    expect(feed.filter((item) => item.kind === "message" && item.role === "assistant")).toHaveLength(0);
  });

  test("skips whitespace-only assistant_message payloads during transcript replay", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        threadId: "thread-1",
        direction: "client",
        payload: { type: "user_message", text: "research it" },
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "assistant_message", text: "\n" },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "reasoning_summary", text: "Continue with the next step." },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);

    expect(feed.map((item) => item.kind)).toEqual(["message", "reasoning"]);
    expect(feed.filter((item) => item.kind === "message" && item.role === "assistant")).toHaveLength(0);
  });

  test("suppresses client-side usage budget updates during transcript replay", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "client",
        payload: {
          type: "set_session_usage_budget",
          sessionId: "thread-session",
          stopAtUsd: null,
        },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);

    expect(feed).toEqual([]);
  });

  test("maps developer diagnostics into readable system rows during transcript replay", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "observability_status",
          sessionId: "thread-session",
          enabled: true,
          health: { status: "ready", reason: "runtime_ready" },
          config: {
            provider: "langfuse",
            baseUrl: "https://example.com",
            otelEndpoint: "https://example.com/otel",
            hasPublicKey: true,
            hasSecretKey: true,
            configured: true,
          },
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "session_backup_state",
          sessionId: "thread-session",
          reason: "auto_checkpoint",
          backup: {
            status: "ready",
            checkpoints: [{ id: "cp-1" }, { id: "cp-2" }],
          },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "harness_context",
          sessionId: "thread-session",
          context: {
            taskId: "task-7",
            runId: "run-9",
            objective: "Ship the desktop diagnostic fix.",
            acceptanceCriteria: ["a"],
            constraints: ["b", "c"],
          },
        },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);
    const systemLines = feed.map((item) => (item.kind === "system" ? item.line : null)).filter(Boolean);

    expect(systemLines).toEqual([
      "Observability: enabled=yes, configured=yes, health=ready (runtime_ready)",
      "Session backup (auto checkpoint): status=ready, checkpoints=2",
      "Harness context updated: taskId=task-7, runId=run-9, objective=Ship the desktop diagnostic fix., acceptanceCriteria=1, constraints=2",
    ]);
  });

  test("uses the same unhandled event copy during transcript replay", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "future_event",
          payload: true,
        },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);

    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ kind: "system", line: "Unhandled event: future_event" });
  });

  test("ignores malformed session_usage snapshots during transcript replay", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "session_usage",
          sessionId: "thread-session",
          usage: {
            sessionId: "thread-session",
            totalTurns: 1,
          },
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "turn_usage",
          sessionId: "thread-session",
          turnId: "turn-1",
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
          },
        },
      },
    ];

    expect(extractUsageStateFromTranscript(transcript)).toEqual({
      sessionUsage: null,
      lastTurnUsage: {
        turnId: "turn-1",
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
        },
      },
    });
  });

  test("prefers raw final-answer text over a stale merged assistant_message on raw-backed turns", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-commentary",
          index: 0,
          provider: "codex-cli",
          model: "gpt-5.2",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_item.added",
            item: { type: "message", id: "msg_commentary", phase: "commentary", content: [] },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-commentary",
          index: 1,
          provider: "codex-cli",
          model: "gpt-5.2",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.content_part.added",
            item_id: "msg_commentary",
            part: { type: "output_text", text: "" },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-commentary",
          index: 2,
          provider: "codex-cli",
          model: "gpt-5.2",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_text.delta",
            item_id: "msg_commentary",
            delta: "progress note",
          },
        },
      },
      {
        ts: "2024-01-01T00:00:04.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-commentary",
          index: 3,
          provider: "codex-cli",
          model: "gpt-5.2",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_item.done",
            item: {
              id: "msg_commentary",
              type: "message",
              phase: "commentary",
              status: "completed",
              content: [{ type: "output_text", text: "progress note" }],
            },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:05.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-commentary",
          index: 4,
          provider: "codex-cli",
          model: "gpt-5.2",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_item.added",
            item: { type: "message", id: "msg_final", phase: "final_answer", content: [] },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:06.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-commentary",
          index: 5,
          provider: "codex-cli",
          model: "gpt-5.2",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.content_part.added",
            item_id: "msg_final",
            part: { type: "output_text", text: "" },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:07.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-commentary",
          index: 6,
          provider: "codex-cli",
          model: "gpt-5.2",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_text.delta",
            item_id: "msg_final",
            delta: "final answer",
          },
        },
      },
      {
        ts: "2024-01-01T00:00:08.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-commentary",
          index: 7,
          provider: "codex-cli",
          model: "gpt-5.2",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_item.done",
            item: {
              id: "msg_final",
              type: "message",
              phase: "final_answer",
              status: "completed",
              content: [{ type: "output_text", text: "final answer" }],
            },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:09.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "assistant_message",
          text: "progress note\n\nfinal answer",
        },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);
    const assistant = feed.filter((item) => item.kind === "message" && item.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.text).toBe("final answer");
  });

  test("attaches native annotations to streamed assistant messages", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        threadId: "thread-1",
        direction: "client",
        payload: { type: "user_message", text: "What changed?" },
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-annotations",
          index: 0,
          provider: "codex-cli",
          model: "gpt-5.4",
          partType: "text_delta",
          part: { id: "txt_1", text: "Answer" },
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-annotations",
          index: 1,
          provider: "codex-cli",
          model: "gpt-5.4",
          partType: "text_end",
          part: {
            id: "txt_1",
            annotations: [
              {
                type: "url_citation",
                start_index: 0,
                end_index: 6,
                url: "https://example.com/source",
              },
            ],
          },
        },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);
    const assistant = feed.find((item) => item.kind === "message" && item.role === "assistant");
    expect(assistant?.kind).toBe("message");
    if (!assistant || assistant.kind !== "message") throw new Error("Expected assistant message");
    expect(assistant.text).toBe("Answer");
    expect(assistant.annotations).toEqual([
      {
        type: "url_citation",
        start_index: 0,
        end_index: 6,
        url: "https://example.com/source",
      },
    ]);
  });

  test("maps native web search raw events into visible tool feed activity", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        threadId: "thread-1",
        direction: "client",
        payload: { type: "user_message", text: "Search the web" },
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-native-web",
          index: 0,
          provider: "codex-cli",
          model: "gpt-5.4",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_item.added",
            item: {
              id: "ws_1",
              type: "web_search_call",
              action: {
                type: "search",
                query: "latest OpenAI",
              },
            },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-native-web",
          index: 1,
          provider: "codex-cli",
          model: "gpt-5.4",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_item.done",
            item: {
              id: "ws_1",
              type: "web_search_call",
              status: "completed",
              action: {
                type: "search",
                query: "latest OpenAI",
                sources: [{ url: "https://example.com/news" }],
              },
            },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "assistant_message", text: "Here is the latest." },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);
    const tool = feed.find((item) => item.kind === "tool");
    expect(tool?.kind).toBe("tool");
    if (!tool || tool.kind !== "tool") throw new Error("Expected tool item");
    expect(tool.name).toBe("nativeWebSearch");
    expect(tool.state).toBe("output-available");
    expect(tool.result).toEqual({
      status: "completed",
      action: {
        type: "search",
        query: "latest OpenAI",
        sources: [{ url: "https://example.com/news" }],
      },
      sources: [{ url: "https://example.com/news" }],
      raw: {
        id: "ws_1",
        type: "web_search_call",
        status: "completed",
        action: {
          type: "search",
          query: "latest OpenAI",
          sources: [{ url: "https://example.com/news" }],
        },
      },
    });
  });

  test("replays raw google interactions reasoning and tool traces from persisted sessions", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        threadId: "thread-1",
        direction: "client",
        payload: { type: "user_message", text: "Make the Spider-Man deck better" },
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-google-raw",
          index: 0,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          format: "google-interactions-v1",
          normalizerVersion: 1,
          event: {
            event_type: "content.start",
            index: 0,
            content: { type: "thought" },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-google-raw",
          index: 1,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          format: "google-interactions-v1",
          normalizerVersion: 1,
          event: {
            event_type: "content.delta",
            index: 0,
            delta: {
              type: "thought_summary",
              content: { type: "text", text: "Searching for trailer visuals." },
            },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-google-raw",
          index: 2,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          format: "google-interactions-v1",
          normalizerVersion: 1,
          event: {
            event_type: "content.delta",
            index: 1,
            delta: {
              type: "function_call",
              id: "call_fetch",
              name: "webFetch",
              arguments: { url: "https://example.com/trailer" },
            },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:04.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-google-raw",
          index: 3,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          format: "google-interactions-v1",
          normalizerVersion: 1,
          event: {
            event_type: "content.stop",
            index: 1,
          },
        },
      },
      {
        ts: "2024-01-01T00:00:05.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-google-raw",
          index: 4,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          format: "google-interactions-v1",
          normalizerVersion: 1,
          event: {
            event_type: "content.delta",
            index: 2,
            delta: {
              type: "google_search_call",
              id: "native_search",
              arguments: { queries: ["Spider-Man trailer screenshots"] },
            },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:06.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-google-raw",
          index: 5,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          format: "google-interactions-v1",
          normalizerVersion: 1,
          event: {
            event_type: "content.delta",
            index: 3,
            delta: {
              type: "google_search_result",
              call_id: "native_search",
              result: {
                sources: [{ url: "https://example.com/search" }],
                results: [{ title: "Trailer stills" }],
              },
            },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:07.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-google-raw",
          index: 6,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          format: "google-interactions-v1",
          normalizerVersion: 1,
          event: {
            event_type: "content.stop",
            index: 3,
          },
        },
      },
      {
        ts: "2024-01-01T00:00:08.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "assistant_message", text: "Updated the presentation." },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);

    expect(feed.map((item) => item.kind)).toEqual(["message", "system", "reasoning", "tool", "tool", "message"]);

    const reasoning = feed.find((item) => item.kind === "reasoning");
    expect(reasoning?.kind).toBe("reasoning");
    if (!reasoning || reasoning.kind !== "reasoning") throw new Error("Expected reasoning item");
    expect(reasoning.text).toBe("Searching for trailer visuals.");

    const system = feed.find((item) => item.kind === "system");
    expect(system?.kind).toBe("system");
    if (!system || system.kind !== "system") throw new Error("Expected system item");
    expect(system.line).toBe("Reasoning started (reasoning)");

    const tools = feed.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(2);
    if (tools[0]?.kind !== "tool" || tools[1]?.kind !== "tool") {
      throw new Error("Expected tool items");
    }
    expect(tools[0]).toMatchObject({
      name: "webFetch",
      state: "input-available",
      args: { url: "https://example.com/trailer" },
    });
    expect(tools[1]).toMatchObject({
      name: "nativeWebSearch",
      state: "output-available",
      args: { queries: ["Spider-Man trailer screenshots"] },
      result: {
        provider: "google",
        status: "completed",
        callId: "native_search",
        queries: ["Spider-Man trailer screenshots"],
        results: [{ title: "Trailer stills" }],
        sources: [{ url: "https://example.com/search" }],
      },
    });
  });

  test("keeps repeated google interaction loops inline within the same persisted turn", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        threadId: "thread-1",
        direction: "client",
        payload: { type: "user_message", text: "Create the report" },
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-google-loop",
          index: 0,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          format: "google-interactions-v1",
          normalizerVersion: 1,
          event: { event_type: "interaction.start" },
        },
      },
      {
        ts: "2024-01-01T00:00:01.100Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-google-loop",
          index: 1,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          format: "google-interactions-v1",
          normalizerVersion: 1,
          event: { event_type: "content.start", index: 0, content: { type: "thought" } },
        },
      },
      {
        ts: "2024-01-01T00:00:01.200Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-google-loop",
          index: 2,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          format: "google-interactions-v1",
          normalizerVersion: 1,
          event: {
            event_type: "content.delta",
            index: 0,
            delta: { type: "thought_summary", content: { type: "text", text: "Planning the report." } },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:01.300Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-google-loop",
          index: 3,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          format: "google-interactions-v1",
          normalizerVersion: 1,
          event: { event_type: "content.stop", index: 0 },
        },
      },
      {
        ts: "2024-01-01T00:00:01.400Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-google-loop",
          index: 4,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          format: "google-interactions-v1",
          normalizerVersion: 1,
          event: {
            event_type: "content.delta",
            index: 1,
            delta: {
              type: "function_call",
              id: "call_1",
              name: "write",
              arguments: { filePath: "report.md" },
            },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:01.500Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-google-loop",
          index: 5,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          format: "google-interactions-v1",
          normalizerVersion: 1,
          event: { event_type: "content.stop", index: 1 },
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-google-loop",
          index: 6,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          format: "google-interactions-v1",
          normalizerVersion: 1,
          event: { event_type: "interaction.start" },
        },
      },
      {
        ts: "2024-01-01T00:00:02.100Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-google-loop",
          index: 7,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          format: "google-interactions-v1",
          normalizerVersion: 1,
          event: { event_type: "content.start", index: 0, content: { type: "thought" } },
        },
      },
      {
        ts: "2024-01-01T00:00:02.200Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-google-loop",
          index: 8,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          format: "google-interactions-v1",
          normalizerVersion: 1,
          event: {
            event_type: "content.delta",
            index: 0,
            delta: { type: "thought_summary", content: { type: "text", text: "Verifying the output." } },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:02.300Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-google-loop",
          index: 9,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          format: "google-interactions-v1",
          normalizerVersion: 1,
          event: { event_type: "content.stop", index: 0 },
        },
      },
      {
        ts: "2024-01-01T00:00:02.400Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-google-loop",
          index: 10,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          format: "google-interactions-v1",
          normalizerVersion: 1,
          event: {
            event_type: "content.delta",
            index: 1,
            delta: {
              type: "function_call",
              id: "call_2",
              name: "glob",
              arguments: { pattern: "report.md" },
            },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:02.500Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-google-loop",
          index: 11,
          provider: "google",
          model: "gemini-3.1-pro-preview-customtools",
          format: "google-interactions-v1",
          normalizerVersion: 1,
          event: { event_type: "content.stop", index: 1 },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "assistant_message", text: "Done." },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);
    const contentKinds = feed
      .filter((item) => item.kind === "reasoning" || item.kind === "tool" || item.kind === "message")
      .map((item) => item.kind);

    expect(contentKinds).toEqual(["message", "reasoning", "tool", "reasoning", "tool", "message"]);

    const reasoning = feed.filter((item) => item.kind === "reasoning");
    expect(reasoning.map((item) => item.text)).toEqual([
      "Planning the report.",
      "Verifying the output.",
    ]);

    const tools = feed.filter((item) => item.kind === "tool");
    if (tools[0]?.kind !== "tool" || tools[1]?.kind !== "tool") {
      throw new Error("Expected tool items");
    }
    expect(tools.map((item) => item.name)).toEqual(["write", "glob"]);
  });

  test("keeps separate feed cards for distinct native web search calls", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        threadId: "thread-1",
        direction: "client",
        payload: { type: "user_message", text: "Research it" },
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-native-web",
          index: 0,
          provider: "codex-cli",
          model: "gpt-5.4",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_item.added",
            item: {
              id: "ws_1",
              type: "web_search_call",
              action: { type: "search", query: "latest OpenAI" },
            },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-native-web",
          index: 1,
          provider: "codex-cli",
          model: "gpt-5.4",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_item.done",
            item: {
              id: "ws_1",
              type: "web_search_call",
              status: "completed",
              action: { type: "search", query: "latest OpenAI" },
            },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-native-web",
          index: 2,
          provider: "codex-cli",
          model: "gpt-5.4",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_item.added",
            item: {
              id: "ws_2",
              type: "web_search_call",
              action: { type: "open_page", url: "https://example.com/openai" },
            },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:04.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-native-web",
          index: 3,
          provider: "codex-cli",
          model: "gpt-5.4",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_item.done",
            item: {
              id: "ws_2",
              type: "web_search_call",
              status: "completed",
              action: { type: "open_page", url: "https://example.com/openai" },
            },
          },
        },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);
    const tools = feed.filter((item) => item.kind === "tool");

    expect(tools).toHaveLength(2);
    expect(tools.every((item) => item.kind === "tool" && item.name === "nativeWebSearch")).toBeTrue();
    if (tools[0]?.kind !== "tool" || tools[1]?.kind !== "tool") {
      throw new Error("Expected tool items");
    }
    expect(tools[0].result).toMatchObject({
      status: "completed",
      action: { type: "search", query: "latest OpenAI" },
    });
    expect(tools[1].result).toMatchObject({
      status: "completed",
      action: { type: "open_page", url: "https://example.com/openai" },
    });
  });

  test("skips a merged assistant_message when streamed multi-step assistant text already exists", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        threadId: "thread-1",
        direction: "client",
        payload: { type: "user_message", text: "research it" },
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-merge",
          index: 0,
          provider: "opencode-go",
          model: "glm-5",
          partType: "start",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-merge",
          index: 1,
          provider: "opencode-go",
          model: "glm-5",
          partType: "text_delta",
          part: { id: "s1", text: "progress note" },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-merge",
          index: 2,
          provider: "opencode-go",
          model: "glm-5",
          partType: "text_end",
          part: { id: "s1" },
        },
      },
      {
        ts: "2024-01-01T00:00:04.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-merge",
          index: 3,
          provider: "opencode-go",
          model: "glm-5",
          partType: "finish",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:05.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-merge",
          index: 4,
          provider: "opencode-go",
          model: "glm-5",
          partType: "start",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:06.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-merge",
          index: 5,
          provider: "opencode-go",
          model: "glm-5",
          partType: "text_delta",
          part: { id: "s1", text: "final answer" },
        },
      },
      {
        ts: "2024-01-01T00:00:07.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-merge",
          index: 6,
          provider: "opencode-go",
          model: "glm-5",
          partType: "text_end",
          part: { id: "s1" },
        },
      },
      {
        ts: "2024-01-01T00:00:08.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-merge",
          index: 7,
          provider: "opencode-go",
          model: "glm-5",
          partType: "finish",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:09.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "assistant_message",
          text: "progress note\n\nfinal answer",
        },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);
    const assistant = feed.filter((item) => item.kind === "message" && item.role === "assistant");

    expect(assistant).toHaveLength(2);
    expect(assistant.map((item) => item.text)).toEqual(["progress note", "final answer"]);
  });

  test("skips a merged assistant_message when it only differs by paragraph indentation", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        threadId: "thread-1",
        direction: "client",
        payload: { type: "user_message", text: "research it" },
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-indented-merge",
          index: 0,
          provider: "opencode-zen",
          model: "kimi-k2.5",
          partType: "start",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-indented-merge",
          index: 1,
          provider: "opencode-zen",
          model: "kimi-k2.5",
          partType: "text_delta",
          part: { id: "s1", text: "progress note" },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-indented-merge",
          index: 2,
          provider: "opencode-zen",
          model: "kimi-k2.5",
          partType: "text_end",
          part: { id: "s1" },
        },
      },
      {
        ts: "2024-01-01T00:00:04.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-indented-merge",
          index: 3,
          provider: "opencode-zen",
          model: "kimi-k2.5",
          partType: "finish",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:05.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-indented-merge",
          index: 4,
          provider: "opencode-zen",
          model: "kimi-k2.5",
          partType: "start",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:06.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-indented-merge",
          index: 5,
          provider: "opencode-zen",
          model: "kimi-k2.5",
          partType: "text_delta",
          part: { id: "s1", text: "final answer" },
        },
      },
      {
        ts: "2024-01-01T00:00:07.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-indented-merge",
          index: 6,
          provider: "opencode-zen",
          model: "kimi-k2.5",
          partType: "text_end",
          part: { id: "s1" },
        },
      },
      {
        ts: "2024-01-01T00:00:08.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-indented-merge",
          index: 7,
          provider: "opencode-zen",
          model: "kimi-k2.5",
          partType: "finish",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:09.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "assistant_message",
          text: "progress note\n\n  final answer",
        },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);
    const assistant = feed.filter((item) => item.kind === "message" && item.role === "assistant");

    expect(assistant).toHaveLength(2);
    expect(assistant.map((item) => item.text)).toEqual(["progress note", "final answer"]);
  });

  test("skips a merged assistant_message when streamed assistant text only differs by leading boundary whitespace", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        threadId: "thread-1",
        direction: "client",
        payload: { type: "user_message", text: "research it" },
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-leading-boundary-merge",
          index: 0,
          provider: "lmstudio",
          model: "local-model",
          partType: "start",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-leading-boundary-merge",
          index: 1,
          provider: "lmstudio",
          model: "local-model",
          partType: "text_delta",
          part: { id: "s1", text: "\n\n" },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-leading-boundary-merge",
          index: 2,
          provider: "lmstudio",
          model: "local-model",
          partType: "text_end",
          part: { id: "s1" },
        },
      },
      {
        ts: "2024-01-01T00:00:04.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-leading-boundary-merge",
          index: 3,
          provider: "lmstudio",
          model: "local-model",
          partType: "finish",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:05.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-leading-boundary-merge",
          index: 4,
          provider: "lmstudio",
          model: "local-model",
          partType: "start",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:06.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-leading-boundary-merge",
          index: 5,
          provider: "lmstudio",
          model: "local-model",
          partType: "text_delta",
          part: { id: "s1", text: "\n\nfinal answer" },
        },
      },
      {
        ts: "2024-01-01T00:00:07.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-leading-boundary-merge",
          index: 6,
          provider: "lmstudio",
          model: "local-model",
          partType: "text_end",
          part: { id: "s1" },
        },
      },
      {
        ts: "2024-01-01T00:00:08.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_chunk",
          sessionId: "thread-session",
          turnId: "turn-leading-boundary-merge",
          index: 7,
          provider: "lmstudio",
          model: "local-model",
          partType: "finish",
          part: {},
        },
      },
      {
        ts: "2024-01-01T00:00:09.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "assistant_message",
          text: "final answer",
        },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);
    const assistant = feed.filter((item) => item.kind === "message" && item.role === "assistant");

    expect(assistant).toHaveLength(1);
    expect(assistant.map((item) => item.text)).toEqual(["\n\nfinal answer"]);
  });

  test("inserts a late legacy reasoning summary before the raw-backed final assistant message", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-late-reasoning",
          index: 0,
          provider: "codex-cli",
          model: "gpt-5.2",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_item.added",
            item: { type: "message", id: "msg_final", phase: "final_answer", content: [] },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-late-reasoning",
          index: 1,
          provider: "codex-cli",
          model: "gpt-5.2",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.content_part.added",
            item_id: "msg_final",
            part: { type: "output_text", text: "" },
          },
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "model_stream_raw",
          sessionId: "thread-session",
          turnId: "turn-late-reasoning",
          index: 2,
          provider: "codex-cli",
          model: "gpt-5.2",
          format: "openai-responses-v1",
          normalizerVersion: 1,
          event: {
            type: "response.output_text.delta",
            item_id: "msg_final",
            delta: "final answer",
          },
        },
      },
      {
        ts: "2024-01-01T00:00:04.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "reasoning", kind: "summary", text: "late summary" },
      },
      {
        ts: "2024-01-01T00:00:05.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "assistant_message", text: "final answer" },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);

    expect(feed.map((item) => item.kind)).toEqual(["reasoning", "message"]);
    expect(feed[0]?.kind).toBe("reasoning");
    expect(feed[1]?.kind).toBe("message");
    if (feed[0]?.kind !== "reasoning") throw new Error("Expected reasoning item first");
    if (feed[1]?.kind !== "message") throw new Error("Expected assistant message second");
    expect(feed[0].text).toBe("late summary");
    expect(feed[1].role).toBe("assistant");
    expect(feed[1].text).toBe("final answer");
  });
});
