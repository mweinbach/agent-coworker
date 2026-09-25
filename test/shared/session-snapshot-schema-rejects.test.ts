import { describe, expect, test } from "bun:test";

import { sessionSnapshotSchema } from "../../src/shared/sessionSnapshot";
import { MAX_WORKFLOW_ERROR_TEXT_CHARS } from "../../src/shared/workflows";

function rejects(value: unknown) {
  expect(sessionSnapshotSchema.safeParse(value).success).toBe(false);
}

function minimalSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    title: "Session",
    titleSource: "default",
    titleModel: null,
    provider: "openai",
    model: "gpt-5.4",
    sessionKind: "root",
    parentSessionId: null,
    role: null,
    mode: null,
    depth: null,
    nickname: null,
    taskType: null,
    targetPaths: null,
    profile: null,
    requestedModel: null,
    effectiveModel: null,
    requestedReasoningEffort: null,
    effectiveReasoningEffort: null,
    executionState: null,
    lastMessagePreview: null,
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    messageCount: 0,
    lastEventSeq: 0,
    feed: [],
    agents: [],
    todos: [],
    sessionUsage: null,
    lastTurnUsage: null,
    hasPendingAsk: false,
    hasPendingApproval: false,
    ...overrides,
  };
}

describe("session snapshot schema rejects", () => {
  test("accepts a minimal snapshot and defaults missing workflowRuns", () => {
    const parsed = sessionSnapshotSchema.parse(minimalSnapshot());
    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.workflowRuns).toEqual([]);
    expect(parsed.profile).toBeNull();
  });

  test("rejects extras, blank identities, unknown enums, and negative counters", () => {
    rejects(minimalSnapshot({ extra: true }));
    rejects(minimalSnapshot({ sessionId: "   " }));
    rejects(minimalSnapshot({ model: "   " }));
    rejects(minimalSnapshot({ provider: "chatgpt" }));
    rejects(minimalSnapshot({ sessionKind: "research" }));
    rejects(minimalSnapshot({ titleSource: "imported" }));
    rejects(minimalSnapshot({ executionState: "waiting" }));
    rejects(minimalSnapshot({ messageCount: -1 }));
    rejects(minimalSnapshot({ lastEventSeq: 1.5 }));
    rejects(minimalSnapshot({ createdAt: " 2026-09-12T00:00:00.000Z " }));
    rejects(minimalSnapshot({ parentSessionId: "   " }));
  });

  test("rejects malformed feed items before hydration", () => {
    rejects(
      minimalSnapshot({
        feed: [{ id: "   ", kind: "system", ts: "2026-09-12T00:00:00.000Z", line: "x" }],
      }),
    );
    rejects(
      minimalSnapshot({
        feed: [{ id: "m1", kind: "note", ts: "2026-09-12T00:00:00.000Z", text: "hi" }],
      }),
    );
    rejects(
      minimalSnapshot({
        feed: [
          {
            id: "m1",
            kind: "message",
            role: "user",
            ts: "2026-09-12T00:00:00.000Z",
            text: "hi",
            extra: true,
          },
        ],
      }),
    );
    rejects(
      minimalSnapshot({
        feed: [
          {
            id: "t1",
            kind: "tool",
            ts: "2026-09-12T00:00:00.000Z",
            name: "bash",
            state: "running",
          },
        ],
      }),
    );
    rejects(
      minimalSnapshot({
        feed: [
          {
            id: "t1",
            kind: "tool",
            ts: "2026-09-12T00:00:00.000Z",
            name: "bash",
            state: "output-error",
            retryOf: "   ",
          },
        ],
      }),
    );
    rejects(
      minimalSnapshot({
        feed: [
          {
            id: "e1",
            kind: "error",
            ts: "2026-09-12T00:00:00.000Z",
            message: "locked",
            code: "not_a_code",
            source: "session",
          },
        ],
      }),
    );
    rejects(
      minimalSnapshot({
        feed: [
          {
            id: "e1",
            kind: "error",
            ts: "2026-09-12T00:00:00.000Z",
            message: "locked",
            code: "task_locked",
            source: "session",
            data: {
              category: "task_locked",
              source: "session",
              lockKind: "terminal_task_thread",
              taskId: "task-1",
              taskStatus: "working",
            },
          },
        ],
      }),
    );
  });

  test("rejects invalid persisted workflow runs", () => {
    const validRun = {
      runId: "wf_1",
      name: "workflow",
      phases: ["main"],
      currentPhase: "main",
      agents: [],
      logs: [],
      spentUsd: 0,
    };
    expect(
      sessionSnapshotSchema.parse(minimalSnapshot({ workflowRuns: [validRun] })).workflowRuns,
    ).toEqual([validRun]);
    rejects(minimalSnapshot({ workflowRuns: [{ ...validRun, runId: "   " }] }));
    rejects(minimalSnapshot({ workflowRuns: [{ ...validRun, extra: true }] }));
    rejects(minimalSnapshot({ workflowRuns: [{ ...validRun, outcome: "running" }] }));
    rejects(
      minimalSnapshot({
        workflowRuns: [{ ...validRun, error: "x".repeat(MAX_WORKFLOW_ERROR_TEXT_CHARS + 1) }],
      }),
    );
    rejects(
      minimalSnapshot({
        workflowRuns: [
          {
            ...validRun,
            agents: [
              {
                index: -1,
                label: "main",
                phase: "main",
                state: "queued",
                agentId: null,
                usdCost: null,
              },
            ],
          },
        ],
      }),
    );
  });
});
