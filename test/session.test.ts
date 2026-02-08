import { describe, expect, test, mock, beforeEach } from "bun:test";
import path from "node:path";

import type { AgentConfig, TodoItem } from "../src/types";
import type { ServerEvent } from "../src/server/protocol";

// ---------------------------------------------------------------------------
// Mock runTurn before importing AgentSession (which imports ../agent)
// ---------------------------------------------------------------------------

const mockRunTurn = mock(async () => ({
  text: "",
  reasoningText: undefined as string | undefined,
  responseMessages: [] as any[],
}));

mock.module("../src/agent", () => ({
  runTurn: mockRunTurn,
}));

// Import AgentSession AFTER the mock is registered so it picks up the mock.
const { AgentSession } = await import("../src/server/session");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(dir: string): AgentConfig {
  return {
    provider: "google",
    model: "gemini-2.0-flash",
    subAgentModel: "gemini-2.0-flash",
    workingDirectory: dir,
    outputDirectory: path.join(dir, "output"),
    uploadsDirectory: path.join(dir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectAgentDir: path.join(dir, ".agent"),
    userAgentDir: path.join(dir, ".agent-user"),
    builtInDir: dir,
    builtInConfigDir: path.join(dir, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
  };
}

function makeEmit(): { emit: (evt: ServerEvent) => void; events: ServerEvent[] } {
  const events: ServerEvent[] = [];
  const emit = (event: ServerEvent) => {
    events.push(event);
  };
  return { emit, events };
}

function makeSession(overrides?: Partial<{ config: AgentConfig; system: string; emit: (evt: ServerEvent) => void }>) {
  const dir = "/tmp/test-session";
  const { emit, events } = makeEmit();
  const session = new AgentSession({
    config: overrides?.config ?? makeConfig(dir),
    system: overrides?.system ?? "You are a test assistant.",
    emit: overrides?.emit ?? emit,
  });
  return { session, emit, events };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentSession", () => {
  beforeEach(() => {
    mockRunTurn.mockReset();
    mockRunTurn.mockImplementation(async () => ({
      text: "",
      reasoningText: undefined,
      responseMessages: [],
    }));
  });

  // =========================================================================
  // Constructor / Initialization
  // =========================================================================

  describe("Constructor / Initialization", () => {
    test("generates a unique session ID", () => {
      const { session } = makeSession();
      expect(session.id).toBeDefined();
      expect(typeof session.id).toBe("string");
      expect(session.id.length).toBeGreaterThan(0);
    });

    test("session ID looks like a UUID", () => {
      const { session } = makeSession();
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(session.id).toMatch(uuidPattern);
    });

    test("different instances have different IDs", () => {
      const { session: s1 } = makeSession();
      const { session: s2 } = makeSession();
      expect(s1.id).not.toBe(s2.id);
    });

    test("ten sessions all produce unique IDs", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const { session } = makeSession();
        ids.add(session.id);
      }
      expect(ids.size).toBe(10);
    });

    test("initializes with empty messages (sendUserMessage produces no history artifacts)", async () => {
      const { session } = makeSession();
      await session.sendUserMessage("hello");
      const call = mockRunTurn.mock.calls[0][0] as any;
      expect(call.messages).toHaveLength(1);
      expect(call.messages[0]).toEqual({ role: "user", content: "hello" });
    });

    test("initializes with empty todos (reset emits empty array)", () => {
      const { session, events } = makeSession();
      session.reset();
      const todosEvt = events.find((e) => e.type === "todos") as any;
      expect(todosEvt).toBeDefined();
      expect(todosEvt.todos).toEqual([]);
    });
  });

  // =========================================================================
  // getPublicConfig
  // =========================================================================

  describe("getPublicConfig", () => {
    test("returns provider", () => {
      const { session } = makeSession();
      expect(session.getPublicConfig().provider).toBe("google");
    });

    test("returns model", () => {
      const { session } = makeSession();
      expect(session.getPublicConfig().model).toBe("gemini-2.0-flash");
    });

    test("returns workingDirectory", () => {
      const dir = "/tmp/test-session";
      const { session } = makeSession({ config: makeConfig(dir) });
      expect(session.getPublicConfig().workingDirectory).toBe(dir);
    });

    test("returns outputDirectory", () => {
      const dir = "/tmp/test-session";
      const { session } = makeSession({ config: makeConfig(dir) });
      expect(session.getPublicConfig().outputDirectory).toBe(path.join(dir, "output"));
    });

    test("returns exactly four keys", () => {
      const { session } = makeSession();
      const keys = Object.keys(session.getPublicConfig());
      expect(keys).toEqual(["provider", "model", "workingDirectory", "outputDirectory"]);
    });

    test("does not include uploadsDirectory", () => {
      const { session } = makeSession();
      const pub = session.getPublicConfig() as any;
      expect(pub.uploadsDirectory).toBeUndefined();
    });

    test("does not include providerOptions", () => {
      const dir = "/tmp/test-session";
      const cfg = { ...makeConfig(dir), providerOptions: { google: { thinkingConfig: {} } } };
      const { session } = makeSession({ config: cfg });
      const pub = session.getPublicConfig() as any;
      expect(pub.providerOptions).toBeUndefined();
    });

    test("does not include subAgentModel", () => {
      const { session } = makeSession();
      const pub = session.getPublicConfig() as any;
      expect(pub.subAgentModel).toBeUndefined();
    });

    test("does not include userName", () => {
      const { session } = makeSession();
      const pub = session.getPublicConfig() as any;
      expect(pub.userName).toBeUndefined();
    });

    test("does not include skillsDirs", () => {
      const { session } = makeSession();
      const pub = session.getPublicConfig() as any;
      expect(pub.skillsDirs).toBeUndefined();
    });
  });

  // =========================================================================
  // reset
  // =========================================================================

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

      expect(() => session.handleAskResponse(askEvt.requestId, "other")).not.toThrow();
      await sendPromise;
    });

    test("ignores unknown requestId without crashing", () => {
      const { session } = makeSession();
      expect(() => session.handleAskResponse("nonexistent-id", "test")).not.toThrow();
    });

    test("ignores empty requestId without crashing", () => {
      const { session } = makeSession();
      expect(() => session.handleAskResponse("", "test")).not.toThrow();
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
        return { text: approved ? "approved" : "denied", reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("install deps");
      await new Promise((r) => setTimeout(r, 10));

      const approvalEvt = events.find((e) => e.type === "approval") as any;
      expect(approvalEvt).toBeDefined();
      expect(approvalEvt.command).toBe("npm install");

      session.handleApprovalResponse(approvalEvt.requestId, true);
      await sendPromise;

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt.text).toBe("approved");
    });

    test("resolves pending deferred promise with approved=false", async () => {
      const { session, events } = makeSession();

      mockRunTurn.mockImplementation(async (params: any) => {
        const approved = await params.approveCommand("npm install");
        return { text: approved ? "approved" : "denied", reasoningText: undefined, responseMessages: [] };
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

      expect(() => session.handleApprovalResponse(approvalEvt.requestId, false)).not.toThrow();
      await sendPromise;
    });

    test("ignores unknown requestId without crashing", () => {
      const { session } = makeSession();
      expect(() => session.handleApprovalResponse("nonexistent-id", true)).not.toThrow();
    });

    test("ignores empty requestId without crashing", () => {
      const { session } = makeSession();
      expect(() => session.handleApprovalResponse("", false)).not.toThrow();
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

      session.handleApprovalResponse(approvalEvt.requestId, true);
      await sendPromise;
    });

    test("auto-approved commands skip the approval flow entirely", async () => {
      const { session, events } = makeSession();

      mockRunTurn.mockImplementation(async (params: any) => {
        const approved = await params.approveCommand("ls -la");
        return { text: approved ? "auto-approved" : "denied", reasoningText: undefined, responseMessages: [] };
      });

      await session.sendUserMessage("list files");

      const approvalEvt = events.find((e) => e.type === "approval");
      expect(approvalEvt).toBeUndefined();

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt.text).toBe("auto-approved");
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

  describe("sendUserMessage", () => {
    test("rejects if already running (emits error)", async () => {
      const { session, events } = makeSession();

      let resolveRunTurn!: () => void;
      mockRunTurn.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRunTurn = () => resolve({ text: "", reasoningText: undefined, responseMessages: [] });
          })
      );

      const first = session.sendUserMessage("first");
      await new Promise((r) => setTimeout(r, 10));

      await session.sendUserMessage("second");

      const errorEvt = events.find((e) => e.type === "error") as any;
      expect(errorEvt).toBeDefined();
      expect(errorEvt.message).toBe("Agent is busy");

      resolveRunTurn();
      await first;
    });

    test("sets running=true then false after completion", async () => {
      const { session, events } = makeSession();

      let wasRunningDuringExecution = false;

      mockRunTurn.mockImplementation(async () => {
        await session.sendUserMessage("concurrent");
        const busyError = events.find((e) => e.type === "error" && (e as any).message === "Agent is busy");
        wasRunningDuringExecution = busyError !== undefined;
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      await session.sendUserMessage("go");
      expect(wasRunningDuringExecution).toBe(true);

      events.length = 0;
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [],
      }));
      await session.sendUserMessage("after");
      const errorEvt = events.find((e) => e.type === "error");
      expect(errorEvt).toBeUndefined();
    });

    test("emits user_message event", async () => {
      const { session, events } = makeSession();
      await session.sendUserMessage("hello world");

      const userEvt = events.find((e) => e.type === "user_message") as any;
      expect(userEvt).toBeDefined();
      expect(userEvt.text).toBe("hello world");
      expect(userEvt.sessionId).toBe(session.id);
    });

    test("emits user_message event with clientMessageId when provided", async () => {
      const { session, events } = makeSession();
      await session.sendUserMessage("hello", "msg-123");

      const userEvt = events.find((e) => e.type === "user_message") as any;
      expect(userEvt.clientMessageId).toBe("msg-123");
    });

    test("emits user_message event without clientMessageId when not provided", async () => {
      const { session, events } = makeSession();
      await session.sendUserMessage("hello");

      const userEvt = events.find((e) => e.type === "user_message") as any;
      expect(userEvt.clientMessageId).toBeUndefined();
    });

    test("adds user message to messages array", async () => {
      const { session } = makeSession();
      await session.sendUserMessage("test message");

      const call = mockRunTurn.mock.calls[0][0] as any;
      expect(call.messages).toContainEqual({ role: "user", content: "test message" });
    });

    test("calls runTurn with config, system, messages", async () => {
      const dir = "/tmp/test-session";
      const config = makeConfig(dir);
      const { session } = makeSession({ config, system: "Be helpful." });
      await session.sendUserMessage("question");

      expect(mockRunTurn).toHaveBeenCalledTimes(1);
      const call = mockRunTurn.mock.calls[0][0] as any;
      expect(call.config).toEqual(config);
      expect(call.system).toBe("Be helpful.");
      expect(call.messages).toEqual([{ role: "user", content: "question" }]);
    });

    test("passes maxSteps=100 to runTurn", async () => {
      const { session } = makeSession();
      await session.sendUserMessage("go");

      const call = mockRunTurn.mock.calls[0][0] as any;
      expect(call.maxSteps).toBe(100);
    });

    test("passes enableMcp=false to runTurn", async () => {
      const { session } = makeSession();
      await session.sendUserMessage("go");

      const call = mockRunTurn.mock.calls[0][0] as any;
      expect(call.enableMcp).toBe(false);
    });

    test("adds response messages to history", async () => {
      const responseMsg = { role: "assistant" as const, content: "I helped!" };
      let callNum = 0;
      mockRunTurn.mockImplementation(async () => {
        callNum++;
        return {
          text: callNum === 1 ? "I helped!" : "",
          reasoningText: undefined,
          // Only return responseMessages on first call to avoid reference mutation
          responseMessages: callNum === 1 ? [responseMsg] : [],
        };
      });

      const { session } = makeSession();
      await session.sendUserMessage("first");
      await session.sendUserMessage("second");

      // After first call completes, responseMsg was pushed to messages.
      // Second call should see [user:first, responseMsg, user:second]
      const secondCall = mockRunTurn.mock.calls[1][0] as any;
      expect(secondCall.messages).toHaveLength(3);
      expect(secondCall.messages[0]).toEqual({ role: "user", content: "first" });
      expect(secondCall.messages[1]).toEqual(responseMsg);
      expect(secondCall.messages[2]).toEqual({ role: "user", content: "second" });
    });

    test("emits assistant_message when response has text", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "Here is my response.",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("hi");

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("Here is my response.");
      expect(assistantEvt.sessionId).toBe(session.id);
    });

    test("does not emit assistant_message when response text is empty", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("hi");

      const assistantEvt = events.find((e) => e.type === "assistant_message");
      expect(assistantEvt).toBeUndefined();
    });

    test("does not emit assistant_message when response text is only whitespace", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "   \n\t  ",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("hi");

      const assistantEvt = events.find((e) => e.type === "assistant_message");
      expect(assistantEvt).toBeUndefined();
    });

    test("emits reasoning event when reasoningText is present", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: "I thought about this carefully.",
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("think hard");

      const reasoningEvt = events.find((e) => e.type === "reasoning") as any;
      expect(reasoningEvt).toBeDefined();
      expect(reasoningEvt.text).toBe("I thought about this carefully.");
      expect(reasoningEvt.sessionId).toBe(session.id);
    });

    test("does not emit reasoning when reasoningText is empty", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: "",
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const reasoningEvt = events.find((e) => e.type === "reasoning");
      expect(reasoningEvt).toBeUndefined();
    });

    test("does not emit reasoning when reasoningText is undefined", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const reasoningEvt = events.find((e) => e.type === "reasoning");
      expect(reasoningEvt).toBeUndefined();
    });

    test("does not emit reasoning when reasoningText is only whitespace", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: "   \n  ",
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const reasoningEvt = events.find((e) => e.type === "reasoning");
      expect(reasoningEvt).toBeUndefined();
    });

    test('uses "summary" kind for openai provider', async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: "my reasoning",
        responseMessages: [],
      }));

      const dir = "/tmp/test-session";
      const config = { ...makeConfig(dir), provider: "openai" as const };
      const { session, events } = makeSession({ config });
      await session.sendUserMessage("go");

      const reasoningEvt = events.find((e) => e.type === "reasoning") as any;
      expect(reasoningEvt).toBeDefined();
      expect(reasoningEvt.kind).toBe("summary");
    });

    test('uses "reasoning" kind for google provider', async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: "my reasoning",
        responseMessages: [],
      }));

      const dir = "/tmp/test-session";
      const config = { ...makeConfig(dir), provider: "google" as const };
      const { session, events } = makeSession({ config });
      await session.sendUserMessage("go");

      const reasoningEvt = events.find((e) => e.type === "reasoning") as any;
      expect(reasoningEvt.kind).toBe("reasoning");
    });

    test('uses "reasoning" kind for anthropic provider', async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: "my reasoning",
        responseMessages: [],
      }));

      const dir = "/tmp/test-session";
      const config = { ...makeConfig(dir), provider: "anthropic" as const };
      const { session, events } = makeSession({ config });
      await session.sendUserMessage("go");

      const reasoningEvt = events.find((e) => e.type === "reasoning") as any;
      expect(reasoningEvt.kind).toBe("reasoning");
    });

    test("catches runTurn errors and emits error event", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Model API failure");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as any;
      expect(errorEvt).toBeDefined();
      expect(errorEvt.message).toContain("Model API failure");
      expect(errorEvt.sessionId).toBe(session.id);
    });

    test("catches non-Error throws and emits error event", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw "string error";
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as any;
      expect(errorEvt).toBeDefined();
      expect(errorEvt.message).toContain("string error");
    });

    test("sets running=false even on error (finally block)", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("fail");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("first");

      events.length = 0;
      mockRunTurn.mockImplementation(async () => ({
        text: "recovered",
        reasoningText: undefined,
        responseMessages: [],
      }));

      await session.sendUserMessage("second");
      const busyError = events.find((e) => e.type === "error" && (e as any).message === "Agent is busy");
      expect(busyError).toBeUndefined();

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt.text).toBe("recovered");
    });

    test("event emission order: user_message comes before assistant_message", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "response",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("hi");

      const userIdx = events.findIndex((e) => e.type === "user_message");
      const assistantIdx = events.findIndex((e) => e.type === "assistant_message");
      expect(userIdx).toBeLessThan(assistantIdx);
    });

    test("event emission order: reasoning comes before assistant_message", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "response",
        reasoningText: "thinking",
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("hi");

      const reasoningIdx = events.findIndex((e) => e.type === "reasoning");
      const assistantIdx = events.findIndex((e) => e.type === "assistant_message");
      expect(reasoningIdx).toBeLessThan(assistantIdx);
    });

    test("passes log callback that emits log events", async () => {
      mockRunTurn.mockImplementation(async (params: any) => {
        params.log("doing something");
        params.log("done");
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const logEvents = events.filter((e) => e.type === "log") as any[];
      expect(logEvents).toHaveLength(2);
      expect(logEvents[0].line).toBe("doing something");
      expect(logEvents[1].line).toBe("done");
      expect(logEvents[0].sessionId).toBe(session.id);
    });

    test("messages accumulate across multiple sendUserMessage calls", async () => {
      const responseMsg1 = { role: "assistant" as const, content: "resp1" };
      const responseMsg2 = { role: "assistant" as const, content: "resp2" };

      mockRunTurn
        .mockImplementationOnce(async () => ({
          text: "resp1",
          reasoningText: undefined,
          responseMessages: [responseMsg1],
        }))
        .mockImplementationOnce(async () => ({
          text: "resp2",
          reasoningText: undefined,
          responseMessages: [responseMsg2],
        }))
        .mockImplementationOnce(async () => ({
          text: "resp3",
          reasoningText: undefined,
          responseMessages: [],
        }));

      const { session } = makeSession();
      await session.sendUserMessage("msg1");
      await session.sendUserMessage("msg2");
      await session.sendUserMessage("msg3");

      const thirdCall = mockRunTurn.mock.calls[2][0] as any;
      expect(thirdCall.messages).toHaveLength(5);
      expect(thirdCall.messages[0]).toEqual({ role: "user", content: "msg1" });
      expect(thirdCall.messages[1]).toEqual(responseMsg1);
      expect(thirdCall.messages[2]).toEqual({ role: "user", content: "msg2" });
      expect(thirdCall.messages[3]).toEqual(responseMsg2);
      expect(thirdCall.messages[4]).toEqual({ role: "user", content: "msg3" });
    });
  });

  // =========================================================================
  // updateTodos callback
  // =========================================================================

  describe("updateTodos callback", () => {
    test("updates todos array via runTurn callback", async () => {
      const todos: TodoItem[] = [
        { content: "Write tests", status: "in_progress", activeForm: "testing" },
      ];

      mockRunTurn.mockImplementation(async (params: any) => {
        params.updateTodos(todos);
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const todosEvt = events.find((e) => e.type === "todos") as any;
      expect(todosEvt).toBeDefined();
      expect(todosEvt.todos).toEqual(todos);
    });

    test("emits todos event with session id", async () => {
      mockRunTurn.mockImplementation(async (params: any) => {
        params.updateTodos([]);
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const todosEvt = events.find((e) => e.type === "todos") as any;
      expect(todosEvt.sessionId).toBe(session.id);
    });

    test("multiple updateTodos calls emit multiple events", async () => {
      const todos1: TodoItem[] = [{ content: "Task 1", status: "pending", activeForm: "" }];
      const todos2: TodoItem[] = [
        { content: "Task 1", status: "completed", activeForm: "" },
        { content: "Task 2", status: "in_progress", activeForm: "coding" },
      ];

      mockRunTurn.mockImplementation(async (params: any) => {
        params.updateTodos(todos1);
        params.updateTodos(todos2);
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const todosEvents = events.filter((e) => e.type === "todos") as any[];
      expect(todosEvents).toHaveLength(2);
      expect(todosEvents[0].todos).toEqual(todos1);
      expect(todosEvents[1].todos).toEqual(todos2);
    });

    test("reset after updateTodos clears the todos", async () => {
      const todos: TodoItem[] = [{ content: "Task", status: "pending", activeForm: "" }];

      mockRunTurn.mockImplementation(async (params: any) => {
        params.updateTodos(todos);
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      events.length = 0;
      session.reset();

      const todosEvt = events.find((e) => e.type === "todos") as any;
      expect(todosEvt.todos).toEqual([]);
    });
  });

  // =========================================================================
  // Edge cases / Integration
  // =========================================================================

  describe("Edge cases", () => {
    test("sendUserMessage with empty string still processes", async () => {
      const { session, events } = makeSession();
      await session.sendUserMessage("");

      const userEvt = events.find((e) => e.type === "user_message") as any;
      expect(userEvt.text).toBe("");
      expect(mockRunTurn).toHaveBeenCalledTimes(1);
    });

    test("reset during idle state does not throw", () => {
      const { session } = makeSession();
      expect(() => session.reset()).not.toThrow();
    });

    test("dispose then sendUserMessage works (running is false after dispose)", async () => {
      const { session } = makeSession();
      session.dispose("test");

      await session.sendUserMessage("after dispose");
      expect(mockRunTurn).toHaveBeenCalledTimes(1);
    });
  });
});
