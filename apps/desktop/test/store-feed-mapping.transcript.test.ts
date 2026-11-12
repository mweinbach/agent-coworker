import { describe, expect, test } from "bun:test";
import {
  buildContextPreamble,
  extractAgentStateFromTranscript,
  extractUsageStateFromTranscript,
  mapTranscriptToFeed,
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
        payload: { type: "todos", todos: [{ content: "Inspect files", status: "in_progress" }] },
      },
      {
        ts: "2024-01-01T00:00:05.000Z",
        threadId: "thread-1",
        direction: "server",
        payload: { type: "log", line: "Done." },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);

    expect(feed.map((item) => item.kind)).toEqual(["message", "todos", "log"]);
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
        payload: { type: "log", line: "Parent log." },
      },
    ];

    const feed = mapTranscriptToFeed(transcript);
    const agents = extractAgentStateFromTranscript(transcript);

    expect(feed).toHaveLength(1);
    expect(feed[0]?.kind).toBe("log");
    expect(agents).toHaveLength(1);
    expect(agents[0]?.agentId).toBe("agent-1");
    expect(agents[0]?.executionState).toBe("completed");
    expect(agents[0]?.lastMessagePreview).toBe("Done.");
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

  test("maps session backup diagnostics into readable system rows during transcript replay", () => {
    const transcript: TranscriptEvent[] = [
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
    ];

    const feed = mapTranscriptToFeed(transcript);
    const systemLines = feed
      .map((item) => (item.kind === "system" ? item.line : null))
      .filter(Boolean);

    expect(systemLines).toEqual(["Session backup (auto checkpoint): status=ready, checkpoints=2"]);
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

  describe("legacy TypeScript-harness transcripts", () => {
    const evt = (
      second: number,
      payload: Record<string, unknown>,
      direction: TranscriptEvent["direction"] = "server",
    ): TranscriptEvent => ({
      ts: `2024-01-01T00:00:${String(second).padStart(2, "0")}.000Z`,
      threadId: "thread-1",
      direction,
      payload,
    });
    const chunk = (
      second: number,
      index: number,
      partType: string,
      part: Record<string, unknown>,
    ) =>
      evt(second, {
        type: "model_stream_chunk",
        sessionId: "s",
        turnId: "turn-1",
        index,
        partType,
        part,
      });

    test("keeps assistant_message and reasoning replies and feeds them into the context preamble", () => {
      const feed = mapTranscriptToFeed([
        evt(1, { type: "user_message", text: "What is 2+2?", clientMessageId: "c1" }, "client"),
        evt(2, { type: "reasoning", kind: "summary", text: "Simple arithmetic." }),
        evt(3, { type: "assistant_message", text: "4" }),
        evt(4, { type: "observability_status", enabled: false, health: {} }),
        evt(5, { type: "harness_context", context: null }),
      ]);

      expect(feed.map((item) => item.kind)).toEqual(["message", "reasoning", "message"]);
      expect(feed[1]).toMatchObject({
        kind: "reasoning",
        mode: "summary",
        text: "Simple arithmetic.",
      });
      expect(feed[2]).toMatchObject({ kind: "message", role: "assistant", text: "4" });
      expect(buildContextPreamble(feed)).toContain("Assistant: 4");
    });

    test("rebuilds streamed turns without duplicating the final assistant_message", () => {
      const feed = mapTranscriptToFeed([
        evt(1, { type: "user_message", text: "List files" }, "client"),
        chunk(2, 0, "reasoning_delta", { id: "r1", mode: "reasoning", text: "Need to " }),
        chunk(2, 1, "reasoning_delta", { id: "r1", mode: "reasoning", text: "call ls." }),
        chunk(3, 2, "tool_call", {
          toolCallId: "call-1",
          toolName: "bash",
          input: { command: "ls" },
        }),
        chunk(4, 3, "tool_result", { toolCallId: "call-1", toolName: "bash", output: "a.txt" }),
        chunk(5, 4, "text_delta", { id: "t1", text: "Found " }),
        chunk(5, 5, "text_delta", { id: "t1", text: "a.txt" }),
        evt(6, { type: "model_stream_raw", turnId: "turn-1", event: {} }),
        evt(7, { type: "reasoning", kind: "reasoning", text: "Need to call ls." }),
        evt(7, { type: "assistant_message", text: "Found a.txt" }),
        evt(8, { type: "session_busy", busy: false }),
      ]);

      expect(feed.map((item) => item.kind)).toEqual([
        "message",
        "reasoning",
        "tool",
        "message",
        "system",
      ]);
      expect(feed[1]).toMatchObject({ kind: "reasoning", text: "Need to call ls." });
      expect(feed[2]).toMatchObject({
        kind: "tool",
        name: "bash",
        state: "output-available",
        args: { command: "ls" },
        result: "a.txt",
      });
      expect(feed[3]).toMatchObject({ kind: "message", role: "assistant", text: "Found a.txt" });
      expect(feed.some((item) => item.kind === "system" && item.line.startsWith("Unhandled"))).toBe(
        false,
      );
    });

    test("restores citation annotations from text_end chunks onto streamed assistant messages", () => {
      const annotations = [
        { type: "url_citation", url: "https://example.com/docs", title: "Docs" },
      ];
      const feed = mapTranscriptToFeed([
        evt(1, { type: "user_message", text: "Where are the docs?" }, "client"),
        chunk(2, 0, "text_delta", { id: "t1", phase: "commentary", text: "Checking..." }),
        chunk(2, 1, "text_end", {
          id: "t1",
          phase: "commentary",
          annotations: [{ type: "url_citation", url: "https://ignored.example" }],
        }),
        chunk(3, 2, "text_delta", { id: "t2", text: "See the docs." }),
        chunk(3, 3, "text_end", { id: "t2", annotations }),
        evt(4, { type: "assistant_message", text: "See the docs." }),
      ]);

      expect(feed.map((item) => item.kind)).toEqual(["message", "reasoning", "message"]);
      expect(feed[2]).toMatchObject({
        kind: "message",
        role: "assistant",
        text: "See the docs.",
        annotations,
      });
    });
  });
});
