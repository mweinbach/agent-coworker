import { describe, expect, mock, test } from "bun:test";

import { reduceNonProviderEvent } from "../apps/TUI/context/syncEventReducer";

type SyncState = {
  feed: unknown[];
  busy: boolean;
  todos: unknown[];
  contextUsage: unknown | null;
  providerAuthChallenge: unknown | null;
  providerAuthResult: unknown | null;
  pendingAsk: unknown | null;
  pendingApproval: unknown | null;
  backup: unknown | null;
  tools: unknown[];
  agents: unknown[];
  sessionKind: unknown;
  parentSessionId: unknown;
  role: unknown;
  mode: unknown;
  depth: number;
  nickname: unknown;
  requestedModel: unknown;
  effectiveModel: unknown;
  requestedReasoningEffort: unknown;
  effectiveReasoningEffort: unknown;
  executionState: unknown;
  lastMessagePreview: unknown;
  sessionTitle: string | null;
  provider: string;
  model: string;
};

function createDeps() {
  const state: SyncState = {
    feed: [],
    busy: true,
    todos: ["existing"],
    contextUsage: { seen: true },
    providerAuthChallenge: { id: "challenge" },
    providerAuthResult: { status: "pending" },
    pendingAsk: { requestId: "old" },
    pendingApproval: { requestId: "old" },
    backup: null,
    tools: [],
    agents: [],
    sessionKind: "root",
    parentSessionId: null,
    role: null,
    mode: null,
    depth: 0,
    nickname: null,
    requestedModel: null,
    effectiveModel: null,
    requestedReasoningEffort: null,
    effectiveReasoningEffort: null,
    executionState: null,
    lastMessagePreview: null,
    sessionTitle: null,
    provider: "",
    model: "",
  };

  const setState = (key: any, value?: any) => {
    if (typeof key === "function") {
      key(state);
      return;
    }
    if (typeof value === "function") {
      state[key] = value(state[key]);
      return;
    }
    state[key] = value;
  };

  let lastId = 0;
  const deps = {
    setState,
    nextFeedId: () => `feed-${++lastId}`,
    pendingTools: new Map<string, string[]>(),
    sentMessageIds: new Set<string>(),
    modelStreamLifecycle: {
      handleSessionBusy: mock(() => {}),
      handleChunkEvent: mock(() => {}),
      shouldSuppressAssistantMessage: mock(() => false),
      shouldSuppressReasoningMessage: mock(() => false),
      isTurnActive: mock(() => false),
      reset: mock(() => {}),
    },
    resetFeedSequence: mock(() => {
      state.feed = [];
    }),
  } as const;

  return { state, deps };
}

