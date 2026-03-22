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
});
