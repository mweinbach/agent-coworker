import { describe, expect, test } from "bun:test";

import { projectThreadTurnsFromJournal } from "../src/server/jsonrpc/threadReadProjector";

describe("JSON-RPC thread read projector", () => {
  test("rebuilds streamed reasoning text from journal delta events before completion", () => {
    const turns = projectThreadTurnsFromJournal([
      {
        threadId: "thread-1",
        seq: 1,
        ts: "2026-03-22T15:39:39.127Z",
        eventType: "turn/started",
        turnId: "turn-1",
        itemId: null,
        requestId: null,
        payload: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "inProgress", items: [] },
        },
      },
      {
        threadId: "thread-1",
        seq: 2,
        ts: "2026-03-22T15:39:41.772Z",
        eventType: "item/started",
        turnId: "turn-1",
        itemId: "reasoning-1",
        requestId: null,
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "reasoning-1",
            type: "reasoning",
            mode: "summary",
            text: "",
          },
        },
      },
      {
        threadId: "thread-1",
        seq: 3,
        ts: "2026-03-22T15:39:41.774Z",
        eventType: "item/reasoning/delta",
        turnId: "turn-1",
        itemId: "reasoning-1",
        requestId: null,
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "reasoning-1",
          mode: "summary",
          delta: "Inspecting the reports.",
        },
      },
    ] as any);

    expect(turns).toEqual([
      {
        id: "turn-1",
        status: "inProgress",
        items: [
          {
            id: "reasoning-1",
            type: "reasoning",
            mode: "summary",
            text: "Inspecting the reports.",
          },
        ],
      },
    ]);
  });

  test("preserves projected tool items from the journal", () => {
    const turns = projectThreadTurnsFromJournal([
      {
        threadId: "thread-1",
        seq: 1,
        ts: "2026-03-22T15:39:39.127Z",
        eventType: "turn/started",
        turnId: "turn-1",
        itemId: null,
        requestId: null,
        payload: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "inProgress", items: [] },
        },
      },
      {
        threadId: "thread-1",
        seq: 2,
        ts: "2026-03-22T15:39:41.772Z",
        eventType: "item/started",
        turnId: "turn-1",
        itemId: "tool-1",
        requestId: null,
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "tool-1",
            type: "toolCall",
            toolName: "nativeWebSearch",
            state: "input-streaming",
          },
        },
      },
      {
        threadId: "thread-1",
        seq: 3,
        ts: "2026-03-22T15:39:41.774Z",
        eventType: "item/completed",
        turnId: "turn-1",
        itemId: "tool-1",
        requestId: null,
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "tool-1",
            type: "toolCall",
            toolName: "nativeWebSearch",
            state: "output-available",
            args: { queries: ["Project Hail Mary movie reviews"] },
            result: {
              provider: "google",
              status: "completed",
              results: [{ title: "MovieWeb" }],
            },
          },
        },
      },
    ] as any);

    expect(turns).toEqual([
      {
        id: "turn-1",
        status: "inProgress",
        items: [
          {
            id: "tool-1",
            type: "toolCall",
            toolName: "nativeWebSearch",
            state: "output-available",
            args: { queries: ["Project Hail Mary movie reviews"] },
            result: {
              provider: "google",
              status: "completed",
              results: [{ title: "MovieWeb" }],
            },
          },
        ],
      },
    ]);
  });

  test("disambiguates repeated item ids from older PI-style journals while preserving order", () => {
    const turns = projectThreadTurnsFromJournal([
      {
        threadId: "thread-1",
        seq: 1,
        ts: "2026-03-22T15:39:39.127Z",
        eventType: "turn/started",
        turnId: "turn-1",
        itemId: null,
        requestId: null,
        payload: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "inProgress", items: [] },
        },
      },
      {
        threadId: "thread-1",
        seq: 2,
        ts: "2026-03-22T15:39:41.772Z",
        eventType: "item/started",
        turnId: "turn-1",
        itemId: "reasoning-1",
        requestId: null,
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "reasoning-1", type: "reasoning", mode: "reasoning", text: "" },
        },
      },
      {
        threadId: "thread-1",
        seq: 3,
        ts: "2026-03-22T15:39:41.773Z",
        eventType: "item/reasoning/delta",
        turnId: "turn-1",
        itemId: "reasoning-1",
        requestId: null,
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "reasoning-1",
          mode: "reasoning",
          delta: "First step.",
        },
      },
      {
        threadId: "thread-1",
        seq: 4,
        ts: "2026-03-22T15:39:41.774Z",
        eventType: "item/completed",
        turnId: "turn-1",
        itemId: "reasoning-1",
        requestId: null,
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "reasoning-1", type: "reasoning", mode: "reasoning", text: "First step." },
        },
      },
      {
        threadId: "thread-1",
        seq: 5,
        ts: "2026-03-22T15:39:41.775Z",
        eventType: "item/started",
        turnId: "turn-1",
        itemId: "reasoning-1",
        requestId: null,
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "reasoning-1", type: "reasoning", mode: "reasoning", text: "" },
        },
      },
      {
        threadId: "thread-1",
        seq: 6,
        ts: "2026-03-22T15:39:41.776Z",
        eventType: "item/reasoning/delta",
        turnId: "turn-1",
        itemId: "reasoning-1",
        requestId: null,
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "reasoning-1",
          mode: "reasoning",
          delta: "Second step.",
        },
      },
      {
        threadId: "thread-1",
        seq: 7,
        ts: "2026-03-22T15:39:41.777Z",
        eventType: "item/completed",
        turnId: "turn-1",
        itemId: "reasoning-1",
        requestId: null,
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "reasoning-1", type: "reasoning", mode: "reasoning", text: "Second step." },
        },
      },
      {
        threadId: "thread-1",
        seq: 8,
        ts: "2026-03-22T15:39:41.778Z",
        eventType: "item/started",
        turnId: "turn-1",
        itemId: "tool-1",
        requestId: null,
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "tool-1", type: "toolCall", toolName: "webSearch", state: "input-streaming" },
        },
      },
      {
        threadId: "thread-1",
        seq: 9,
        ts: "2026-03-22T15:39:41.779Z",
        eventType: "item/completed",
        turnId: "turn-1",
        itemId: "tool-1",
        requestId: null,
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "tool-1",
            type: "toolCall",
            toolName: "webSearch",
            state: "output-available",
            args: { query: "first" },
            result: { result: "first" },
          },
        },
      },
      {
        threadId: "thread-1",
        seq: 10,
        ts: "2026-03-22T15:39:41.780Z",
        eventType: "item/started",
        turnId: "turn-1",
        itemId: "tool-1",
        requestId: null,
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "tool-1", type: "toolCall", toolName: "webSearch", state: "input-streaming" },
        },
      },
      {
        threadId: "thread-1",
        seq: 11,
        ts: "2026-03-22T15:39:41.781Z",
        eventType: "item/completed",
        turnId: "turn-1",
        itemId: "tool-1",
        requestId: null,
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "tool-1",
            type: "toolCall",
            toolName: "webSearch",
            state: "output-available",
            args: { query: "second" },
            result: { result: "second" },
          },
        },
      },
    ] as any);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.items).toHaveLength(4);
    expect(turns[0]?.items.map((item) => item.id)).toEqual([
      "reasoning-1",
      "reasoning-1:2",
      "tool-1",
      "tool-1:2",
    ]);
    expect(turns[0]?.items.map((item) => item.type)).toEqual([
      "reasoning",
      "reasoning",
      "toolCall",
      "toolCall",
    ]);
    expect(turns[0]?.items.map((item) => item.text ?? item.result?.result)).toEqual([
      "First step.",
      "Second step.",
      "first",
      "second",
    ]);
  });

  test("drops a late aggregate reasoning replay item that only repeats earlier reasoning", () => {
    const turns = projectThreadTurnsFromJournal([
      {
        threadId: "thread-1",
        seq: 1,
        ts: "2026-03-22T15:39:39.127Z",
        eventType: "turn/started",
        turnId: "turn-1",
        itemId: null,
        requestId: null,
        payload: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "inProgress", items: [] },
        },
      },
      {
        threadId: "thread-1",
        seq: 2,
        ts: "2026-03-22T15:39:41.772Z",
        eventType: "item/completed",
        turnId: "turn-1",
        itemId: "reasoning-1",
        requestId: null,
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "reasoning-1", type: "reasoning", mode: "reasoning", text: "First step." },
        },
      },
      {
        threadId: "thread-1",
        seq: 3,
        ts: "2026-03-22T15:39:41.773Z",
        eventType: "item/completed",
        turnId: "turn-1",
        itemId: "reasoning-2",
        requestId: null,
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "reasoning-2", type: "reasoning", mode: "reasoning", text: "Second step." },
        },
      },
      {
        threadId: "thread-1",
        seq: 4,
        ts: "2026-03-22T15:39:41.774Z",
        eventType: "item/completed",
        turnId: "turn-1",
        itemId: "assistant-1",
        requestId: null,
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "assistant-1", type: "agentMessage", text: "Final answer." },
        },
      },
      {
        threadId: "thread-1",
        seq: 5,
        ts: "2026-03-22T15:39:41.775Z",
        eventType: "item/completed",
        turnId: "turn-1",
        itemId: "reasoning-3",
        requestId: null,
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "reasoning-3",
            type: "reasoning",
            mode: "reasoning",
            text: "First step.\n\nSecond step.",
          },
        },
      },
    ] as any);

    expect(turns).toEqual([
      {
        id: "turn-1",
        status: "inProgress",
        items: [
          { id: "reasoning-1", type: "reasoning", mode: "reasoning", text: "First step." },
          { id: "reasoning-2", type: "reasoning", mode: "reasoning", text: "Second step." },
          { id: "assistant-1", type: "agentMessage", text: "Final answer." },
        ],
      },
    ]);
  });

  test("drops cumulative assistant duplicates that only differ by leading boundary whitespace", () => {
    const turns = projectThreadTurnsFromJournal([
      {
        threadId: "thread-1",
        seq: 1,
        ts: "2026-03-22T15:39:39.127Z",
        eventType: "turn/started",
        turnId: "turn-1",
        itemId: null,
        requestId: null,
        payload: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "inProgress", items: [] },
        },
      },
      {
        threadId: "thread-1",
        seq: 2,
        ts: "2026-03-22T15:39:41.772Z",
        eventType: "item/completed",
        turnId: "turn-1",
        itemId: "assistant-1",
        requestId: null,
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "assistant-1", type: "agentMessage", text: "\n\nFinal answer." },
        },
      },
      {
        threadId: "thread-1",
        seq: 3,
        ts: "2026-03-22T15:39:41.773Z",
        eventType: "item/completed",
        turnId: "turn-1",
        itemId: "assistant-2",
        requestId: null,
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "assistant-2", type: "agentMessage", text: "Final answer." },
        },
      },
    ] as any);

    expect(turns).toEqual([
      {
        id: "turn-1",
        status: "inProgress",
        items: [
          { id: "assistant-1", type: "agentMessage", text: "\n\nFinal answer." },
        ],
      },
    ]);
  });
});
