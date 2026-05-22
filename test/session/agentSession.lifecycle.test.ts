import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TodoItem } from "./agentSession.harness";
import {
  AgentSession,
  ASK_SKIP_TOKEN,
  createExperimentalA2uiSurfaceManager,
  createRuntime,
  defaultSupportedModel,
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

  describe("reset", () => {
    test("clears messages array (subsequent send starts fresh)", async () => {
      const { session } = makeSession();
      await session.sendUserMessage("first");
      session.reset();
      await session.sendUserMessage("second");
      const lastCall = mockRunTurn.mock.calls[1][0] as any;
      expect(lastCall.messages).toHaveLength(1);
      expect(lastCall.messages[0].content).toBe("second");
    });

    test("clears persisted OpenAI continuation state", () => {
      const { session } = makeSession();
      (session as any).state.providerState = {
        provider: "openai",
        model: "gpt-5.2",
        responseId: "resp_123",
        updatedAt: "2026-02-16T00:00:00.000Z",
      };

      session.reset();

      expect((session as any).state.providerState).toBeNull();
    });

    test("emits reset_done when idle", () => {
      const { session, events } = makeSession();
      session.reset();
      const doneEvt = events.find((e) => e.type === "reset_done") as any;
      expect(doneEvt).toBeDefined();
      expect(doneEvt.sessionId).toBe(session.id);
    });

    test("reset while running emits error and does not clear messages", async () => {
      const { session, events } = makeSession();

      let resolveRunTurn!: () => void;
      mockRunTurn.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRunTurn = () =>
              resolve({
                text: "",
                reasoningText: undefined,
                responseMessages: [{ role: "assistant", content: "ok" }],
              });
          }),
      );

      const first = session.sendUserMessage("first");
      await new Promise((r) => setTimeout(r, 10));

      session.reset();
      const errEvt = events.find((e) => e.type === "error") as any;
      expect(errEvt).toBeDefined();
      expect(errEvt.message).toBe("Agent is busy");

      resolveRunTurn();
      await first;

      mockRunTurn.mockImplementationOnce(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [],
      }));
      await session.sendUserMessage("second");
      const secondCall = mockRunTurn.mock.calls[1][0] as any;
      expect(secondCall.messages).toHaveLength(3);
      expect(secondCall.messages[0]).toEqual({ role: "user", content: "first" });
      expect(secondCall.messages[1]).toEqual({ role: "assistant", content: "ok" });
      expect(secondCall.messages[2]).toEqual({ role: "user", content: "second" });
    });

    test("clears todos array", () => {
      const { session, events } = makeSession();
      session.reset();
      const todosEvt = events.find((e) => e.type === "todos") as any;
      expect(todosEvt.todos).toEqual([]);
    });

    test("emits todos event with empty array", () => {
      const { session, events } = makeSession();
      session.reset();
      const todosEvents = events.filter((e) => e.type === "todos");
      expect(todosEvents).toHaveLength(1);
      expect((todosEvents[0] as any).todos).toEqual([]);
    });

    test("emitted todos event contains the session id", () => {
      const { session, events } = makeSession();
      session.reset();
      const todosEvt = events.find((e) => e.type === "todos") as any;
      expect(todosEvt.sessionId).toBe(session.id);
    });

    test("can be called multiple times without error", () => {
      const { session } = makeSession();
      expect(() => {
        session.reset();
        session.reset();
        session.reset();
      }).not.toThrow();
    });
  });

  // =========================================================================
  // handleAskResponse
  // =========================================================================

  describe("handleAskResponse", () => {
    test("resolves pending deferred promise with the provided answer", async () => {
      const { session, events } = makeSession();

      mockRunTurn.mockImplementation(async (params: any) => {
        const answer = await params.askUser("What is your name?");
        return { text: answer, reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const askEvt = events.find((e) => e.type === "ask") as any;
      expect(askEvt).toBeDefined();
      expect(askEvt.question).toBe("What is your name?");

      session.handleAskResponse(askEvt.requestId, "Alice");
      await sendPromise;

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("Alice");
    });

    test("rejects blank ask answers, emits validation error, and replays same ask request", async () => {
      const { session, events } = makeSession();

      mockRunTurn.mockImplementation(async (params: any) => {
        const answer = await params.askUser("What should I do?");
        return { text: answer, reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const firstAsk = events.find((e) => e.type === "ask") as any;
      expect(firstAsk).toBeDefined();

      let settled = false;
      void sendPromise.then(() => {
        settled = true;
      });

      session.handleAskResponse(firstAsk.requestId, "   ");
      await new Promise((r) => setTimeout(r, 10));

      expect(settled).toBe(false);

      const errorEvt = events.find((e) => e.type === "error") as any;
      expect(errorEvt).toBeDefined();
      expect(errorEvt.code).toBe("validation_failed");
      expect(errorEvt.source).toBe("session");
      expect(errorEvt.message).toContain("cannot be empty");

      const askEvents = events.filter((e) => e.type === "ask") as any[];
      expect(askEvents.length).toBeGreaterThanOrEqual(2);
      expect(askEvents[1]?.requestId).toBe(firstAsk.requestId);

      session.handleAskResponse(firstAsk.requestId, "Proceed");
      await sendPromise;

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("Proceed");
    });

    test("accepts explicit ask skip token", async () => {
      const { session, events } = makeSession();

      mockRunTurn.mockImplementation(async (params: any) => {
        const answer = await params.askUser("Continue?");
        return { text: answer, reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const askEvt = events.find((e) => e.type === "ask") as any;
      expect(askEvt).toBeDefined();

      session.handleAskResponse(askEvt.requestId, ASK_SKIP_TOKEN);
      await sendPromise;

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe(ASK_SKIP_TOKEN);

      const validationErrors = events.filter(
        (e) => e.type === "error" && (e as any).code === "validation_failed",
      );
      expect(validationErrors.length).toBe(0);
    });

    test("removes request from pending map after resolution", async () => {
      const { session, events } = makeSession();

      mockRunTurn.mockImplementation(async (params: any) => {
        const answer = await params.askUser("question?");
        return { text: answer, reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const askEvt = events.find((e) => e.type === "ask") as any;
      session.handleAskResponse(askEvt.requestId, "answer");

      session.handleAskResponse(askEvt.requestId, "other");
      const warnEvt = events.findLast((evt) => evt.type === "log");
      expect(warnEvt).toMatchObject({
        type: "log",
        line: `[warn] ask_response for unknown requestId: ${askEvt.requestId}`,
      });
      await sendPromise;
    });

    test("logs and ignores unknown requestId", () => {
      const { session, events } = makeSession();
      session.handleAskResponse("nonexistent-id", "test");
      expect(events).toContainEqual({
        type: "log",
        sessionId: (session as any).id,
        line: "[warn] ask_response for unknown requestId: nonexistent-id",
      });
    });

    test("logs and ignores empty requestId", () => {
      const { session, events } = makeSession();
      session.handleAskResponse("", "test");
      expect(events).toContainEqual({
        type: "log",
        sessionId: (session as any).id,
        line: "[warn] ask_response for unknown requestId: ",
      });
    });

    test("cleans pending ask replay cache when prompt wait rejects", async () => {
      const { session, events } = makeSession();
      const sessionAny = session as any;
      sessionAny.waitForPromptResponse = mock(async () => {
        throw new Error("Ask prompt timed out waiting for user response.");
      });

      mockRunTurn.mockImplementation(async (params: any) => {
        await params.askUser("question?").catch(() => {});
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      await session.sendUserMessage("go");

      const askEvt = events.find((e) => e.type === "ask");
      expect(askEvt).toBeDefined();
      expect(sessionAny.interactionManager.pendingAskEventsForReplay.size).toBe(0);
    });

    test("keeps the projector pending ask flag in sync after resolution", async () => {
      const { session, events } = makeSession();
      const sessionAny = session as any;

      mockRunTurn.mockImplementation(async (params: any) => {
        const answer = await params.askUser("question?");
        return { text: answer, reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const askEvt = events.find((e) => e.type === "ask") as any;
      expect(askEvt).toBeDefined();
      expect(sessionAny.sessionSnapshotProjector.getSnapshot().hasPendingAsk).toBe(true);

      session.handleAskResponse(askEvt.requestId, "answer");
      await sendPromise;

      expect(sessionAny.sessionSnapshotProjector.getSnapshot().hasPendingAsk).toBe(false);
    });
  });

  // =========================================================================
  // handleApprovalResponse
  // =========================================================================

  describe("handleApprovalResponse", () => {
    test("resolves pending deferred promise with approved=true", async () => {
      const { session, events } = makeSession();

      mockRunTurn.mockImplementation(async (params: any) => {
        const approved = await params.approveCommand("npm install");
        return {
          text: approved ? "approved" : "denied",
          reasoningText: undefined,
          responseMessages: [],
        };
      });

      const sendPromise = session.sendUserMessage("install deps");
      await new Promise((r) => setTimeout(r, 10));

      const approvalEvt = events.find((e) => e.type === "approval") as any;
      expect(approvalEvt).toBeDefined();
      expect(approvalEvt.command).toBe("npm install");
      expect(approvalEvt.reasonCode).toBe("requires_manual_review");

      session.handleApprovalResponse(approvalEvt.requestId, true);
      await sendPromise;

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt.text).toBe("approved");
    });

    test("resolves pending deferred promise with approved=false", async () => {
      const { session, events } = makeSession();

      mockRunTurn.mockImplementation(async (params: any) => {
        const approved = await params.approveCommand("npm install");
        return {
          text: approved ? "approved" : "denied",
          reasoningText: undefined,
          responseMessages: [],
        };
      });

      const sendPromise = session.sendUserMessage("install deps");
      await new Promise((r) => setTimeout(r, 10));

      const approvalEvt = events.find((e) => e.type === "approval") as any;
      session.handleApprovalResponse(approvalEvt.requestId, false);
      await sendPromise;

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt.text).toBe("denied");
    });

    test("removes request from pending map after resolution", async () => {
      const { session, events } = makeSession();

      mockRunTurn.mockImplementation(async (params: any) => {
        await params.approveCommand("npm install");
        return { text: "done", reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const approvalEvt = events.find((e) => e.type === "approval") as any;
      session.handleApprovalResponse(approvalEvt.requestId, true);

      session.handleApprovalResponse(approvalEvt.requestId, false);
      const warnEvt = events.findLast((evt) => evt.type === "log");
      expect(warnEvt).toMatchObject({
        type: "log",
        line: `[warn] approval_response for unknown requestId: ${approvalEvt.requestId}`,
      });
      await sendPromise;
    });

    test("logs and ignores unknown requestId", () => {
      const { session, events } = makeSession();
      session.handleApprovalResponse("nonexistent-id", true);
      expect(events).toContainEqual({
        type: "log",
        sessionId: (session as any).id,
        line: "[warn] approval_response for unknown requestId: nonexistent-id",
      });
    });

    test("logs and ignores empty requestId", () => {
      const { session, events } = makeSession();
      session.handleApprovalResponse("", false);
      expect(events).toContainEqual({
        type: "log",
        sessionId: (session as any).id,
        line: "[warn] approval_response for unknown requestId: ",
      });
    });

    test("cleans pending approval replay cache when prompt wait rejects", async () => {
      const { session, events } = makeSession();
      const sessionAny = session as any;
      sessionAny.waitForPromptResponse = mock(async () => {
        throw new Error("Command approval timed out waiting for user response.");
      });

      mockRunTurn.mockImplementation(async (params: any) => {
        await params.approveCommand("npm install").catch(() => {});
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      await session.sendUserMessage("go");

      const approvalEvt = events.find((e) => e.type === "approval");
      expect(approvalEvt).toBeDefined();
      expect(sessionAny.interactionManager.pendingApprovalEventsForReplay.size).toBe(0);
    });

    test("keeps the projector pending approval flag in sync after resolution", async () => {
      const { session, events } = makeSession();
      const sessionAny = session as any;

      mockRunTurn.mockImplementation(async (params: any) => {
        const approved = await params.approveCommand("npm install");
        return {
          text: approved ? "approved" : "denied",
          reasoningText: undefined,
          responseMessages: [],
        };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const approvalEvt = events.find((e) => e.type === "approval") as any;
      expect(approvalEvt).toBeDefined();
      expect(sessionAny.sessionSnapshotProjector.getSnapshot().hasPendingApproval).toBe(true);

      session.handleApprovalResponse(approvalEvt.requestId, true);
      await sendPromise;

      expect(sessionAny.sessionSnapshotProjector.getSnapshot().hasPendingApproval).toBe(false);
    });

    test("marks dangerous commands in the approval event", async () => {
      const { session, events } = makeSession();

      mockRunTurn.mockImplementation(async (params: any) => {
        await params.approveCommand("rm -rf /");
        return { text: "done", reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const approvalEvt = events.find((e) => e.type === "approval") as any;
      expect(approvalEvt).toBeDefined();
      expect(approvalEvt.dangerous).toBe(true);
      expect(approvalEvt.reasonCode).toBe("matches_dangerous_pattern");

      session.handleApprovalResponse(approvalEvt.requestId, true);
      await sendPromise;
    });

    test("marks outside-scope absolute paths with outside_allowed_scope", async () => {
      const { session, events } = makeSession();

      mockRunTurn.mockImplementation(async (params: any) => {
        await params.approveCommand("ls /etc");
        return { text: "done", reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const approvalEvt = events.find((e) => e.type === "approval") as any;
      expect(approvalEvt).toBeDefined();
      expect(approvalEvt.dangerous).toBe(false);
      expect(approvalEvt.reasonCode).toBe("outside_allowed_scope");

      session.handleApprovalResponse(approvalEvt.requestId, true);
      await sendPromise;
    });

    test("auto-approved commands skip the approval flow entirely", async () => {
      const { session, events } = makeSession();

      mockRunTurn.mockImplementation(async (params: any) => {
        const approved = await params.approveCommand("ls -la");
        return {
          text: approved ? "auto-approved" : "denied",
          reasoningText: undefined,
          responseMessages: [],
        };
      });

      await session.sendUserMessage("list files");

      const approvalEvt = events.find((e) => e.type === "approval");
      expect(approvalEvt).toBeUndefined();

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt.text).toBe("auto-approved");
    });

    test("yolo mode skips approval flow even for dangerous commands", async () => {
      const { session, events } = makeSession({ yolo: true });

      mockRunTurn.mockImplementation(async (params: any) => {
        const approved = await params.approveCommand("rm -rf /tmp/whatever");
        return {
          text: approved ? "approved" : "denied",
          reasoningText: undefined,
          responseMessages: [],
        };
      });

      await session.sendUserMessage("go");

      const approvalEvt = events.find((e) => e.type === "approval");
      expect(approvalEvt).toBeUndefined();

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt.text).toBe("approved");
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe("dispose", () => {
    test("rejects all pending ask requests", async () => {
      const { session } = makeSession();

      let askPromise!: Promise<string>;
      mockRunTurn.mockImplementation(async (params: any) => {
        askPromise = params.askUser("question?");
        try {
          await askPromise;
        } catch {
          // expected
        }
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      session.dispose("shutting down");

      await expect(askPromise).rejects.toThrow("Session disposed (shutting down)");
      await sendPromise;
    });

    test("rejects all pending approval requests", async () => {
      const { session } = makeSession();

      let approvalPromise!: Promise<boolean>;
      mockRunTurn.mockImplementation(async (params: any) => {
        approvalPromise = params.approveCommand("npm install");
        try {
          await approvalPromise;
        } catch {
          // expected
        }
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      session.dispose("cleanup");

      await expect(approvalPromise).rejects.toThrow("Session disposed (cleanup)");
      await sendPromise;
    });

    test("includes reason in error message", async () => {
      const { session } = makeSession();

      let askPromise!: Promise<string>;
      mockRunTurn.mockImplementation(async (params: any) => {
        askPromise = params.askUser("q?");
        try {
          await askPromise;
        } catch {
          // expected
        }
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      session.dispose("user disconnected");
      await expect(askPromise).rejects.toThrow("user disconnected");
      await sendPromise;
    });

    test("handles being called multiple times without error", () => {
      const { session } = makeSession();
      expect(() => {
        session.dispose("first");
        session.dispose("second");
        session.dispose("third");
      }).not.toThrow();
    });

    test("handles dispose when no pending requests exist", () => {
      const { session } = makeSession();
      expect(() => session.dispose("no-op")).not.toThrow();
    });

    test("dispose calls close on mcpManager if it was initialized", () => {
      const { session } = makeSession();
      const mcpManager = (session as any).getMcpManager();
      const closeSpy = mock(() => {});
      mcpManager.close = closeSpy;

      session.dispose("test");

      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    test("dispose calls closePooledCodexAppServerClient if provider is codex-cli", () => {
      const config = makeConfig("/tmp/test-session");
      config.provider = "codex-cli";
      const { session } = makeSession({ config });

      session.dispose("test");

      expect(mockClosePooledCodexAppServerClient).toHaveBeenCalledTimes(1);
    });

    test("rejects both ask and approval requests simultaneously", async () => {
      const { session } = makeSession();

      let askPromise!: Promise<string>;
      let approvalPromise!: Promise<boolean>;

      mockRunTurn.mockImplementation(async (params: any) => {
        askPromise = params.askUser("ask?");
        approvalPromise = params.approveCommand("npm install");
        try {
          await Promise.all([askPromise, approvalPromise]);
        } catch {
          // expected
        }
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      session.dispose("both");

      await expect(askPromise).rejects.toThrow("Session disposed");
      await expect(approvalPromise).rejects.toThrow("Session disposed");
      await sendPromise;
    });
  });

  // =========================================================================
  // sendUserMessage
  // =========================================================================
});
