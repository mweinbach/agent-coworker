import { describe, expect, test } from "bun:test";
import {
  createThreadModelStreamRuntime,
  extractAgentStateFromTranscript,
  extractUsageStateFromTranscript,
  mapTranscriptToFeed,
  reasoningInsertBeforeAssistantAfterStreamReplay,
} from "../src/app/store.feedMapping";
import type { TranscriptEvent } from "../src/app/types";

describe("desktop transcript feed mapping", () => {
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

  test("keeps newer agent_status data when a later agent_wait_result carries an older sibling snapshot", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:01.000Z",
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
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:03.000Z",
            lifecycleState: "active",
            executionState: "completed",
            busy: false,
            lastMessagePreview: "Done.",
          },
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: {
          type: "agent_wait_result",
          sessionId: "thread-session",
          agentIds: ["agent-1", "agent-2"],
          timedOut: false,
          mode: "any",
          agents: [
            {
              agentId: "agent-1",
              parentSessionId: "thread-session",
              role: "research",
              mode: "collaborative",
              depth: 1,
              effectiveModel: "gpt-5.4",
              title: "Review notes",
              provider: "codex-cli",
              createdAt: "2024-01-01T00:00:00.000Z",
              updatedAt: "2024-01-01T00:00:02.000Z",
              lifecycleState: "active",
              executionState: "running",
              busy: true,
            },
            {
              agentId: "agent-2",
              parentSessionId: "thread-session",
              role: "worker",
              mode: "collaborative",
              depth: 1,
              effectiveModel: "gpt-5.4",
              title: "Worker",
              provider: "codex-cli",
              createdAt: "2024-01-01T00:00:00.000Z",
              updatedAt: "2024-01-01T00:00:04.000Z",
              lifecycleState: "active",
              executionState: "completed",
              busy: false,
              lastMessagePreview: "finished",
            },
          ],
          readyAgentIds: ["agent-2"],
        },
      },
    ];

    const agents = extractAgentStateFromTranscript(transcript);

    expect(agents).toHaveLength(2);
    expect(agents.find((agent) => agent.agentId === "agent-1")).toMatchObject({
      executionState: "completed",
      updatedAt: "2024-01-01T00:00:03.000Z",
      busy: false,
      lastMessagePreview: "Done.",
    });
    expect(agents.find((agent) => agent.agentId === "agent-2")).toMatchObject({
      executionState: "completed",
      updatedAt: "2024-01-01T00:00:04.000Z",
      lastMessagePreview: "finished",
    });
  });

  test("lets a same-timestamp rerun status replace the prior terminal agent summary", () => {
    const transcript: TranscriptEvent[] = [
      {
        ts: "2024-01-01T00:00:01.000Z",
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
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:03.000Z",
            lifecycleState: "active",
            executionState: "completed",
            busy: false,
            lastMessagePreview: "Done.",
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
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:03.000Z",
            lifecycleState: "active",
            executionState: "running",
            busy: true,
            lastMessagePreview: "Done.",
          },
        },
      },
    ];

    const agents = extractAgentStateFromTranscript(transcript);

    expect(agents).toEqual([
      expect.objectContaining({
        agentId: "agent-1",
        executionState: "running",
        busy: true,
        updatedAt: "2024-01-01T00:00:03.000Z",
      }),
    ]);
  });
});
