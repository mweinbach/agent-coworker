import { describe, expect, test } from "bun:test";
import { MAX_RETAINED_TERMINAL_WORKFLOW_RUNS } from "../../../src/shared/workflows";
import { extractWorkflowRunsFromTranscript } from "../src/app/store.feedMapping";
import type { AppStoreState, StoreSet } from "../src/app/store.helpers";
import { defaultThreadRuntime } from "../src/app/store.helpers/runtimeState";
import { createFeedProjectionModule } from "../src/app/store.helpers/threadEventReducer/feedProjection";
import type { SessionSnapshot, ThreadWorkflowRun, TranscriptEvent } from "../src/app/types";

const THREAD_ID = "thread-1";

function workflowRun(runId: string, outcome?: "completed"): ThreadWorkflowRun {
  return {
    runId,
    name: `Workflow ${runId}`,
    phases: [],
    currentPhase: null,
    agents: [],
    logs: [],
    spentUsd: 0,
    ...(outcome ? { outcome } : {}),
  };
}

function sessionSnapshot(workflowRuns: ThreadWorkflowRun[]): SessionSnapshot {
  return {
    sessionId: THREAD_ID,
    title: "Harness snapshot",
    titleSource: "model",
    titleModel: "gpt-5.4",
    provider: "openai",
    model: "gpt-5.4",
    sessionKind: "root",
    parentSessionId: null,
    role: null,
    mode: null,
    depth: 0,
    nickname: null,
    taskType: null,
    targetPaths: null,
    profile: null,
    requestedModel: "gpt-5.4",
    effectiveModel: "gpt-5.4",
    requestedReasoningEffort: null,
    effectiveReasoningEffort: null,
    executionState: null,
    lastMessagePreview: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:01.000Z",
    messageCount: 0,
    lastEventSeq: 0,
    feed: [],
    agents: [],
    workflowRuns,
    todos: [],
    sessionUsage: null,
    lastTurnUsage: null,
    hasPendingAsk: false,
    hasPendingApproval: false,
  };
}

function createSnapshotHarness(initialWorkflowRuns: ThreadWorkflowRun[] = []) {
  let state = {
    threads: [
      {
        id: THREAD_ID,
        workspaceId: "workspace-1",
        title: "Original title",
        createdAt: "2026-08-24T00:00:00.000Z",
        lastMessageAt: "2026-08-24T00:00:00.000Z",
        status: "active",
        sessionId: THREAD_ID,
        messageCount: 0,
        lastEventSeq: 0,
      },
    ],
    threadRuntimeById: {
      [THREAD_ID]: {
        ...defaultThreadRuntime(),
        sessionId: THREAD_ID,
        workflowRuns: initialWorkflowRuns,
      },
    },
    latestTodosByThreadId: {},
  } as AppStoreState;

  const get = () => state;
  const set: StoreSet = (update) => {
    state = {
      ...state,
      ...(typeof update === "function" ? update(state) : update),
    };
  };

  const projection = createFeedProjectionModule(
    {
      deps: {
        normalizeThreadTitleSource: () => "model",
      },
    } as never,
    { resetLiveModelStreamRuntime: () => {} },
  );

  return { get, set, projection };
}

function transcriptEvent(progress: ThreadWorkflowRun, index: number): TranscriptEvent {
  return {
    ts: new Date(Date.UTC(2026, 7, 24, 0, 0, index)).toISOString(),
    threadId: THREAD_ID,
    direction: "server",
    payload: {
      type: "workflow_progress",
      sessionId: THREAD_ID,
      progress,
    },
  };
}

describe("workflow thread reconciliation", () => {
  test("restores workflow runs from authoritative thread snapshots", () => {
    const { get, set, projection } = createSnapshotHarness();
    const persistedRun = workflowRun("persisted", "completed");

    projection.applyJsonRpcThreadSnapshot(get, set, THREAD_ID, sessionSnapshot([persistedRun]));

    expect(get().threadRuntimeById[THREAD_ID]?.workflowRuns).toEqual([persistedRun]);
  });

  test("clears stale workflow runs when a reconnect snapshot has no runs", () => {
    const { get, set, projection } = createSnapshotHarness([workflowRun("stale", "completed")]);

    projection.applyJsonRpcThreadSnapshot(get, set, THREAD_ID, sessionSnapshot([]));

    expect(get().threadRuntimeById[THREAD_ID]?.workflowRuns).toEqual([]);
  });

  test("transcript hydration preserves active runs and bounds completed history", () => {
    const activeRun = workflowRun("active");
    const terminalRuns = Array.from(
      { length: MAX_RETAINED_TERMINAL_WORKFLOW_RUNS + 2 },
      (_, index) => workflowRun(`completed-${index + 1}`, "completed"),
    );
    const events = [activeRun, ...terminalRuns].map(transcriptEvent);

    expect(extractWorkflowRunsFromTranscript(events)).toEqual([
      activeRun,
      ...terminalRuns.slice(-MAX_RETAINED_TERMINAL_WORKFLOW_RUNS),
    ]);
  });
});
