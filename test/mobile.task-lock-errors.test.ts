import { describe, expect, test } from "bun:test";

import {
  coworkThreadReadResultSchema,
  type ProjectedItem,
  type ServerErrorData,
} from "../apps/mobile/src/features/cowork/protocolTypes";
import {
  applyProjectedCompletion,
  applyProjectedStart,
  createMobileFeedState,
} from "../apps/mobile/src/features/cowork/snapshotReducer";

const terminalLockData = {
  category: "task_locked",
  source: "session",
  lockKind: "terminal_task_thread",
  taskId: "task-completed",
  taskStatus: "completed",
} as const satisfies ServerErrorData;

const sourceChatLockData = {
  category: "task_locked",
  source: "session",
  lockKind: "active_source_chat",
  taskId: "task-working",
  taskStatus: "working",
  taskTitle: "Active task",
} as const satisfies ServerErrorData;

function projectedError(id: string, data?: ServerErrorData): ProjectedItem {
  return {
    id,
    type: "error",
    message: "Task locked",
    code: data ? "task_locked" : "validation_failed",
    source: "session",
    ...(data ? { data } : {}),
  };
}

describe("mobile task lock error protocol", () => {
  test("thread-read hydration preserves terminal and source-chat task_locked data", () => {
    const parsed = coworkThreadReadResultSchema.parse({
      thread: {
        id: "thread-1",
        title: "Task thread",
        preview: "",
        modelProvider: "google",
        model: "gemini",
        cwd: "/tmp/project",
        createdAt: "2026-06-21T09:00:00.000Z",
        updatedAt: "2026-06-21T09:00:00.000Z",
        messageCount: 2,
        lastEventSeq: 2,
        status: { type: "idle" },
        turns: [
          {
            id: "turn-1",
            status: "completed",
            items: [
              projectedError("error-terminal", terminalLockData),
              projectedError("error-source", sourceChatLockData),
            ],
          },
        ],
      },
      coworkSnapshot: {
        sessionId: "thread-1",
        title: "Task thread",
        titleSource: "manual",
        provider: "google",
        model: "gemini",
        sessionKind: "root",
        createdAt: "2026-06-21T09:00:00.000Z",
        updatedAt: "2026-06-21T09:00:00.000Z",
        messageCount: 2,
        lastEventSeq: 2,
        feed: [
          {
            id: "feed-terminal",
            kind: "error",
            ts: "2026-06-21T09:00:00.000Z",
            message: "Task locked",
            code: "task_locked",
            source: "session",
            data: terminalLockData,
          },
          {
            id: "feed-source",
            kind: "error",
            ts: "2026-06-21T09:00:01.000Z",
            message: "Task locked",
            code: "task_locked",
            source: "session",
            data: sourceChatLockData,
          },
        ],
        agents: [],
        todos: [],
        hasPendingAsk: false,
        hasPendingApproval: false,
      },
    });

    expect(parsed.thread.turns?.[0]?.items[0]).toMatchObject({ data: terminalLockData });
    expect(parsed.thread.turns?.[0]?.items[1]).toMatchObject({ data: sourceChatLockData });
    expect(parsed.coworkSnapshot?.feed[0]).toMatchObject({ data: terminalLockData });
    expect(parsed.coworkSnapshot?.feed[1]).toMatchObject({ data: sourceChatLockData });
  });

  test("live projection reducer keeps task_locked data and ordinary errors remain data-less", () => {
    const now = "2026-06-21T09:00:00.000Z";
    let state = createMobileFeedState();
    state = applyProjectedStart(state, projectedError("error-terminal", terminalLockData), now, 1);
    state = applyProjectedCompletion(
      state,
      projectedError("error-source", sourceChatLockData),
      now,
      2,
    );
    state = applyProjectedCompletion(state, projectedError("error-ordinary"), now, 3);

    expect(state.feed).toHaveLength(3);
    expect(state.feed[0]).toMatchObject({ kind: "error", data: terminalLockData });
    expect(state.feed[1]).toMatchObject({ kind: "error", data: sourceChatLockData });
    expect(state.feed[2]).toMatchObject({ kind: "error", code: "validation_failed" });
    expect("data" in state.feed[2]!).toBe(false);
  });
});
