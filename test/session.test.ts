import { describe, expect, test, mock, beforeEach, afterAll } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentConfig, TodoItem } from "../src/types";
import type { ServerEvent } from "../src/server/protocol";
import { __internal as observabilityRuntimeInternal } from "../src/observability/runtime";
import type {
  SessionBackupHandle,
  SessionBackupInitOptions,
  SessionBackupPublicCheckpoint,
  SessionBackupPublicState,
} from "../src/server/sessionBackup";
import * as REAL_AGENT from "../src/agent";

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

const mockConnectModelProvider = mock(async (_opts: any): Promise<any> => ({
  ok: true,
  provider: "openai",
  mode: "api_key",
  storageFile: "/tmp/mock-home/.cowork/auth/connections.json",
  message: "Provider key saved.",
  maskedApiKey: "sk-t...est",
}));

const mockGetAiCoworkerPaths = mock((opts?: { homedir?: string }) => {
  const home = opts?.homedir ?? "/tmp/mock-home";
  const rootDir = path.join(home, ".cowork");
  const authDir = path.join(rootDir, "auth");
  return {
    rootDir,
    authDir,
    configDir: path.join(rootDir, "config"),
    sessionsDir: path.join(rootDir, "sessions"),
    logsDir: path.join(rootDir, "logs"),
    connectionsFile: path.join(authDir, "connections.json"),
  };
});

const mockGenerateSessionTitle = mock(async () => ({
  title: "Mock title",
  source: "heuristic" as const,
  model: null as string | null,
}));

const mockWritePersistedSessionSnapshot = mock(async () => "/tmp/mock-home/.cowork/sessions/mock.json");

// Import AgentSession AFTER the runTurn mock is registered so it picks up the mock.
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
    enableMcp: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeEmit(): { emit: (evt: ServerEvent) => void; events: ServerEvent[] } {
  const events: ServerEvent[] = [];
  const emit = (event: ServerEvent) => {
    events.push(event);
  };
  return { emit, events };
}

function makeSessionBackupFactory() {
  return mock(async (opts: SessionBackupInitOptions): Promise<SessionBackupHandle> => {
    const checkpoints: SessionBackupPublicCheckpoint[] = [];
    const createdAt = new Date().toISOString();

    const getState = (): SessionBackupPublicState => ({
      status: "ready",
      sessionId: opts.sessionId,
      workingDirectory: opts.workingDirectory,
      backupDirectory: `/tmp/mock-backups/${opts.sessionId}`,
      createdAt,
      originalSnapshot: { kind: "directory" },
      checkpoints: [...checkpoints],
    });

    return {
      getPublicState: () => getState(),
      createCheckpoint: async (trigger) => {
        const checkpoint: SessionBackupPublicCheckpoint = {
          id: `cp-${String(checkpoints.length + 1).padStart(4, "0")}`,
          index: checkpoints.length + 1,
          createdAt: new Date().toISOString(),
          trigger,
          changed: true,
          patchBytes: 42,
        };
        checkpoints.push(checkpoint);
        return checkpoint;
      },
      restoreOriginal: async () => {},
      restoreCheckpoint: async (checkpointId) => {
        if (!checkpoints.some((cp) => cp.id === checkpointId)) {
          throw new Error(`Unknown checkpoint: ${checkpointId}`);
        }
      },
      deleteCheckpoint: async (checkpointId) => {
        const idx = checkpoints.findIndex((cp) => cp.id === checkpointId);
        if (idx < 0) return false;
        checkpoints.splice(idx, 1);
        return true;
      },
      close: async () => {},
    };
  });
}