describe("syncEventReducer", () => {
  test("reset_done clears transient state", () => {
    const { state, deps } = createDeps();
    state.feed = [{ id: "old", type: "message" }];
    state.pendingAsk = { requestId: "ask" };
    state.pendingApproval = { requestId: "approve" };
    state.contextUsage = { tokens: 1 };

    const result = reduceNonProviderEvent({ type: "reset_done" } as any, deps as any);

    expect(result).toBe(true);
    expect(state.feed).toHaveLength(1);
    expect((state.feed[0] as any).line).toBe("conversation reset");
    expect(state.todos).toEqual([]);
    expect(state.contextUsage).toBeNull();
    expect(state.busy).toBe(false);
    expect(state.providerAuthChallenge).toBeNull();
    expect(state.providerAuthResult).toBeNull();
    expect(state.pendingAsk).toBeNull();
    expect(state.pendingApproval).toBeNull();
  });

  test("deduplicates optimistic user messages", () => {
    const { state, deps } = createDeps();
    deps.sentMessageIds.add("client-1");

    const result = reduceNonProviderEvent(
      { type: "user_message", clientMessageId: "client-1", text: "hello" } as any,
      deps as any
    );

    expect(result).toBe(true);
    expect(state.feed).toHaveLength(0);
    expect(deps.sentMessageIds.has("client-1")).toBe(false);
  });

  test("logs pair tool start and end events", () => {
    const { state, deps } = createDeps();

    reduceNonProviderEvent({ type: "log", line: "tool> example_tool {\"step\":1}" } as any, deps as any);
    expect(state.feed).toHaveLength(1);
    const runningTool = state.feed[0] as any;
    expect(runningTool.type).toBe("tool");
    expect(runningTool.status).toBe("running");
    expect(runningTool.args).toEqual({ step: 1 });

    reduceNonProviderEvent({ type: "log", line: "tool< example_tool {\"result\":\"ok\"}" } as any, deps as any);
    expect(state.feed).toHaveLength(1);
    const finishedTool = state.feed[0] as any;
    expect(finishedTool.status).toBe("done");
    expect(finishedTool.result).toEqual({ result: "ok" });
  });

  test("ask and approval events set pending states and feed entries", () => {
    const { state, deps } = createDeps();

    reduceNonProviderEvent(
      {
        type: "ask",
        requestId: "ask-1",
        question: "question: Should we proceed?",
        options: ["yes"],
      } as any,
      deps as any
    );

    expect(state.pendingAsk).toMatchObject({ requestId: "ask-1" });
    const askFeed = state.feed[state.feed.length - 1] as any;
    expect(askFeed.type).toBe("system");
    expect(askFeed.line).toContain("question:");

    reduceNonProviderEvent(
      {
        type: "approval",
        requestId: "approve-1",
        command: "rm -rf /tmp",
        dangerous: true,
        reasonCode: "danger",
      } as any,
      deps as any
    );

    expect(state.pendingApproval).toMatchObject({ requestId: "approve-1" });
    const approvalFeed = state.feed[state.feed.length - 1] as any;
    expect(approvalFeed.type).toBe("system");
    expect(approvalFeed.line).toContain("approval requested");
  });

  test("session_backup_state updates state and the feed", () => {
    const { state, deps } = createDeps();

    reduceNonProviderEvent(
      { type: "session_backup_state", backup: { id: "cp-001" }, reason: "manual" } as any,
      deps as any
    );

    expect(state.backup).toEqual({ id: "cp-001" });
    const backupFeed = state.feed[state.feed.length - 1] as any;
    expect(backupFeed.type).toBe("session_backup_state");
    expect(backupFeed.reason).toBe("manual");
  });

  test("tools normalization trims and filters entries", () => {
    const { state, deps } = createDeps();

    reduceNonProviderEvent(
      {
        type: "tools",
        tools: [
          " primary_tool ",
          { name: "secondary", description: "desc" },
          { name: "", description: "ignored" },
          { name: "fallback", description: "" },
        ],
      } as any,
      deps as any
    );

    expect(state.tools).toEqual([
      { name: "primary_tool", description: "primary_tool" },
      { name: "secondary", description: "desc" },
      { name: "fallback", description: "fallback" },
    ]);
  });

  test("agent events replace and upsert tracked child-agent summaries", () => {
    const { state, deps } = createDeps();

    reduceNonProviderEvent(
      {
        type: "agent_list",
        agents: [
          {
            agentId: "child-2",
            parentSessionId: "root-1",
            role: "research",
            mode: "collaborative",
            depth: 1,
            effectiveModel: "gpt-5.4",
            title: "Research queue",
            provider: "openai",
            createdAt: "2026-03-15T10:00:00.000Z",
            updatedAt: "2026-03-15T10:10:00.000Z",
            lifecycleState: "active",
            executionState: "completed",
            busy: false,
          },
        ],
      } as any,
      deps as any
    );

    expect(state.agents).toHaveLength(1);
    expect((state.agents[0] as any).agentId).toBe("child-2");

    reduceNonProviderEvent(
      {
        type: "agent_status",
        agent: {
          agentId: "child-1",
          parentSessionId: "root-1",
          role: "worker",
          mode: "collaborative",
          depth: 1,
          effectiveModel: "gpt-5.4-mini",
          title: "Patch worker",
          provider: "openai",
          createdAt: "2026-03-15T10:00:00.000Z",
          updatedAt: "2026-03-15T10:11:00.000Z",
          lifecycleState: "active",
          executionState: "running",
          busy: true,
        },
      } as any,
      deps as any
    );

    expect(state.agents).toHaveLength(2);
    expect((state.agents[0] as any).agentId).toBe("child-1");
    expect((state.agents[0] as any).busy).toBe(true);
  });
});
