import { describe, expect, test } from "bun:test";
import { sessionSnapshotSchema } from "../../src/shared/sessionSnapshot";
import { MAX_WORKFLOW_ERROR_TEXT_CHARS } from "../../src/shared/workflows";

const ts = "2026-09-12T00:00:00.000Z";
const minimalSnapshot = (overrides: Record<string, unknown> = {}) => ({
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
  createdAt: ts,
  updatedAt: ts,
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
});

const rejectsSnapshots = (overridesList: Record<string, unknown>[]) => {
  for (const overrides of overridesList) {
    expect(sessionSnapshotSchema.safeParse(minimalSnapshot(overrides)).success).toBe(false);
  }
};

describe("session snapshot schema rejects", () => {
  test("accepts a minimal snapshot and defaults missing workflowRuns", () => {
    const parsed = sessionSnapshotSchema.parse(minimalSnapshot());
    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.workflowRuns).toEqual([]);
    expect(parsed.profile).toBeNull();
  });

  test("rejects extras, blank identities, unknown enums, and negative counters", () => {
    rejectsSnapshots([
      { extra: true },
      { sessionId: "   " },
      { model: "   " },
      { provider: "chatgpt" },
      { sessionKind: "research" },
      { titleSource: "imported" },
      { executionState: "waiting" },
      { messageCount: -1 },
      { lastEventSeq: 1.5 },
      { createdAt: ` ${ts} ` },
      { parentSessionId: "   " },
    ]);
  });

  test("rejects malformed feed items before hydration", () => {
    rejectsSnapshots(
      [
        { id: "   ", kind: "system", ts, line: "x" },
        { id: "m1", kind: "note", ts, text: "hi" },
        { id: "m1", kind: "message", role: "user", ts, text: "hi", extra: true },
        { id: "t1", kind: "tool", ts, name: "bash", state: "running" },
        { id: "t1", kind: "tool", ts, name: "bash", state: "output-error", retryOf: "   " },
        { id: "e1", kind: "error", ts, message: "locked", code: "not_a_code", source: "session" },
        {
          id: "e1",
          kind: "error",
          ts,
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
      ].map((item) => ({ feed: [item] })),
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

    rejectsSnapshots(
      [
        { ...validRun, runId: "   " },
        { ...validRun, extra: true },
        { ...validRun, outcome: "running" },
        { ...validRun, error: "x".repeat(MAX_WORKFLOW_ERROR_TEXT_CHARS + 1) },
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
      ].map((run) => ({ workflowRuns: [run] })),
    );
  });
});