function makeSession(
  overrides?: Partial<{
    config: AgentConfig;
    system: string;
    yolo: boolean;
    emit: (evt: ServerEvent) => void;
    connectProviderImpl: (opts: any) => Promise<any>;
    getAiCoworkerPathsImpl: (opts?: { homedir?: string }) => {
      rootDir: string;
      configDir: string;
      sessionsDir: string;
      logsDir: string;
      connectionsFile: string;
    };
    getProviderCatalogImpl: (opts: any) => Promise<any>;
    getProviderStatusesImpl: (opts: any) => Promise<any>;
    sessionBackupFactory: (opts: SessionBackupInitOptions) => Promise<SessionBackupHandle>;
    persistModelSelectionImpl: (selection: {
      provider: AgentConfig["provider"];
      model: string;
      subAgentModel: string;
    }) => Promise<void> | void;
    persistProjectConfigPatchImpl: (
      patch: Partial<Pick<AgentConfig, "provider" | "model" | "subAgentModel" | "enableMcp" | "observabilityEnabled">>
    ) => Promise<void> | void;
    generateSessionTitleImpl: (opts: { config: AgentConfig; query: string }) => Promise<{
      title: string;
      source: "default" | "model" | "heuristic";
      model: string | null;
    }>;
    writePersistedSessionSnapshotImpl: (opts: any) => Promise<string>;
  }>
) {
  const dir = "/tmp/test-session";
  const { emit, events } = makeEmit();
  const sessionBackupFactory = overrides?.sessionBackupFactory ?? makeSessionBackupFactory();
  const getProviderStatusesImpl = overrides?.getProviderStatusesImpl ?? (async () => []);
  const session = new AgentSession({
    config: overrides?.config ?? makeConfig(dir),
    system: overrides?.system ?? "You are a test assistant.",
    yolo: overrides?.yolo,
    emit: overrides?.emit ?? emit,
    connectProviderImpl: overrides?.connectProviderImpl,
    getAiCoworkerPathsImpl: overrides?.getAiCoworkerPathsImpl,
    getProviderCatalogImpl: overrides?.getProviderCatalogImpl as any,
    getProviderStatusesImpl,
    sessionBackupFactory,
    persistModelSelectionImpl: overrides?.persistModelSelectionImpl,
    persistProjectConfigPatchImpl: overrides?.persistProjectConfigPatchImpl,
    generateSessionTitleImpl: overrides?.generateSessionTitleImpl ?? mockGenerateSessionTitle,
    writePersistedSessionSnapshotImpl:
      overrides?.writePersistedSessionSnapshotImpl ?? mockWritePersistedSessionSnapshot,
  });
  return { session, emit, events, sessionBackupFactory };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentSession", () => {
  beforeEach(async () => {
    await observabilityRuntimeInternal.resetForTests();

    mockRunTurn.mockReset();
    mockRunTurn.mockImplementation(async () => ({
      text: "",
      reasoningText: undefined,
      responseMessages: [],
    }));

    mockConnectModelProvider.mockReset();
    mockConnectModelProvider.mockImplementation(async () => ({
      ok: true,
      provider: "openai",
      mode: "api_key",
      storageFile: "/tmp/mock-home/.cowork/auth/connections.json",
      message: "Provider key saved.",
      maskedApiKey: "sk-t...est",
    }));

    mockGetAiCoworkerPaths.mockReset();
    mockGetAiCoworkerPaths.mockImplementation((opts?: { homedir?: string }) => {
      const home = opts?.homedir ?? "/tmp/mock-home";
      const rootDir = path.join(home, ".cowork");
      const authDir = path.join(rootDir, "auth");
      return {
        rootDir,
        authDir,
        configDir: path.join(rootDir, "config"),
        sessionsDir: path.join(rootDir, "sessions"),
        logsDir: path.join(rootDir, "logs"),
        connectionsFile: path.join(authDir, "connections.json"),
      };
    });

    mockGenerateSessionTitle.mockReset();
    mockGenerateSessionTitle.mockImplementation(async () => ({
      title: "Mock title",
      source: "heuristic",
      model: null,
    }));

    mockWritePersistedSessionSnapshot.mockReset();
    mockWritePersistedSessionSnapshot.mockImplementation(async () => "/tmp/mock-home/.cowork/sessions/mock.json");
  });

  afterAll(() => {
    mock.module("../src/agent", () => REAL_AGENT);
    mock.restore();
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

    test("exposes initial session_info payload", () => {
      const { session } = makeSession();
      const info = session.getSessionInfoEvent();
      expect(info.type).toBe("session_info");
      expect(info.title).toBe("New session");
      expect(info.titleSource).toBe("default");
      expect(info.titleModel).toBeNull();
      expect(info.provider).toBe("google");
      expect(info.model).toBe("gemini-2.0-flash");
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
      expect(first?.snapshot?.version).toBe(1);
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

  describe("enableMcp settings", () => {
    test("getEnableMcp reflects config.enableMcp", () => {
      const dir = "/tmp/test-session";
      const cfg = { ...makeConfig(dir), enableMcp: false };
      const { session } = makeSession({ config: cfg });
      expect(session.getEnableMcp()).toBe(false);
    });

    test("setEnableMcp updates config and emits session_settings", async () => {
      const dir = "/tmp/test-session";
      const cfg = { ...makeConfig(dir), enableMcp: true };
      const { session, events } = makeSession({ config: cfg });

      await session.setEnableMcp(false);

      expect(session.getEnableMcp()).toBe(false);
      const evt = events.find((e) => e.type === "session_settings") as any;
      expect(evt).toBeDefined();
      expect(evt.enableMcp).toBe(false);
    });

    test("setEnableMcp persists workspace defaults via patch hook", async () => {
      const persistProjectConfigPatchImpl = mock(async () => {});
      const { session } = makeSession({ persistProjectConfigPatchImpl });

      await session.setEnableMcp(false);

      expect(persistProjectConfigPatchImpl).toHaveBeenCalledTimes(1);
      expect(persistProjectConfigPatchImpl).toHaveBeenCalledWith({ enableMcp: false });
    });

    test("setEnableMcp while running emits Agent is busy", async () => {
      const { session, events } = makeSession();

      let resolveRunTurn!: () => void;
      mockRunTurn.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRunTurn = () => resolve({ text: "", reasoningText: undefined, responseMessages: [] });
          })
      );

      const first = session.sendUserMessage("first");
      await new Promise((r) => setTimeout(r, 10));

      await session.setEnableMcp(false);
      const errEvt = events.find((e) => e.type === "error") as any;
      expect(errEvt).toBeDefined();
      expect(errEvt.message).toBe("Agent is busy");

      resolveRunTurn();
      await first;
    });
  });

  describe("mcp management", () => {
    test("emitMcpServers emits layered snapshot event", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-mcp-emit-"));
      try {
        const config = makeConfig(tmpDir);
        await fs.mkdir(path.join(tmpDir, ".cowork"), { recursive: true });
        await fs.writeFile(
          path.join(tmpDir, ".cowork", "mcp-servers.json"),
          JSON.stringify(
            {
              servers: [{ name: "grep", transport: { type: "http", url: "https://mcp.grep.app" } }],
            },
            null,
            2,
          ),
          "utf-8",
        );

        const { session, events } = makeSession({ config });
        await session.emitMcpServers();

        const evt = events.find((entry) => entry.type === "mcp_servers");
        expect(evt).toBeDefined();
        if (evt && evt.type === "mcp_servers") {
          expect(evt.servers.some((server) => server.name === "grep")).toBe(true);
          expect(evt.files.some((file) => file.source === "workspace")).toBe(true);
          expect(typeof evt.legacy.workspace.exists).toBe("boolean");
        }
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    test("upsertMcpServer writes workspace .cowork mcp config", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-mcp-upsert-"));
      try {
        const config = makeConfig(tmpDir);
        const { session } = makeSession({ config });
        await session.upsertMcpServer({
          name: "local",
          transport: { type: "stdio", command: "echo", args: ["ok"] },
          auth: { type: "none" },
        });

        const persistedRaw = await fs.readFile(path.join(tmpDir, ".cowork", "mcp-servers.json"), "utf-8");
        expect(persistedRaw).toContain("\"name\": \"local\"");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    test("validateMcpServer blocks concurrent validation while connection flow is active", async () => {
      const { session, events } = makeSession();
      let releaseLookup: (() => void) | null = null;
      let lookupCalls = 0;
      const firstLookup = new Promise<void>((resolve) => {
        releaseLookup = resolve;
      });

      (session as any).getMcpServerByName = async () => {
        lookupCalls += 1;
        if (lookupCalls === 1) {
          await firstLookup;
        }
        return null;
      };

      const firstValidation = session.validateMcpServer("server-a");
      await new Promise((resolve) => setTimeout(resolve, 10));
      await session.validateMcpServer("server-a");

      expect(lookupCalls).toBe(1);
      const busyErr = events.find(
        (entry) => entry.type === "error" && entry.message === "Connection flow already running",
      );
      expect(busyErr).toBeDefined();

      releaseLookup?.();
      await firstValidation;
    });

    test("setMcpServerApiKey emits auth result and writes auth file", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-mcp-api-key-"));
      try {
        const config = makeConfig(tmpDir);
        await fs.mkdir(path.join(tmpDir, ".cowork"), { recursive: true });
        await fs.writeFile(
          path.join(tmpDir, ".cowork", "mcp-servers.json"),
          JSON.stringify(
            {
              servers: [
                {
                  name: "protected",
                  transport: { type: "http", url: "https://mcp.example.com" },
                  auth: { type: "api_key", headerName: "Authorization", prefix: "Bearer" },
                },
              ],
            },
            null,
            2,
          ),
          "utf-8",
        );

        const { session, events } = makeSession({ config });
        await session.setMcpServerApiKey("protected", "secret-token");

        const resultEvt = events.find((entry) => entry.type === "mcp_server_auth_result");
        expect(resultEvt).toBeDefined();
        if (resultEvt && resultEvt.type === "mcp_server_auth_result") {
          expect(resultEvt.ok).toBe(true);
          expect(resultEvt.mode).toBe("api_key");
        }

        const authRaw = await fs.readFile(path.join(tmpDir, ".cowork", "auth", "mcp-credentials.json"), "utf-8");
        expect(authRaw).toContain("secret-token");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    test("migrateLegacyMcpServers imports .agent fallback entries", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-mcp-migrate-"));
      try {
        const config = makeConfig(tmpDir);
        await fs.mkdir(path.join(tmpDir, ".agent"), { recursive: true });
        await fs.writeFile(
          path.join(tmpDir, ".agent", "mcp-servers.json"),
          JSON.stringify(
            {
              servers: [
                { name: "legacy-one", transport: { type: "stdio", command: "echo", args: ["legacy"] } },
              ],
            },
            null,
            2,
          ),
          "utf-8",
        );
        await fs.mkdir(path.join(tmpDir, ".cowork"), { recursive: true });
        await fs.writeFile(
          path.join(tmpDir, ".cowork", "mcp-servers.json"),
          JSON.stringify({ servers: [{ name: "existing", transport: { type: "stdio", command: "echo" } }] }, null, 2),
          "utf-8",
        );

        const { session } = makeSession({ config });
        await session.migrateLegacyMcpServers("workspace");

        const migratedRaw = await fs.readFile(path.join(tmpDir, ".cowork", "mcp-servers.json"), "utf-8");
        expect(migratedRaw).toContain("\"name\": \"existing\"");
        expect(migratedRaw).toContain("\"name\": \"legacy-one\"");

        const archived = await fs.readFile(path.join(tmpDir, ".agent", "mcp-servers.legacy-migrated.json"), "utf-8");
        expect(archived).toContain("\"legacy-one\"");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("session config", () => {
    test("getSessionConfigEvent exposes initial runtime session config", () => {
      const { session } = makeSession();
      const evt = session.getSessionConfigEvent();
      expect(evt.type).toBe("session_config");
      expect(evt.config.yolo).toBe(false);
      expect(evt.config.observabilityEnabled).toBe(false);
      expect(evt.config.subAgentModel).toBe("gemini-2.0-flash");
      expect(evt.config.maxSteps).toBe(100);
    });

    test("setConfig emits session_config and persists subAgentModel/observability", async () => {
      const persistProjectConfigPatchImpl = mock(async () => {});
      const { session, events } = makeSession({ persistProjectConfigPatchImpl });

      session.setConfig({
        subAgentModel: "gpt-5.2-mini",
        observabilityEnabled: true,
        maxSteps: 25,
      });
      await flushAsyncWork();

      const cfgEvt = events.filter((evt) => evt.type === "session_config").at(-1) as any;
      expect(cfgEvt).toBeDefined();
      expect(cfgEvt.config.subAgentModel).toBe("gpt-5.2-mini");
      expect(cfgEvt.config.observabilityEnabled).toBe(true);
      expect(cfgEvt.config.maxSteps).toBe(25);
      expect(persistProjectConfigPatchImpl).toHaveBeenCalledTimes(1);
      expect(persistProjectConfigPatchImpl).toHaveBeenCalledWith({
        subAgentModel: "gpt-5.2-mini",
        observabilityEnabled: true,
      });
    });
  });

  describe("harness/observability", () => {
    test("getObservabilityStatusEvent reflects config", () => {
      const dir = "/tmp/test-session";
      const cfg: AgentConfig = {
        ...makeConfig(dir),
        observabilityEnabled: true,
        observability: {
          provider: "langfuse",
          baseUrl: "https://cloud.langfuse.com",
          otelEndpoint: "https://cloud.langfuse.com/api/public/otel/v1/traces",
          publicKey: "pk-lf-123",
          secretKey: "sk-lf-123",
          tracingEnvironment: "dev",
          release: "abc123",
        },
      };
      const { session } = makeSession({ config: cfg });
      const evt = session.getObservabilityStatusEvent();
      expect(evt.type).toBe("observability_status");
      expect(evt.enabled).toBe(true);
      expect(evt.health).toBeDefined();
      expect(["disabled", "ready", "degraded"]).toContain(evt.health.status);
      expect(evt.config?.provider).toBe("langfuse");
      expect(evt.config?.baseUrl).toBe("https://cloud.langfuse.com");
      expect(evt.config?.otelEndpoint).toBe("https://cloud.langfuse.com/api/public/otel/v1/traces");
      expect(evt.config?.hasPublicKey).toBe(true);
      expect(evt.config?.hasSecretKey).toBe(true);
      expect(evt.config?.configured).toBe(true);
      expect((evt.config as any)?.publicKey).toBeUndefined();
      expect((evt.config as any)?.secretKey).toBeUndefined();
    });

    test("setHarnessContext + getHarnessContext emit harness_context", () => {
      const { session, events } = makeSession();
      session.setHarnessContext({
        runId: "run-01",
        objective: "Improve startup reliability",
        acceptanceCriteria: ["startup < 800ms"],
        constraints: ["no API changes"],
      });
      session.getHarnessContext();

      const emitted = events.filter((evt) => evt.type === "harness_context") as any[];
      expect(emitted.length).toBeGreaterThan(0);
      expect(emitted.at(-1)?.context?.runId).toBe("run-01");
    });
  });

  describe("skills", () => {
    async function makeTmpDir(prefix = "session-skills-test-"): Promise<string> {
      return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    }

    async function createSkill(parentDir: string, name: string, content: string): Promise<string> {
      const skillDir = path.join(parentDir, name);
      await fs.mkdir(skillDir, { recursive: true });
      const normalizedContent =
        content.trimStart().startsWith("---")
          ? content
          : ["---", `name: \"${name}\"`, `description: \"${name} skill\"`, "---", "", content].join("\n");
      await fs.writeFile(path.join(skillDir, "SKILL.md"), normalizedContent, "utf-8");
      return skillDir;
    }

    test("listSkills emits skills_list with discovered entries", async () => {
      const tmp = await makeTmpDir();
      await createSkill(tmp, "alpha", "# Alpha Skill\nTRIGGERS: a\n");

      const cfg: AgentConfig = { ...makeConfig(tmp), skillsDirs: [tmp] };
      const { session, events } = makeSession({ config: cfg });

      await session.listSkills();

      const evt = events.find((e) => e.type === "skills_list") as any;
      expect(evt).toBeDefined();
      expect(Array.isArray(evt.skills)).toBe(true);
      expect(evt.skills.some((s: any) => s.name === "alpha")).toBe(true);

      const alpha = evt.skills.find((s: any) => s.name === "alpha");
      expect(alpha.source).toBe("project");
      expect(alpha.enabled).toBe(true);
      expect(String(alpha.path)).toContain(path.join("alpha", "SKILL.md"));
    });

    test("readSkill emits skill_content with content", async () => {
      const tmp = await makeTmpDir();
      await createSkill(tmp, "alpha", "# Alpha Skill\nTRIGGERS: a\n");

      const cfg: AgentConfig = { ...makeConfig(tmp), skillsDirs: [tmp] };
      const { session, events } = makeSession({ config: cfg });

      await session.readSkill("alpha");

      const evt = events.find((e) => e.type === "skill_content") as any;
      expect(evt).toBeDefined();
      expect(evt.skill.name).toBe("alpha");
      expect(evt.skill.enabled).toBe(true);
      expect(String(evt.content)).toContain("# Alpha Skill");
    });

    test("readSkill missing skill emits error", async () => {
      const tmp = await makeTmpDir();
      const cfg: AgentConfig = { ...makeConfig(tmp), skillsDirs: [tmp] };
      const { session, events } = makeSession({ config: cfg });

      await session.readSkill("missing");

      const evt = events.find((e) => e.type === "error") as any;
      expect(evt).toBeDefined();
      expect(evt.message).toContain('Skill "missing" not found.');
    });

    test("disableSkill moves global skill to disabled-skills and marks it disabled", async () => {
      const root = await makeTmpDir();
      const project = path.join(root, "project-skills");
      const global = path.join(root, "skills");
      await fs.mkdir(project, { recursive: true });
      await fs.mkdir(global, { recursive: true });

      await createSkill(global, "alpha", "# Alpha Skill\nTRIGGERS: a\n");

      const cfg: AgentConfig = { ...makeConfig(root), skillsDirs: [project, global] };
      const { session, events } = makeSession({ config: cfg });

      await session.disableSkill("alpha");

      const evt = events.filter((e) => e.type === "skills_list").at(-1) as any;
      expect(evt).toBeDefined();
      const alpha = evt.skills.find((s: any) => s.name === "alpha");
      expect(alpha).toBeDefined();
      expect(alpha.source).toBe("global");
      expect(alpha.enabled).toBe(false);
      expect(String(alpha.path)).toContain(path.join("disabled-skills", "alpha", "SKILL.md"));
      await fs.access(path.join(root, "disabled-skills", "alpha", "SKILL.md"));
    });

    test("enableSkill moves global skill back to skills and marks it enabled", async () => {
      const root = await makeTmpDir();
      const project = path.join(root, "project-skills");
      const global = path.join(root, "skills");
      const disabled = path.join(root, "disabled-skills");
      await fs.mkdir(project, { recursive: true });
      await fs.mkdir(disabled, { recursive: true });

      await createSkill(disabled, "alpha", "# Alpha Skill\nTRIGGERS: a\n");

      const cfg: AgentConfig = { ...makeConfig(root), skillsDirs: [project, global] };
      const { session, events } = makeSession({ config: cfg });

      await session.enableSkill("alpha");

      const evt = events.filter((e) => e.type === "skills_list").at(-1) as any;
      expect(evt).toBeDefined();
      const alpha = evt.skills.find((s: any) => s.name === "alpha");
      expect(alpha).toBeDefined();
      expect(alpha.source).toBe("global");
      expect(alpha.enabled).toBe(true);
      expect(String(alpha.path)).toContain(path.join("skills", "alpha", "SKILL.md"));
      await fs.access(path.join(root, "skills", "alpha", "SKILL.md"));
    });

    test("deleteSkill removes global skill directory", async () => {
      const root = await makeTmpDir();
      const project = path.join(root, "project-skills");
      const global = path.join(root, "skills");
      await fs.mkdir(project, { recursive: true });
      await fs.mkdir(global, { recursive: true });
      await createSkill(global, "alpha", "# Alpha Skill\nTRIGGERS: a\n");

      const cfg: AgentConfig = { ...makeConfig(root), skillsDirs: [project, global] };
      const { session, events } = makeSession({ config: cfg });

      await session.deleteSkill("alpha");

      const evt = events.filter((e) => e.type === "skills_list").at(-1) as any;
      expect(evt).toBeDefined();
      expect(evt.skills.some((s: any) => s.name === "alpha")).toBe(false);
      await expect(fs.access(path.join(root, "skills", "alpha"))).rejects.toBeDefined();
    });
  });

  describe("setModel", () => {
    test("updates model in-session and emits config_updated", async () => {
      const { session, events } = makeSession();
      await session.setModel("gpt-5.2");

      expect(session.getPublicConfig().provider).toBe("google");
      expect(session.getPublicConfig().model).toBe("gpt-5.2");
      const updated = events.find(
        (e): e is Extract<ServerEvent, { type: "config_updated" }> => e.type === "config_updated"
      );
      expect(updated).toBeDefined();
      if (updated) {
        expect(updated.config.provider).toBe("google");
        expect(updated.config.model).toBe("gpt-5.2");
      }
      expect(events.some((e) => e.type === "error")).toBe(false);
    });

    test("updates provider+model in-session and emits config_updated", async () => {
      const { session, events } = makeSession();
      await session.setModel("claude-4-5-sonnet", "anthropic");

      expect(session.getPublicConfig().provider).toBe("anthropic");
      expect(session.getPublicConfig().model).toBe("claude-4-5-sonnet");
      const updated = events.find(
        (e): e is Extract<ServerEvent, { type: "config_updated" }> => e.type === "config_updated"
      );
      expect(updated).toBeDefined();
      if (updated) {
        expect(updated.config.provider).toBe("anthropic");
        expect(updated.config.model).toBe("claude-4-5-sonnet");
      }
      expect(events.some((e) => e.type === "error")).toBe(false);
    });

    test("emits session_info when provider/model changes", async () => {
      const { session, events } = makeSession();
      await session.setModel("gpt-5.2", "openai");
      const info = events.find((e): e is Extract<ServerEvent, { type: "session_info" }> => e.type === "session_info");
      expect(info).toBeDefined();
      if (info) {
        expect(info.provider).toBe("openai");
        expect(info.model).toBe("gpt-5.2");
      }
    });

    test("invokes model-selection persistence hook with updated defaults", async () => {
      const persistModelSelectionImpl = mock(async () => {});
      const { session } = makeSession({ persistModelSelectionImpl });

      await session.setModel("gpt-5.2", "openai");

      expect(persistModelSelectionImpl).toHaveBeenCalledTimes(1);
      expect(persistModelSelectionImpl).toHaveBeenCalledWith({
        provider: "openai",
        model: "gpt-5.2",
        subAgentModel: "gpt-5.2",
      });
    });

    test("persistence-hook failures do not roll back config_updated", async () => {
      const persistModelSelectionImpl = mock(async () => {
        throw new Error("disk write failed");
      });
      const { session, events } = makeSession({ persistModelSelectionImpl });

      await session.setModel("gpt-5.2");

      const updated = events.find((e) => e.type === "config_updated");
      expect(updated).toBeDefined();
      const err = events.find(
        (e): e is Extract<ServerEvent, { type: "error" }> =>
          e.type === "error" && e.message.includes("persisting defaults failed")
      );
      expect(err).toBeDefined();
      if (err) {
        expect(err.code).toBe("internal_error");
      }
    });

    test("empty model emits error and does not change model", async () => {
      const { session, events } = makeSession();
      const before = session.getPublicConfig().model;

      await session.setModel("   ");

      expect(session.getPublicConfig().model).toBe(before);
      const err = events.find((e) => e.type === "error");
      expect(err).toBeDefined();
      if (err && err.type === "error") {
        expect(err.message).toContain("Model id is required");
      }
    });

    test("unsupported provider emits error and does not change config", async () => {
      const { session, events } = makeSession();
      const before = session.getPublicConfig();

      await session.setModel("gpt-5.2", "invalid-provider" as any);

      expect(session.getPublicConfig()).toEqual(before);
      const err = events.find((e) => e.type === "error");
      expect(err).toBeDefined();
      if (err && err.type === "error") {
        expect(err.message).toContain("Unsupported provider");
      }
    });
  });

  describe("provider catalog/auth methods", () => {
    test("emitProviderCatalog emits provider_catalog event", async () => {
      const catalog = {
        all: [
          { id: "openai", name: "OpenAI", models: ["gpt-5.2"], defaultModel: "gpt-5.2" },
        ],
        default: { openai: "gpt-5.2" },
        connected: ["openai"],
      };
      const getProviderCatalogImpl = mock(async () => catalog);
      const { session, events } = makeSession({
        getProviderCatalogImpl: getProviderCatalogImpl as any,
      });

      await session.emitProviderCatalog();

      expect(getProviderCatalogImpl).toHaveBeenCalledTimes(1);
      const evt = events.find((e) => e.type === "provider_catalog");
      expect(evt).toBeDefined();
      if (evt && evt.type === "provider_catalog") {
        expect(evt.all).toEqual(catalog.all);
        expect(evt.default).toEqual({
          ...catalog.default,
          google: "gemini-2.0-flash",
        });
        expect(evt.connected).toEqual(catalog.connected);
      }
    });

    test("emitProviderAuthMethods emits provider_auth_methods event", () => {
      const { session, events } = makeSession();
      session.emitProviderAuthMethods();
      const evt = events.find((e) => e.type === "provider_auth_methods");
      expect(evt).toBeDefined();
      if (evt && evt.type === "provider_auth_methods") {
        expect(evt.methods.openai?.some((m) => m.id === "api_key")).toBe(true);
        expect(evt.methods.google?.some((m) => m.id === "exa_api_key")).toBe(true);
      }
    });

    test("authorizeProviderAuth emits challenge for oauth method", async () => {
      const { session, events } = makeSession();
      await session.authorizeProviderAuth("codex-cli", "oauth_cli");
      const evt = events.find((e) => e.type === "provider_auth_challenge");
      expect(evt).toBeDefined();
      if (evt && evt.type === "provider_auth_challenge") {
        expect(evt.provider).toBe("codex-cli");
        expect(evt.methodId).toBe("oauth_cli");
      }
    });
  });

  describe("provider auth actions", () => {
    test("setProviderApiKey emits provider_auth_result and refreshes status/catalog", async () => {
      const statuses = [
        {
          provider: "openai",
          authorized: true,
          verified: false,
          mode: "api_key",
          account: null,
          message: "API key saved.",
          checkedAt: "2026-02-16T00:00:00.000Z",
        },
      ];
      const getProviderCatalogImpl = mock(async () => ({
        all: [{ id: "openai", name: "OpenAI", models: ["gpt-5.2"], defaultModel: "gpt-5.2" }],
        default: { openai: "gpt-5.2" },
        connected: ["openai"],
      }));
      const getProviderStatusesImpl = mock(async () => statuses);
      const { session, events } = makeSession({
        connectProviderImpl: mockConnectModelProvider,
        getAiCoworkerPathsImpl: mockGetAiCoworkerPaths,
        getProviderCatalogImpl: getProviderCatalogImpl as any,
        getProviderStatusesImpl: getProviderStatusesImpl as any,
      });

      await session.setProviderApiKey("openai", "api_key", "sk-test");

      const authEvt = events.find((e) => e.type === "provider_auth_result");
      expect(authEvt).toBeDefined();
      if (authEvt && authEvt.type === "provider_auth_result") {
        expect(authEvt.ok).toBe(true);
        expect(authEvt.provider).toBe("openai");
        expect(authEvt.methodId).toBe("api_key");
      }
      expect(events.some((e) => e.type === "provider_status")).toBe(true);
      expect(events.some((e) => e.type === "provider_catalog")).toBe(true);
    });

    test("callbackProviderAuth emits provider_auth_result for oauth method", async () => {
      const getProviderCatalogImpl = mock(async () => ({
        all: [{ id: "codex-cli", name: "Codex CLI", models: ["gpt-5.3-codex"], defaultModel: "gpt-5.3-codex" }],
        default: { "codex-cli": "gpt-5.3-codex" },
        connected: ["codex-cli"],
      }));
      const getProviderStatusesImpl = mock(async () => []);
      mockConnectModelProvider.mockImplementationOnce(async () => ({
        ok: true,
        provider: "codex-cli",
        mode: "oauth",
        storageFile: "/tmp/mock-home/.cowork/auth/connections.json",
        message: "OAuth sign-in completed.",
      }));
      const { session, events } = makeSession({
        connectProviderImpl: mockConnectModelProvider,
        getAiCoworkerPathsImpl: mockGetAiCoworkerPaths,
        getProviderCatalogImpl: getProviderCatalogImpl as any,
        getProviderStatusesImpl: getProviderStatusesImpl as any,
      });

      await session.callbackProviderAuth("codex-cli", "oauth_cli");

      const authEvt = events.find((e) => e.type === "provider_auth_result");
      expect(authEvt).toBeDefined();
      if (authEvt && authEvt.type === "provider_auth_result") {
        expect(authEvt.ok).toBe(true);
        expect(authEvt.provider).toBe("codex-cli");
      }
    });
  });

  describe("refreshProviderStatus", () => {
    test("emits provider_status with computed statuses", async () => {
      const dir = "/tmp/test-session-provider-status";
      const config = makeConfig(dir);
      const statuses = [
        {
          provider: "codex-cli",
          authorized: true,
          verified: true,
          mode: "oauth",
          account: { email: "user@example.com", name: "User" },
          message: "ok",
          checkedAt: "2026-02-09T00:00:00.000Z",
        },
      ];

      const mockGetProviderStatuses = mock(async () => statuses);
      const { session, events } = makeSession({
        config,
        getAiCoworkerPathsImpl: mockGetAiCoworkerPaths,
        getProviderStatusesImpl: mockGetProviderStatuses,
      });

      await session.refreshProviderStatus();

      expect(mockGetAiCoworkerPaths).toHaveBeenCalledWith({ homedir: path.dirname(config.userAgentDir) });
      expect(mockGetProviderStatuses).toHaveBeenCalledTimes(1);

      const evt = events.find((e) => e.type === "provider_status");
      expect(evt).toBeDefined();
      if (evt && evt.type === "provider_status") {
        expect(evt.sessionId).toBe(session.id);
        expect(evt.providers).toEqual(statuses);
      }
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
          })
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
      expect((sessionAny.pendingAskEvents as Map<string, unknown>).size).toBe(0);
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
      expect((sessionAny.pendingApprovalEvents as Map<string, unknown>).size).toBe(0);
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
        return { text: approved ? "auto-approved" : "denied", reasoningText: undefined, responseMessages: [] };
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
        return { text: approved ? "approved" : "denied", reasoningText: undefined, responseMessages: [] };
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

    test("emits session_busy true then false", async () => {
      const { session, events } = makeSession();

      let resolveRunTurn!: () => void;
      mockRunTurn.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRunTurn = () => resolve({ text: "", reasoningText: undefined, responseMessages: [] });
          })
      );

      const p = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const busyTrueIdx = events.findIndex((e) => e.type === "session_busy" && (e as any).busy === true);
      const busyFalseIdx = events.findIndex((e) => e.type === "session_busy" && (e as any).busy === false);
      expect(busyTrueIdx).toBeGreaterThanOrEqual(0);
      expect(busyFalseIdx).toBe(-1);

      resolveRunTurn();
      await p;

      const busyFalseIdxAfter = events.findIndex((e) => e.type === "session_busy" && (e as any).busy === false);
      expect(busyFalseIdxAfter).toBeGreaterThan(busyTrueIdx);
    });

    test("clears busy and allows follow-up even when auto-checkpoint never resolves", async () => {
      const sessionBackupFactory = mock(async (opts: SessionBackupInitOptions): Promise<SessionBackupHandle> => {
        const checkpoints: SessionBackupPublicCheckpoint[] = [];
        const createdAt = new Date().toISOString();
        const state = (): SessionBackupPublicState => ({
          status: "ready",
          sessionId: opts.sessionId,
          workingDirectory: opts.workingDirectory,
          backupDirectory: `/tmp/mock-backups/${opts.sessionId}`,
          createdAt,
          originalSnapshot: { kind: "directory" },
          checkpoints: [...checkpoints],
        });

        return {
          getPublicState: () => state(),
          createCheckpoint: async (trigger) => {
            if (trigger === "auto") {
              await new Promise<never>(() => {});
            }
            const checkpoint: SessionBackupPublicCheckpoint = {
              id: `cp-${String(checkpoints.length + 1).padStart(4, "0")}`,
              index: checkpoints.length + 1,
              createdAt: new Date().toISOString(),
              trigger,
              changed: true,
              patchBytes: 42,
            };
            checkpoints.push(checkpoint);
            return checkpoint;
          },
          restoreOriginal: async () => {},
          restoreCheckpoint: async (_checkpointId: string) => {},
          deleteCheckpoint: async (_checkpointId: string) => false,
          close: async () => {},
        };
      });

      const { session, events } = makeSession({ sessionBackupFactory });

      const firstTurnResult = await Promise.race([
        session.sendUserMessage("first").then(() => "resolved" as const),
        new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), 50);
        }),
      ]);
      expect(firstTurnResult).toBe("resolved");

      const busyTrueIdx = events.findIndex((e) => e.type === "session_busy" && (e as any).busy === true);
      const busyFalseIdx = events.findIndex((e) => e.type === "session_busy" && (e as any).busy === false);
      expect(busyTrueIdx).toBeGreaterThanOrEqual(0);
      expect(busyFalseIdx).toBeGreaterThan(busyTrueIdx);

      events.length = 0;
      await session.sendUserMessage("follow-up");
      const busyError = events.find((e) => e.type === "error" && (e as any).message === "Agent is busy");
      expect(busyError).toBeUndefined();
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

    test("generates title once from the first accepted user prompt", async () => {
      mockGenerateSessionTitle.mockResolvedValueOnce({
        title: "First prompt title",
        source: "model",
        model: "gpt-5-mini",
      });
      const { session, events } = makeSession();

      await session.sendUserMessage("first question");
      await session.sendUserMessage("second question");
      await flushAsyncWork();

      expect(mockGenerateSessionTitle).toHaveBeenCalledTimes(1);
      expect(mockGenerateSessionTitle.mock.calls[0]?.[0]).toMatchObject({
        query: "first question",
      });
      const infoEvents = events.filter((evt): evt is Extract<ServerEvent, { type: "session_info" }> => evt.type === "session_info");
      expect(infoEvents.some((evt) => evt.title === "First prompt title")).toBe(true);
    });

    test("manual titles are not overwritten by in-flight auto title generation", async () => {
      let resolveTitle!: (value: { title: string; source: "heuristic"; model: null }) => void;
      mockGenerateSessionTitle.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveTitle = resolve;
          })
      );

      const { session } = makeSession();

      await session.sendUserMessage("first question");
      session.setSessionTitle("My Manual Title");

      resolveTitle({ title: "Generated Title", source: "heuristic", model: null });
      await flushAsyncWork();

      const info = session.getSessionInfoEvent();
      expect(info.title).toBe("My Manual Title");
      expect(info.titleSource).toBe("manual");
      expect(info.titleModel).toBeNull();
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

    test("passes enableMcp from config to runTurn", async () => {
      const { session } = makeSession();
      await session.sendUserMessage("go");

      const call = mockRunTurn.mock.calls[0][0] as any;
      expect(call.enableMcp).toBe(true);
    });

    test("passes includeRawChunks and onModelStreamPart to runTurn", async () => {
      const { session } = makeSession();
      await session.sendUserMessage("go");

      const call = mockRunTurn.mock.calls[0][0] as any;
      expect(call.includeRawChunks).toBe(true);
      expect(typeof call.onModelStreamPart).toBe("function");
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

    test("persists full session context including response history", async () => {
      mockRunTurn.mockResolvedValueOnce({
        text: "assistant reply",
        reasoningText: undefined,
        responseMessages: [{ role: "assistant", content: "assistant reply" }],
      });
      const { session } = makeSession();

      await session.sendUserMessage("persist me");
      await flushAsyncWork();

      const last = mockWritePersistedSessionSnapshot.mock.calls.at(-1)?.[0] as any;
      const snapshot = last?.snapshot;
      expect(snapshot).toBeDefined();
      expect(snapshot.context.system).toBe("You are a test assistant.");
      expect(Array.isArray(snapshot.context.messages)).toBe(true);
      expect(snapshot.context.messages.some((msg: any) => msg.role === "user")).toBe(true);
      expect(snapshot.context.messages.some((msg: any) => msg.role === "assistant")).toBe(true);
    });

    test("keeps full persisted history while capping runtime context window", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session } = makeSession();
      const totalMessages = 205;
      for (let i = 0; i < totalMessages; i++) {
        await session.sendUserMessage(`message ${i + 1}`);
      }
      await flushAsyncWork();

      expect(session.messageCount).toBe(totalMessages);
      const lastRunTurnCall = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(lastRunTurnCall.messages.length).toBe(200);
      const lastPersistCall = mockWritePersistedSessionSnapshot.mock.calls.at(-1)?.[0] as any;
      expect(lastPersistCall.snapshot.context.messages.length).toBe(totalMessages);
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

    test("emits ordered model_stream_chunk events with turnId/index/provider/model", async () => {
      mockRunTurn.mockImplementation(async (params: any) => {
        await params.onModelStreamPart?.({ type: "start" });
        await params.onModelStreamPart?.({ type: "text-delta", id: "txt_1", text: "hel" });
        await params.onModelStreamPart?.({ type: "text-delta", id: "txt_1", text: "lo" });
        await params.onModelStreamPart?.({ type: "finish", finishReason: "stop" });
        return {
          text: "hello",
          reasoningText: "because",
          responseMessages: [],
        };
      });

      const dir = "/tmp/test-session";
      const config = { ...makeConfig(dir), provider: "openai" as const, model: "gpt-5.2" };
      const { session, events } = makeSession({ config });
      await session.sendUserMessage("hi");

      const chunks = events.filter((e) => e.type === "model_stream_chunk") as Extract<ServerEvent, { type: "model_stream_chunk" }>[];
      expect(chunks).toHaveLength(4);
      expect(chunks.map((chunk) => chunk.partType)).toEqual(["start", "text_delta", "text_delta", "finish"]);
      expect(new Set(chunks.map((chunk) => chunk.turnId)).size).toBe(1);
      expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2, 3]);
      for (const chunk of chunks) {
        expect(chunk.sessionId).toBe(session.id);
        expect(chunk.provider).toBe("openai");
        expect(chunk.model).toBe("gpt-5.2");
      }
      expect((chunks[1]?.part.text as string) ?? "").toBe("hel");
      expect((chunks[2]?.part.text as string) ?? "").toBe("lo");

      const legacyReasoning = events.find((e) => e.type === "reasoning");
      const legacyAssistant = events.find((e) => e.type === "assistant_message");
      expect(legacyReasoning).toBeDefined();
      expect(legacyAssistant).toBeDefined();
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

    test("falls back to assistant responseMessages text when stream text is empty", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Here is what I found in this folder." }],
          },
        ],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("whats in this folder");

      const assistantEvt = events.find((e) => e.type === "assistant_message");
      expect(assistantEvt).toBeDefined();
      if (assistantEvt && assistantEvt.type === "assistant_message") {
        expect(assistantEvt.text).toBe("Here is what I found in this folder.");
      }
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

    test('normalizes reasoning_delta mode to "summary" for openai stream parts', async () => {
      mockRunTurn.mockImplementation(async (params: any) => {
        await params.onModelStreamPart?.({ type: "reasoning-delta", id: "r1", text: "thinking" });
        return {
          text: "done",
          reasoningText: "thinking",
          responseMessages: [],
        };
      });

      const dir = "/tmp/test-session";
      const config = { ...makeConfig(dir), provider: "openai" as const };
      const { session, events } = makeSession({ config });
      await session.sendUserMessage("go");

      const chunk = events.find((e) => e.type === "model_stream_chunk" && e.partType === "reasoning_delta") as
        | Extract<ServerEvent, { type: "model_stream_chunk" }>
        | undefined;
      expect(chunk).toBeDefined();
      if (chunk) {
        expect(chunk.part.mode).toBe("summary");
      }
    });

    test('uses "summary" kind for codex-cli provider', async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: "my reasoning",
        responseMessages: [],
      }));

      const dir = "/tmp/test-session";
      const config = { ...makeConfig(dir), provider: "codex-cli" as const };
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

    test('normalizes reasoning_delta mode to "reasoning" for google stream parts', async () => {
      mockRunTurn.mockImplementation(async (params: any) => {
        await params.onModelStreamPart?.({ type: "reasoning-delta", id: "r1", text: "thinking" });
        return {
          text: "done",
          reasoningText: "thinking",
          responseMessages: [],
        };
      });

      const dir = "/tmp/test-session";
      const config = { ...makeConfig(dir), provider: "google" as const };
      const { session, events } = makeSession({ config });
      await session.sendUserMessage("go");

      const chunk = events.find((e) => e.type === "model_stream_chunk" && e.partType === "reasoning_delta") as
        | Extract<ServerEvent, { type: "model_stream_chunk" }>
        | undefined;
      expect(chunk).toBeDefined();
      if (chunk) {
        expect(chunk.part.mode).toBe("reasoning");
      }
    });

    test("sanitizes non-json-safe stream raw payloads", async () => {
      mockRunTurn.mockImplementation(async (params: any) => {
        const cyclic: any = { name: "root", count: 12n };
        cyclic.self = cyclic;
        cyclic.items = [1, 2, 3];
        await params.onModelStreamPart?.({ type: "raw", rawValue: cyclic });
        return {
          text: "done",
          reasoningText: undefined,
          responseMessages: [],
        };
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const chunk = events.find((e) => e.type === "model_stream_chunk") as
        | Extract<ServerEvent, { type: "model_stream_chunk" }>
        | undefined;
      expect(chunk).toBeDefined();
      if (!chunk) return;

      expect(chunk.partType).toBe("raw");
      expect(isRecord(chunk.part.raw)).toBe(true);
      const partRaw = chunk.part.raw as Record<string, unknown>;
      expect(partRaw.self).toBe("[circular]");
      expect(partRaw.count).toBe("12");
      expect(isRecord(chunk.rawPart)).toBe(true);
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

    test("classifies unknown checkpoint id failures as validation_failed", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Unknown checkpoint id: cp-404");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("validation_failed");
        expect(errorEvt.source).toBe("session");
      }
    });

    test("classifies glob guard rejections as permission_denied", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("glob blocked: pattern cannot escape cwd");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("permission_denied");
        expect(errorEvt.source).toBe("permissions");
      }
    });

    test("classifies backup errors containing invalid as backup_error", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("session backup has invalid state");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("backup_error");
        expect(errorEvt.source).toBe("backup");
      }
    });

    test("classifies checkpoint errors as backup_error even when message includes provider", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("session backup checkpoint failed for provider reconnect flow");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("backup_error");
        expect(errorEvt.source).toBe("backup");
      }
    });

    test("does not classify generic backup mentions as backup subsystem errors", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("failed to create backup before editing");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("internal_error");
        expect(errorEvt.source).toBe("session");
      }
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

  describe("session backups", () => {
    test("getSessionBackupState emits a session_backup_state event", async () => {
      const { session, events } = makeSession();
      await session.getSessionBackupState();

      const evt = events.find((e) => e.type === "session_backup_state");
      expect(evt).toBeDefined();
      if (evt && evt.type === "session_backup_state") {
        expect(evt.reason).toBe("requested");
        expect(evt.backup.status).toBe("ready");
      }
    });

    test("sendUserMessage emits auto checkpoint state after completion", async () => {
      const { session, events } = makeSession();
      await session.sendUserMessage("checkpoint me");
      for (let i = 0; i < 40; i += 1) {
        if (events.some((e) => e.type === "session_backup_state" && e.reason === "auto_checkpoint")) break;
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
      }

      const backupEvents = events.filter((e) => e.type === "session_backup_state") as Array<
        Extract<ServerEvent, { type: "session_backup_state" }>
      >;
      const auto = backupEvents.find((e) => e.reason === "auto_checkpoint");
      expect(auto).toBeDefined();
      if (auto) {
        expect(auto.backup.checkpoints).toHaveLength(1);
        expect(auto.backup.checkpoints[0]?.trigger).toBe("auto");
      }
    });

    test("createManualSessionCheckpoint emits manual checkpoint state", async () => {
      const { session, events } = makeSession();
      await session.createManualSessionCheckpoint();

      const manual = events.find(
        (e) => e.type === "session_backup_state" && e.reason === "manual_checkpoint"
      ) as Extract<ServerEvent, { type: "session_backup_state" }> | undefined;
      expect(manual).toBeDefined();
      if (manual) {
        expect(manual.backup.checkpoints).toHaveLength(1);
        expect(manual.backup.checkpoints[0]?.trigger).toBe("manual");
      }
    });

    test("restoreSessionBackup supports restoring to original and checkpoint id", async () => {
      const { session, events } = makeSession();
      await session.createManualSessionCheckpoint();
      await session.restoreSessionBackup();
      await session.restoreSessionBackup("cp-0001");

      const restoreEvents = events.filter(
        (e) => e.type === "session_backup_state" && e.reason === "restore"
      ) as Array<Extract<ServerEvent, { type: "session_backup_state" }>>;
      expect(restoreEvents.length).toBeGreaterThanOrEqual(2);
    });

    test("deleteSessionCheckpoint emits error when checkpoint does not exist", async () => {
      const { session, events } = makeSession();
      await session.deleteSessionCheckpoint("does-not-exist");

      const err = events.find((e) => e.type === "error");
      expect(err).toBeDefined();
      if (err && err.type === "error") {
        expect(err.message).toContain("Unknown checkpoint id");
      }
    });

    test("manual checkpoint requests are serialized", async () => {
      const { session, events } = makeSession();

      await Promise.all([session.createManualSessionCheckpoint(), session.createManualSessionCheckpoint()]);

      const manualEvents = events.filter(
        (e) => e.type === "session_backup_state" && e.reason === "manual_checkpoint"
      ) as Array<Extract<ServerEvent, { type: "session_backup_state" }>>;
      expect(manualEvents.length).toBe(2);
      expect(manualEvents[1]?.backup.checkpoints.length).toBe(2);
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

  // =========================================================================
  // classifyTurnError — error code routing
  // =========================================================================

  describe("classifyTurnError error code routing", () => {
    test("'blocked: path is outside' maps to permission_denied / permissions", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("blocked: path is outside the allowed directory");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("permission_denied");
        expect(errorEvt.source).toBe("permissions");
      }
    });

    test("'blocked: canonical target resolves outside' maps to permission_denied / permissions", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("blocked: canonical target resolves outside allowed directories");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("permission_denied");
        expect(errorEvt.source).toBe("permissions");
      }
    });

    test("'outside allowed directories' maps to permission_denied / permissions", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Write target is outside allowed directories");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("permission_denied");
        expect(errorEvt.source).toBe("permissions");
      }
    });

    test("'blocked private/internal host' maps to permission_denied / permissions", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("blocked private/internal host 192.168.1.1");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("permission_denied");
        expect(errorEvt.source).toBe("permissions");
      }
    });

    test("'blocked url protocol' maps to permission_denied / permissions", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("blocked url protocol ftp");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("permission_denied");
        expect(errorEvt.source).toBe("permissions");
      }
    });

    test("'oauth' maps to provider_error / provider", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("OAuth token exchange failed");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("provider_error");
        expect(errorEvt.source).toBe("provider");
      }
    });

    test("'api key' maps to provider_error / provider", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Invalid API key provided");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("provider_error");
        expect(errorEvt.source).toBe("provider");
      }
    });

    test("'unsupported provider' maps to provider_error / provider", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Unsupported provider: foobar");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("provider_error");
        expect(errorEvt.source).toBe("provider");
      }
    });

    test("'checkpoint' (without 'unknown checkpoint id') maps to backup_error / backup", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("checkpoint creation timed out");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("backup_error");
        expect(errorEvt.source).toBe("backup");
      }
    });

    test("'unknown checkpoint id' maps to validation_failed / session (higher priority than checkpoint)", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("unknown checkpoint id: cp-9999");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("validation_failed");
        expect(errorEvt.source).toBe("session");
      }
    });

    test("'is required' maps to validation_failed / session", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Parameter 'filename' is required");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("validation_failed");
        expect(errorEvt.source).toBe("session");
      }
    });

    test("'invalid ' maps to validation_failed / session", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("invalid configuration value for maxTokens");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("validation_failed");
        expect(errorEvt.source).toBe("session");
      }
    });

    test("'observability' maps to observability_error / observability", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("observability endpoint unreachable");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("observability_error");
        expect(errorEvt.source).toBe("observability");
      }
    });

    test("unclassified error maps to internal_error / session", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Something completely unexpected happened");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("internal_error");
        expect(errorEvt.source).toBe("session");
      }
    });

    test("session_busy outcome is 'error' for classified errors", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Invalid API key");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const busyFalse = events.find(
        (e) => e.type === "session_busy" && !(e as any).busy
      ) as any;
      expect(busyFalse).toBeDefined();
      expect(busyFalse.outcome).toBe("error");
    });
  });

  // =========================================================================
  // Token usage passthrough
  // =========================================================================

  describe("Token usage passthrough", () => {
    test("emits turn_usage event when runTurn returns usage", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "done",
        reasoningText: undefined,
        responseMessages: [],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const usageEvt = events.find((e) => e.type === "turn_usage") as Extract<ServerEvent, { type: "turn_usage" }> | undefined;
      expect(usageEvt).toBeDefined();
      if (usageEvt) {
        expect(usageEvt.sessionId).toBe(session.id);
        expect(usageEvt.usage.promptTokens).toBe(100);
        expect(usageEvt.usage.completionTokens).toBe(50);
        expect(usageEvt.usage.totalTokens).toBe(150);
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

      const busyTrue = events.find((e) => e.type === "session_busy" && (e as any).busy === true) as any;
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
  });
});
