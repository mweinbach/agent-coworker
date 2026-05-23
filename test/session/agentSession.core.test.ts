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

    test("exposes initial session_info payload", () => {
      const { session } = makeSession();
      const info = session.getSessionInfoEvent();
      expect(info.type).toBe("session_info");
      expect(info.title).toBe("New session");
      expect(info.titleSource).toBe("default");
      expect(info.titleModel).toBeNull();
      expect(info.provider).toBe("google");
      expect(info.model).toBe("gemini-3-flash-preview");
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

    test("writes an initial persisted session snapshot", async () => {
      makeSession();
      await flushAsyncWork();
      expect(mockWritePersistedSessionSnapshot).toHaveBeenCalledTimes(1);
      const first = mockWritePersistedSessionSnapshot.mock.calls[0]?.[0] as any;
      expect(first?.snapshot?.version).toBe(7);
      expect(first?.snapshot?.context?.providerState).toBeNull();
      expect(first?.snapshot?.context?.costTracker).toMatchObject({
        totalTurns: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        estimatedTotalCostUsd: null,
        costTrackingAvailable: false,
      });
      expect(first?.snapshot?.session?.title).toBe("New session");
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
      expect(session.getPublicConfig().model).toBe("gemini-3-flash-preview");
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

    test("does not include preferredChildModel", () => {
      const { session } = makeSession();
      const pub = session.getPublicConfig() as any;
      expect(pub.preferredChildModel).toBeUndefined();
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

  describe("uploadFile", () => {
    test("rejects upload roots that resolve outside the working directory", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-upload-root-"));
      const outsideDir = await fs.mkdtemp(path.join(path.dirname(dir), "session-upload-outside-"));
      const uploadsDir = path.join(dir, "uploads");
      await fs.symlink(outsideDir, uploadsDir, process.platform === "win32" ? "junction" : "dir");
      const { session, events } = makeSession({
        config: {
          ...makeConfig(dir),
          uploadsDirectory: uploadsDir,
        },
      });

      await session.uploadFile("upload.txt", Buffer.from("blocked upload").toString("base64"));

      const errorEvt = events.find((e) => e.type === "error") as any;
      expect(errorEvt).toMatchObject({
        code: "validation_failed",
        message: "Uploads directory resolves outside the workspace.",
      });
      expect(events.some((e) => e.type === "file_uploaded")).toBe(false);
      await expect(fs.readFile(path.join(outsideDir, "upload.txt"), "utf8")).rejects.toThrow();
    });
  });
});
