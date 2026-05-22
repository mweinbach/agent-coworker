import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TodoItem } from "./agentSession.harness";
import {
  AgentSession,
  ASK_SKIP_TOKEN,
  createExperimentalA2uiSurfaceManager,
  createRuntime,
  defaultSupportedModel,
  deriveA2uiSurfacesFromSnapshot,
  flushAsyncWork,
  fs,
  getSupportedModel,
  isRecord,
  MAX_ATTACHMENT_BASE64_SIZE,
  MAX_ATTACHMENT_INLINE_BYTE_SIZE,
  MAX_TURN_ATTACHMENT_COUNT,
  MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE,
  makeConfig,
  makeEmit,
  makeSession,
  makeSessionBackupFactory,
  mockClosePooledCodexAppServerClient,
  mockConnectModelProvider,
  mockGenerateSessionTitle,
  mockGetAiCoworkerPaths,
  mockRunTurn,
  mockWritePersistedSessionSnapshot,
  os,
  path,
  REAL_AGENT,
  resetAgentSessionMocks,
  SessionCostTracker,
  waitForCondition,
  withEnv,
} from "./agentSession.harness";

describe("AgentSession", () => {
  beforeEach(async () => {
    await resetAgentSessionMocks();
  });

  afterAll(() => {
    mock.module("../../src/agent", () => REAL_AGENT);
    mock.restore();
  });

  describe("Token usage passthrough", () => {
    test("emits turn_usage event when runTurn returns usage", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "done",
        reasoningText: undefined,
        responseMessages: [],
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          cachedPromptTokens: 25,
          estimatedCostUsd: 0.1234,
        },
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const usageEvt = events.find((e) => e.type === "turn_usage") as
        | Extract<SessionEvent, { type: "turn_usage" }>
        | undefined;
      expect(usageEvt).toBeDefined();
      if (usageEvt) {
        expect(usageEvt.sessionId).toBe(session.id);
        expect(usageEvt.usage.promptTokens).toBe(100);
        expect(usageEvt.usage.completionTokens).toBe(50);
        expect(usageEvt.usage.totalTokens).toBe(150);
        expect(usageEvt.usage.cachedPromptTokens).toBe(25);
        expect(usageEvt.usage.estimatedCostUsd).toBeCloseTo(0.00018875, 10);
        expect(typeof usageEvt.turnId).toBe("string");
        expect(usageEvt.turnId.length).toBeGreaterThan(0);
      }
    });

    test("does not emit turn_usage when runTurn returns no usage", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "done",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const usageEvt = events.find((e) => e.type === "turn_usage");
      expect(usageEvt).toBeUndefined();
    });

    test("turn_usage event has matching turnId with session_busy events", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "done",
        reasoningText: undefined,
        responseMessages: [],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const busyTrue = events.find(
        (e) => e.type === "session_busy" && (e as any).busy === true,
      ) as any;
      const usageEvt = events.find((e) => e.type === "turn_usage") as any;
      expect(busyTrue).toBeDefined();
      expect(usageEvt).toBeDefined();
      expect(usageEvt.turnId).toBe(busyTrue.turnId);
    });
  });

  // =========================================================================
  // MAX_MESSAGE_HISTORY truncation
  // =========================================================================

  describe("MAX_MESSAGE_HISTORY truncation", () => {
    test("runtime messages are capped at 200 while allMessages grows unbounded", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session } = makeSession();

      // Send 205 messages (each adds 1 user message to history)
      for (let i = 0; i < 205; i++) {
        await session.sendUserMessage(`msg-${i}`);
      }

      // allMessages should hold all 205 user messages
      expect(session.messageCount).toBe(205);

      // The runtime messages passed to runTurn should be capped at 200
      const lastCall = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(lastCall.messages.length).toBe(200);
    });

    test("truncated runtime window keeps first message plus last 199", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session } = makeSession();

      for (let i = 0; i < 205; i++) {
        await session.sendUserMessage(`msg-${i}`);
      }

      const lastCall = mockRunTurn.mock.calls.at(-1)?.[0] as any;

      // First message in the window should be the very first user message ever sent
      expect(lastCall.messages[0]).toEqual({ role: "user", content: "msg-0" });

      // Last message should be the most recent
      expect(lastCall.messages[199]).toEqual({ role: "user", content: "msg-204" });

      // Second message in the window should be msg-6 (the 7th overall),
      // since first + last 199 = msg-0, msg-6..msg-204
      expect(lastCall.messages[1]).toEqual({ role: "user", content: "msg-6" });
    });

    test("messages at exactly 200 are not truncated", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session } = makeSession();

      for (let i = 0; i < 200; i++) {
        await session.sendUserMessage(`msg-${i}`);
      }

      const lastCall = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(lastCall.messages.length).toBe(200);
      expect(lastCall.messages[0]).toEqual({ role: "user", content: "msg-0" });
      expect(lastCall.messages[199]).toEqual({ role: "user", content: "msg-199" });
    });

    test("persisted snapshot keeps all messages even when runtime is truncated", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session } = makeSession();

      for (let i = 0; i < 205; i++) {
        await session.sendUserMessage(`msg-${i}`);
      }
      await flushAsyncWork();

      expect(session.messageCount).toBe(205);
      const lastPersistCall = mockWritePersistedSessionSnapshot.mock.calls.at(-1)?.[0] as any;
      expect(lastPersistCall.snapshot.context.messages.length).toBe(205);
    });

    test("truncation with response messages counts both user and assistant messages", async () => {
      let callNum = 0;
      let capturedMessagesLength = 0;
      let capturedFirstMessage: any = null;
      let capturedLastMessage: any = null;
      mockRunTurn.mockImplementation(async (params: any) => {
        callNum++;
        // Capture length at call time (before response messages mutate the array)
        capturedMessagesLength = params.messages.length;
        capturedFirstMessage = params.messages[0];
        capturedLastMessage = params.messages[params.messages.length - 1];
        return {
          text: "",
          reasoningText: undefined,
          responseMessages: [{ role: "assistant", content: `reply-${callNum}` }],
        };
      });

      const { session } = makeSession();

      // Each sendUserMessage adds 1 user msg + 1 assistant msg = 2 per call
      // After 110 calls: 220 messages total (exceeds 200)
      for (let i = 0; i < 110; i++) {
        await session.sendUserMessage(`msg-${i}`);
      }

      // Total messages: 220 (110 user + 110 assistant)
      expect(session.messageCount).toBe(220);

      // Runtime window at the time of the last runTurn call should be capped at 200
      expect(capturedMessagesLength).toBe(200);

      // First message is preserved
      expect(capturedFirstMessage).toEqual({ role: "user", content: "msg-0" });

      // Last message is the user message for the latest call
      expect(capturedLastMessage).toEqual({ role: "user", content: "msg-109" });
    });
  });

  describe("session cost tracking", () => {
    test("blocks new turns once the hard-stop budget has been exceeded", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "ok",
        reasoningText: undefined,
        responseMessages: [],
        usage: {
          promptTokens: 1_000_000,
          completionTokens: 1_000_000,
          totalTokens: 2_000_000,
        },
      }));

      const dir = "/tmp/test-session-budget";
      const { session, events } = makeSession({
        config: {
          ...makeConfig(dir),
          provider: "openai",
          model: "gpt-5.2",
          preferredChildModel: "gpt-5.2",
        },
      });

      await session.sendUserMessage("first");
      expect(mockRunTurn.mock.calls.length).toBe(1);

      const tracker = (session as any).state.costTracker;
      tracker.setBudget({ stopAtUsd: 0.001 });
      events.length = 0;

      await session.sendUserMessage("second");

      expect(mockRunTurn.mock.calls.length).toBe(1);
      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("validation_failed");
        expect(errorEvt.source).toBe("session");
        expect(errorEvt.message).toContain("hard-stop budget");
      }
      expect(events.some((e) => e.type === "user_message")).toBe(false);
    });

    test("allows direct budget updates to recover after a hard-stop lockout", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "ok",
        reasoningText: undefined,
        responseMessages: [],
        usage: {
          promptTokens: 1_000_000,
          completionTokens: 1_000_000,
          totalTokens: 2_000_000,
        },
      }));

      const dir = "/tmp/test-session-budget-recovery";
      const { session, events } = makeSession({
        config: {
          ...makeConfig(dir),
          provider: "openai",
          model: "gpt-5.2",
          preferredChildModel: "gpt-5.2",
        },
      });

      await session.sendUserMessage("first");
      const tracker = (session as any).state.costTracker;
      tracker.setBudget({ stopAtUsd: 0.001 });

      events.length = 0;
      session.setSessionUsageBudget(20, null);

      const usageEvt = events.find((e) => e.type === "session_usage") as
        | Extract<SessionEvent, { type: "session_usage" }>
        | undefined;
      expect(usageEvt).toBeDefined();
      if (usageEvt?.usage) {
        expect(usageEvt.usage.budgetStatus.stopAtUsd).toBeNull();
        expect(usageEvt.usage.budgetStatus.warnAtUsd).toBe(20);
      }

      events.length = 0;
      await session.sendUserMessage("second");

      expect(mockRunTurn.mock.calls.length).toBe(2);
      expect(events.some((e) => e.type === "user_message")).toBe(true);
    });

    test("emits compact session_usage snapshots after completed turns", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "ok",
        reasoningText: undefined,
        responseMessages: [],
        usage: {
          promptTokens: 1000,
          completionTokens: 100,
          totalTokens: 1100,
        },
      }));

      const { session, events } = makeSession({
        config: {
          ...makeConfig("/tmp/test-session-compact-usage"),
          provider: "openai",
          model: "gpt-5.2",
          preferredChildModel: "gpt-5.2",
        },
      });

      for (let i = 0; i < 10; i += 1) {
        await session.sendUserMessage(`turn ${i + 1}`);
      }

      const usageEvt = events.findLast((e) => e.type === "session_usage") as
        | Extract<SessionEvent, { type: "session_usage" }>
        | undefined;
      expect(usageEvt).toBeDefined();
      expect(usageEvt?.usage?.totalTurns).toBe(10);
      expect(usageEvt?.usage?.turns).toHaveLength(8);
      expect(usageEvt?.usage?.turns[0]?.turnId).toBeDefined();
      expect(usageEvt?.usage?.turns.at(-1)?.turnId).toBeDefined();
    });

    test("emits proactive budget alert events when a turn crosses warning and stop thresholds", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "ok",
        reasoningText: undefined,
        responseMessages: [],
        usage: {
          promptTokens: 1_000_000,
          completionTokens: 1_000_000,
          totalTokens: 2_000_000,
        },
      }));

      const { session, events } = makeSession({
        config: {
          ...makeConfig("/tmp/test-session-budget-alerts"),
          provider: "openai",
          model: "gpt-5.2",
          preferredChildModel: "gpt-5.2",
        },
      });

      session.setSessionUsageBudget(1, 2);
      events.length = 0;

      await session.sendUserMessage("first");

      const warningEvt = events.find((e) => e.type === "budget_warning") as
        | Extract<SessionEvent, { type: "budget_warning" }>
        | undefined;
      expect(warningEvt).toBeDefined();
      expect(warningEvt?.currentCostUsd).toBe(15.75);
      expect(warningEvt?.thresholdUsd).toBe(1);

      const exceededEvt = events.find((e) => e.type === "budget_exceeded") as
        | Extract<SessionEvent, { type: "budget_exceeded" }>
        | undefined;
      expect(exceededEvt).toBeDefined();
      expect(exceededEvt?.currentCostUsd).toBe(15.75);
      expect(exceededEvt?.thresholdUsd).toBe(2);

      const costLogs = events
        .filter((e): e is Extract<SessionEvent, { type: "log" }> => e.type === "log")
        .map((e) => e.line);
      expect(costLogs.some((line) => line.includes("Budget warning"))).toBe(true);
      expect(costLogs.some((line) => line.includes("Budget exceeded"))).toBe(true);
    });

    test("persists usage budget updates immediately", async () => {
      const { session } = makeSession();
      const persistedReasons: string[] = [];
      (session as any).persistenceManager.queuePersistSessionSnapshot = (reason: string) => {
        persistedReasons.push(reason);
      };

      session.setSessionUsageBudget(2, 5);

      expect(persistedReasons).toEqual(["session.usage_budget_updated"]);
    });

    test("preserves unspecified budget thresholds when updating session usage budget", async () => {
      const { session, events } = makeSession();
      const tracker = (session as any).state.costTracker as SessionCostTracker;
      tracker.updateBudget({ warnAtUsd: 2, stopAtUsd: 5 });

      session.setSessionUsageBudget(undefined, null);

      const usageEvt = events.find((e) => e.type === "session_usage") as
        | Extract<SessionEvent, { type: "session_usage" }>
        | undefined;
      expect(usageEvt?.usage?.budgetStatus).toMatchObject({
        warnAtUsd: 2,
        stopAtUsd: null,
      });
    });

    test("rejects merged budget updates that would invalidate the existing hard stop", async () => {
      const { session, events } = makeSession();
      const tracker = (session as any).state.costTracker as SessionCostTracker;
      tracker.updateBudget({ warnAtUsd: 2, stopAtUsd: 5 });

      session.setSessionUsageBudget(6, undefined);

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toBeDefined();
      expect(errorEvt?.code).toBe("validation_failed");
      expect(errorEvt?.message).toContain(
        "Warning threshold must be less than the hard-stop threshold.",
      );

      const usageEvt = events.find((e) => e.type === "session_usage");
      expect(usageEvt).toBeUndefined();
      expect(tracker.getBudgetStatus()).toMatchObject({
        warnAtUsd: 2,
        stopAtUsd: 5,
      });
    });

    test("returns a compact session usage snapshot on explicit request after resume", () => {
      const tracker = new SessionCostTracker("persisted-session");
      for (let i = 0; i < 10; i += 1) {
        tracker.recordTurn({
          turnId: `turn-${i + 1}`,
          provider: "openai",
          model: "gpt-5.2",
          usage: {
            promptTokens: 100,
            completionTokens: 25,
            totalTokens: 125,
          },
        });
      }
      tracker.updateBudget({ warnAtUsd: 3, stopAtUsd: 6 });
      const { emit, events } = makeEmit();

      const session = AgentSession.fromPersisted({
        persisted: {
          sessionId: "persisted-session",
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Persisted",
          titleSource: "manual",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.2",
          workingDirectory: "/tmp/persisted",
          enableMcp: true,
          createdAt: "2026-03-09T00:00:00.000Z",
          updatedAt: "2026-03-09T00:00:01.000Z",
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          messageCount: 1,
          lastEventSeq: 1,
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello" }] as any,
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: tracker.getSnapshot(),
        },
        baseConfig: makeConfig("/tmp/persisted"),
        discoveredSkills: [{ name: "test-skill", description: "Test skill" }],
        emit,
        sessionBackupFactory: makeSessionBackupFactory(),
        getProviderStatusesImpl: async () => [],
      });

      session.getSessionUsage();

      const usageEvt = events.find((e) => e.type === "session_usage") as
        | Extract<SessionEvent, { type: "session_usage" }>
        | undefined;
      expect(usageEvt?.usage).toEqual(tracker.getCompactSnapshot());
      expect(usageEvt?.usage?.totalTurns).toBe(10);
      expect(usageEvt?.usage?.turns).toHaveLength(8);
      expect(usageEvt?.usage?.turns[0]?.turnId).toBe("turn-3");
      expect(usageEvt?.usage?.turns.at(-1)?.turnId).toBe("turn-10");
    });

    test("rehydrates persisted errored child sessions with an error runtime outcome", () => {
      const { emit } = makeEmit();

      const session = AgentSession.fromPersisted({
        persisted: {
          sessionId: "persisted-child-error",
          sessionKind: "agent",
          parentSessionId: "root-1",
          role: "worker",
          mode: "collaborative",
          depth: 1,
          nickname: null,
          taskType: null,
          targetPaths: null,
          requestedModel: null,
          effectiveModel: "gpt-5.2",
          requestedReasoningEffort: null,
          effectiveReasoningEffort: null,
          executionState: "errored",
          lastMessagePreview: "Task failed",
          title: "Persisted child",
          titleSource: "manual",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.2",
          workingDirectory: "/tmp/persisted",
          outputDirectory: undefined,
          uploadsDirectory: undefined,
          enableMcp: true,
          backupsEnabledOverride: null,
          createdAt: "2026-03-09T00:00:00.000Z",
          updatedAt: "2026-03-09T00:00:01.000Z",
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          messageCount: 1,
          lastEventSeq: 1,
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello" }] as any,
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
        baseConfig: makeConfig("/tmp/persisted"),
        discoveredSkills: [{ name: "test-skill", description: "Test skill" }],
        emit,
        sessionBackupFactory: makeSessionBackupFactory(),
        getProviderStatusesImpl: async () => [],
      });

      expect(session.currentTurnOutcome).toBe("error");
      expect(session.getSessionInfoEvent().executionState).toBe("errored");
    });

    test("rehydrates stale in-flight child execution states as completed when no turn is active", () => {
      for (const executionState of ["running", "pending_init"] as const) {
        const { emit } = makeEmit();

        const session = AgentSession.fromPersisted({
          persisted: {
            sessionId: `persisted-child-${executionState}`,
            sessionKind: "agent",
            parentSessionId: "root-1",
            role: "worker",
            mode: "collaborative",
            depth: 1,
            nickname: null,
            taskType: null,
            targetPaths: null,
            requestedModel: null,
            effectiveModel: "gpt-5.2",
            requestedReasoningEffort: null,
            effectiveReasoningEffort: null,
            executionState,
            lastMessagePreview: "Task was in progress",
            title: "Persisted child",
            titleSource: "manual",
            titleModel: null,
            provider: "openai",
            model: "gpt-5.2",
            workingDirectory: "/tmp/persisted",
            outputDirectory: undefined,
            uploadsDirectory: undefined,
            enableMcp: true,
            backupsEnabledOverride: null,
            createdAt: "2026-03-09T00:00:00.000Z",
            updatedAt: "2026-03-09T00:00:01.000Z",
            status: "active",
            hasPendingAsk: false,
            hasPendingApproval: false,
            messageCount: 1,
            lastEventSeq: 1,
            systemPrompt: "system",
            messages: [{ role: "user", content: "hello" }] as any,
            providerState: null,
            todos: [],
            harnessContext: null,
            costTracker: null,
          },
          baseConfig: makeConfig("/tmp/persisted"),
          emit,
          sessionBackupFactory: makeSessionBackupFactory(),
          getProviderStatusesImpl: async () => [],
        });

        expect(session.currentTurnOutcome).toBe("completed");
        expect(session.getSessionInfoEvent().executionState).toBe("completed");
      }
    });

    test("rehydrates persisted child task metadata into session info", () => {
      const { emit } = makeEmit();

      const session = AgentSession.fromPersisted({
        persisted: {
          sessionId: "persisted-child-plan",
          sessionKind: "agent",
          parentSessionId: "root-1",
          role: "worker",
          mode: "collaborative",
          depth: 1,
          nickname: "plan-auth",
          taskType: "plan",
          targetPaths: ["src/auth", "test/auth"],
          requestedModel: null,
          effectiveModel: "gpt-5.2",
          requestedReasoningEffort: null,
          effectiveReasoningEffort: null,
          executionState: "completed",
          lastMessagePreview: "Planned the auth work",
          title: "Persisted child",
          titleSource: "manual",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.2",
          workingDirectory: "/tmp/persisted",
          outputDirectory: undefined,
          uploadsDirectory: undefined,
          enableMcp: true,
          backupsEnabledOverride: null,
          createdAt: "2026-03-09T00:00:00.000Z",
          updatedAt: "2026-03-09T00:00:01.000Z",
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          messageCount: 1,
          lastEventSeq: 1,
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello" }] as any,
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
        baseConfig: makeConfig("/tmp/persisted"),
        discoveredSkills: [{ name: "test-skill", description: "Test skill" }],
        emit,
        sessionBackupFactory: makeSessionBackupFactory(),
        getProviderStatusesImpl: async () => [],
      });

      expect(session.getSessionInfoEvent()).toEqual(
        expect.objectContaining({
          nickname: "plan-auth",
          taskType: "plan",
          targetPaths: ["src/auth", "test/auth"],
        }),
      );
      expect(session.peekSessionSnapshot()).toEqual(
        expect.objectContaining({
          nickname: "plan-auth",
          taskType: "plan",
          targetPaths: ["src/auth", "test/auth"],
        }),
      );
    });

    test("rehydrates persisted A2UI surfaces so resumed actions validate against restored state", () => {
      const { emit } = makeEmit();

      const session = AgentSession.fromPersisted({
        persisted: {
          sessionId: "persisted-a2ui-session",
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Persisted A2UI",
          titleSource: "manual",
          titleModel: null,
          provider: "google",
          model: "gemini-3.1-pro-preview",
          workingDirectory: "/tmp/persisted",
          enableMcp: true,
          createdAt: "2026-03-09T00:00:00.000Z",
          updatedAt: "2026-03-09T00:00:01.000Z",
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          messageCount: 1,
          lastEventSeq: 3,
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello" }] as any,
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
        initialSessionSnapshot: {
          sessionId: "persisted-a2ui-session",
          title: "Persisted A2UI",
          titleSource: "manual",
          titleModel: null,
          provider: "google",
          model: "gemini-3.1-pro-preview",
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          mode: null,
          depth: null,
          nickname: null,
          taskType: null,
          targetPaths: null,
          requestedModel: null,
          effectiveModel: null,
          requestedReasoningEffort: null,
          effectiveReasoningEffort: null,
          executionState: null,
          lastMessagePreview: null,
          createdAt: "2026-03-09T00:00:00.000Z",
          updatedAt: "2026-03-09T00:00:01.000Z",
          messageCount: 1,
          lastEventSeq: 3,
          feed: [
            {
              id: "ui-surface-1",
              kind: "ui_surface",
              ts: "2026-03-09T00:00:01.000Z",
              surfaceId: "surface-1",
              catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json",
              version: "v0.9",
              revision: 1,
              deleted: false,
              root: {
                id: "root",
                type: "Column",
                children: [
                  {
                    id: "buy",
                    type: "Button",
                    props: { text: "Buy" },
                  },
                ],
              },
              dataModel: { qty: 1 },
              changeKind: "createSurface",
            },
          ],
          agents: [],
          todos: [],
          sessionUsage: null,
          lastTurnUsage: null,
          hasPendingAsk: false,
          hasPendingApproval: false,
        },
        baseConfig: makeConfig("/tmp/persisted", {
          provider: "google",
          model: "gemini-3.1-pro-preview",
          preferredChildModel: "gemini-3.1-pro-preview",
          enableA2ui: true,
        }),
        emit,
        sessionBackupFactory: makeSessionBackupFactory(),
        getProviderStatusesImpl: async () => [],
        createA2uiSurfaceManagerImpl: createExperimentalA2uiSurfaceManager,
        deriveA2uiSurfacesFromSnapshotImpl: deriveA2uiSurfacesFromSnapshot,
      });

      expect(session.validateA2uiAction({ surfaceId: "surface-1", componentId: "buy" })).toEqual({
        ok: true,
        surfaceId: "surface-1",
        componentId: "buy",
        componentType: "Button",
      });
    });

    test("restores persisted providerOptions into resumed runtime config", async () => {
      const { emit } = makeEmit();
      const providerOptions = {
        openai: {
          reasoningEffort: "xhigh",
          reasoningSummary: "detailed",
        },
      };

      const session = AgentSession.fromPersisted({
        persisted: {
          sessionId: "persisted-provider-options",
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Persisted",
          titleSource: "manual",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.2",
          workingDirectory: "/tmp/persisted",
          outputDirectory: undefined,
          uploadsDirectory: undefined,
          providerOptions,
          enableMcp: true,
          backupsEnabledOverride: null,
          createdAt: "2026-03-09T00:00:00.000Z",
          updatedAt: "2026-03-09T00:00:01.000Z",
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          messageCount: 1,
          lastEventSeq: 1,
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello" }] as any,
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
        baseConfig: makeConfig("/tmp/persisted"),
        discoveredSkills: [{ name: "test-skill", description: "Test skill" }],
        emit,
        sessionBackupFactory: makeSessionBackupFactory(),
        getProviderStatusesImpl: async () => [],
      });

      await session.sendUserMessage("question");

      const call = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(call.config.providerOptions).toEqual(providerOptions);
    });

    test("migrates unsupported persisted models to provider default and persists the upgraded snapshot", async () => {
      const { emit, events } = makeEmit();
      const writePersistedSessionSnapshotImpl = mock(
        async () => "/tmp/mock-home/.cowork/sessions/persisted-upgraded.json",
      );
      const persistedModel = "gpt-5.3-codex";
      const expectedModel = defaultSupportedModel("openai").id;

      const session = AgentSession.fromPersisted({
        persisted: {
          sessionId: "persisted-legacy-model",
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Legacy",
          titleSource: "manual",
          titleModel: null,
          provider: "openai",
          model: persistedModel,
          workingDirectory: "/tmp/persisted",
          enableMcp: true,
          createdAt: "2026-03-09T00:00:00.000Z",
          updatedAt: "2026-03-09T00:00:01.000Z",
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          messageCount: 1,
          lastEventSeq: 1,
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello" }] as any,
          providerState: {
            provider: "openai",
            model: persistedModel,
            responseId: "resp_legacy",
            updatedAt: "2026-03-09T00:00:01.000Z",
          },
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
        baseConfig: makeConfig("/tmp/persisted"),
        emit,
        sessionBackupFactory: makeSessionBackupFactory(),
        getProviderStatusesImpl: async () => [],
        writePersistedSessionSnapshotImpl,
      });

      expect(session.getPublicConfig().provider).toBe("openai");
      expect(session.getPublicConfig().model).toBe(expectedModel);
      expect(session.getSessionInfoEvent().model).toBe(expectedModel);

      const migrationLog = events.find(
        (event): event is Extract<SessionEvent, { type: "log" }> =>
          event.type === "log" && event.line.includes("unsupported model"),
      );
      expect(migrationLog).toBeDefined();
      expect(migrationLog?.line).toContain(`"${persistedModel}"`);
      expect(migrationLog?.line).toContain(`"${expectedModel}"`);
      expect(migrationLog?.line).toContain("Cleared saved continuation state");

      await flushAsyncWork();
      await flushAsyncWork();

      expect(writePersistedSessionSnapshotImpl).toHaveBeenCalledTimes(1);
      const persistedCall = writePersistedSessionSnapshotImpl.mock.calls[0]?.[0] as {
        snapshot: {
          session: { model: string };
          config: { model: string };
          context: { providerState: unknown };
        };
      };
      expect(persistedCall.snapshot.session.model).toBe(expectedModel);
      expect(persistedCall.snapshot.config.model).toBe(expectedModel);
      expect(persistedCall.snapshot.context.providerState).toBeNull();
    });

    test("migrates aliased persisted models to canonical ids and persists the upgraded snapshot", async () => {
      const { emit, events } = makeEmit();
      const writePersistedSessionSnapshotImpl = mock(
        async () => "/tmp/mock-home/.cowork/sessions/persisted-aliased.json",
      );
      const persistedModel = "gpt-5.1";
      const expectedModel = "gpt-5.4";

      const session = AgentSession.fromPersisted({
        persisted: {
          sessionId: "persisted-aliased-model",
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Legacy alias",
          titleSource: "manual",
          titleModel: null,
          provider: "openai",
          model: persistedModel,
          workingDirectory: "/tmp/persisted",
          enableMcp: true,
          createdAt: "2026-03-09T00:00:00.000Z",
          updatedAt: "2026-03-09T00:00:01.000Z",
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          messageCount: 1,
          lastEventSeq: 1,
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello" }] as any,
          providerState: {
            provider: "openai",
            model: persistedModel,
            responseId: "resp_alias",
            updatedAt: "2026-03-09T00:00:01.000Z",
          },
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
        baseConfig: makeConfig("/tmp/persisted"),
        emit,
        sessionBackupFactory: makeSessionBackupFactory(),
        getProviderStatusesImpl: async () => [],
        writePersistedSessionSnapshotImpl,
      });

      expect(session.getPublicConfig().provider).toBe("openai");
      expect(session.getPublicConfig().model).toBe(expectedModel);
      expect(session.getSessionInfoEvent().model).toBe(expectedModel);

      const migrationLog = events.find(
        (event): event is Extract<SessionEvent, { type: "log" }> =>
          event.type === "log" && event.line.includes("legacy model alias"),
      );
      expect(migrationLog).toBeDefined();
      expect(migrationLog?.line).toContain(`"${persistedModel}"`);
      expect(migrationLog?.line).toContain(`"${expectedModel}"`);
      expect(migrationLog?.line).toContain("Cleared saved continuation state");

      await flushAsyncWork();
      await flushAsyncWork();

      expect(writePersistedSessionSnapshotImpl).toHaveBeenCalledTimes(1);
      const persistedCall = writePersistedSessionSnapshotImpl.mock.calls[0]?.[0] as {
        snapshot: {
          session: { model: string };
          config: { model: string };
          context: { providerState: unknown };
        };
      };
      expect(persistedCall.snapshot.session.model).toBe(expectedModel);
      expect(persistedCall.snapshot.config.model).toBe(expectedModel);
      expect(persistedCall.snapshot.context.providerState).toBeNull();
    });
  });
  // =========================================================================
  // extractAssistantTextFromResponseMessages fallback
  // =========================================================================

  describe("extractAssistantTextFromResponseMessages fallback", () => {
    test("falls back to output_text parts from responseMessages when text is empty", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: [{ type: "output_text", text: "fallback text from output_text" }],
          },
        ],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("fallback text from output_text");
    });

    test("falls back to text parts from responseMessages when stream text is empty", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "fallback text from text part" }],
          },
        ],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("fallback text from text part");
    });

    test("concatenates multiple text chunks from a single assistant message", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "first chunk" },
              { type: "output_text", text: " second chunk" },
            ],
          },
        ],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("first chunk second chunk");
    });

    test("concatenates text from multiple assistant messages with double newline", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "message one" }],
          },
          {
            role: "assistant",
            content: [{ type: "output_text", text: "message two" }],
          },
        ],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("message one\n\nmessage two");
    });

    test("ignores commentary-phase assistant text in the fallback", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: [{ type: "output_text", text: "progress", phase: "commentary" }],
          },
          {
            role: "assistant",
            content: [{ type: "output_text", text: "final answer", phase: "final_answer" }],
          },
        ],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("final answer");
    });

    test("ignores non-text/non-output_text parts in the fallback", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", name: "read_file", input: {} },
              { type: "output_text", text: "actual text" },
            ],
          },
        ],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("actual text");
    });

    test("does not emit assistant_message when both text and responseMessages have no text", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", name: "bash", input: { command: "ls" } }],
          },
        ],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const assistantEvt = events.find((e) => e.type === "assistant_message");
      expect(assistantEvt).toBeUndefined();
    });

    test("prefers stream text over fallback when stream text is non-empty", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "primary stream text",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: [{ type: "output_text", text: "fallback text" }],
          },
        ],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("primary stream text");
    });

    test("falls back when text is whitespace-only", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "   \n\t  ",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: [{ type: "output_text", text: "fallback after whitespace" }],
          },
        ],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("fallback after whitespace");
    });

    test("handles string content in assistant responseMessages", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: "simple string content",
          },
        ],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("simple string content");
    });

    test("passes agentControl to root session turns when child-session callbacks exist", async () => {
      mockRunTurn.mockImplementation(async (params: any) => {
        expect(params.agentControl).toBeDefined();
        expect(typeof params.agentControl.spawn).toBe("function");
        expect(typeof params.agentControl.list).toBe("function");
        expect(typeof params.agentControl.sendInput).toBe("function");
        expect(typeof params.agentControl.wait).toBe("function");
        expect(typeof params.agentControl.close).toBe("function");
        return {
          text: "ok",
          reasoningText: undefined,
          responseMessages: [{ role: "assistant", content: "ok" }],
        };
      });

      const createAgentSessionImpl = mock(async () => ({
        sessionId: "sub-1",
        parentSessionId: "parent-1",
        role: "worker" as const,
        title: "Child",
        provider: "google" as const,
        model: "gemini-3-flash-preview",
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z",
        status: "active" as const,
        busy: true,
      }));

      const { session } = makeSession({
        createAgentSessionImpl,
        listAgentSessionsImpl: async () => [],
        sendAgentInputImpl: async () => {},
        waitForAgentImpl: async () => ({
          timedOut: false,
          mode: "any" as const,
          agents: [],
          readyAgentIds: [],
        }),
        closeAgentImpl: async () => ({
          sessionId: "sub-1",
          parentSessionId: "parent-1",
          role: "worker" as const,
          title: "Child",
          provider: "google" as const,
          model: "gemini-3-flash-preview",
          createdAt: "2026-03-08T00:00:00.000Z",
          updatedAt: "2026-03-08T00:00:00.000Z",
          status: "closed" as const,
          busy: false,
        }),
      });

      await session.sendUserMessage("go");
      expect(mockRunTurn).toHaveBeenCalledTimes(1);
    });

    test("reopens a closed session when new input arrives", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "reopened",
        reasoningText: undefined,
        responseMessages: [{ role: "assistant", content: "reopened" }],
      }));

      const { session } = makeSession();
      await session.closeForHistory();
      expect((session as any).state.persistenceStatus).toBe("closed");

      await session.sendUserMessage("reopen me");

      expect((session as any).state.persistenceStatus).toBe("active");
    });
  });
});
