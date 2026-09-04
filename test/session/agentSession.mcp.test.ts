import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { scratchRoots } from "../../src/platform/sandbox/policy";
import { McpRegistryFlow } from "../../src/server/session/mcp/McpRegistryFlow";
import type { SessionContext } from "../../src/server/session/SessionContext";
import type { TodoItem } from "./agentSession.harness";
import {
  AgentSession,
  ASK_SKIP_TOKEN,
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

  describe("mcp management", () => {
    test.each(["running", "connecting"] as const)(
      "registry changes remain available while model state is %s",
      async (busyState) => {
        const tmpDir = await fs.mkdtemp(path.join(scratchRoots()[0], "session-mcp-live-"));
        const errors: string[] = [];
        const state = { config: makeConfig(tmpDir), running: false, connecting: false };
        state[busyState] = true;
        const flow = new McpRegistryFlow({
          id: "mcp-live-registry",
          state,
          emit: () => {},
          emitError: (_code: string, _source: string, message: string) => errors.push(message),
          guardBusy: () => !state.running && !state.connecting,
        } as unknown as SessionContext);
        const configFile = path.join(tmpDir, ".cowork", "mcp-servers.json");
        try {
          expect(
            await flow.upsert({
              name: "live-server",
              transport: { type: "http", url: "https://mcp.example.test" },
              auth: { type: "none" },
            }),
          ).toBe("live-server");
          await flow.setEnabled({ name: "live-server", source: "workspace", enabled: false });
          expect(JSON.parse(await fs.readFile(configFile, "utf-8")).servers[0].enabled).toBe(false);
          await flow.delete("live-server");
          expect(JSON.parse(await fs.readFile(configFile, "utf-8")).servers).toEqual([]);
          expect(errors).toEqual([]);
          expect(state[busyState]).toBe(true);
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true });
        }
      },
    );

    test("MCP validation allows a model turn and rejects overlapping MCP auth", async () => {
      const { session, events } = makeSession();
      const releaseLookup = Promise.withResolvers<void>();
      const lookupStarted = Promise.withResolvers<void>();
      let lookupCalls = 0;
      (session as any).getMcpServerByName = async () => {
        lookupCalls += 1;
        lookupStarted.resolve();
        await releaseLookup.promise;
        return null;
      };
      const validation = session.validateMcpServer("live-server");
      try {
        await lookupStarted.promise;
        await session.sendUserMessage("Continue while an MCP connects");
        expect(mockRunTurn).toHaveBeenCalledTimes(1);
        await session.setMcpServerApiKey("live-server", "test-key");
        expect(lookupCalls).toBe(1);
        expect(events.some((event) => event.type === "error" && event.code === "busy")).toBe(true);
      } finally {
        releaseLookup.resolve();
        await validation;
        session.dispose("test cleanup");
      }
    });

    test("MCP validation remains available during a model turn", async () => {
      const { session, events } = makeSession();
      const turnStarted = Promise.withResolvers<void>();
      const finishTurn = Promise.withResolvers<void>();
      mockRunTurn.mockImplementation(async () => {
        turnStarted.resolve();
        await finishTurn.promise;
        return { text: "Done", reasoningText: undefined, responseMessages: [] };
      });
      let lookupCalls = 0;
      (session as any).getMcpServerByName = async () => {
        lookupCalls += 1;
        return null;
      };
      const turn = session.sendUserMessage("Keep working");
      try {
        await turnStarted.promise;
        await session.validateMcpServer("live-server");
        expect(lookupCalls).toBe(1);
        expect(session.isBusy).toBe(true);
        expect(events.some((event) => event.type === "error" && event.code === "busy")).toBe(false);
        await session.setEnableMcp(false);
        expect(events.some((event) => event.type === "error" && event.code === "busy")).toBe(true);
      } finally {
        finishTurn.resolve();
        await turn;
        session.dispose("test cleanup");
      }
    });

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
          expect(evt.files.some((file) => file.legacy)).toBe(false);
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

        const persistedRaw = await fs.readFile(
          path.join(tmpDir, ".cowork", "mcp-servers.json"),
          "utf-8",
        );
        expect(persistedRaw).toContain('"name": "local"');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    test("upsertMcpServer and deleteMcpServer target user MCP config when source is user", async () => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "session-mcp-user-source-"));
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "session-mcp-user-source-home-"));
      try {
        const config = {
          ...makeConfig(workspace),
          userCoworkDir: path.join(home, ".cowork"),
          skillsDirs: [path.join(home, ".cowork", "skills")],
        };
        const workspaceMcpFile = path.join(workspace, ".cowork", "mcp-servers.json");
        const userMcpFile = path.join(home, ".cowork", "config", "mcp-servers.json");
        await fs.mkdir(path.dirname(workspaceMcpFile), { recursive: true });
        await fs.writeFile(
          workspaceMcpFile,
          JSON.stringify(
            {
              servers: [
                {
                  name: "shared",
                  transport: { type: "stdio", command: "workspace" },
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
        await session.upsertMcpServer(
          {
            name: "shared",
            transport: { type: "stdio", command: "user" },
            auth: { type: "none" },
          },
          undefined,
          "user",
        );

        let workspaceDoc = JSON.parse(await fs.readFile(workspaceMcpFile, "utf-8")) as {
          servers: Array<{ name: string; transport: { command: string }; auth?: unknown }>;
        };
        let userDoc = JSON.parse(await fs.readFile(userMcpFile, "utf-8")) as {
          servers: Array<{ name: string; transport: { command: string }; auth?: unknown }>;
        };
        expect(workspaceDoc.servers).toEqual([
          {
            name: "shared",
            transport: { type: "stdio", command: "workspace" },
            auth: { type: "api_key", headerName: "Authorization", prefix: "Bearer" },
          },
        ]);
        expect(userDoc.servers).toEqual([
          {
            name: "shared",
            transport: { type: "stdio", command: "user" },
            auth: { type: "none" },
          },
        ]);

        await waitForCondition(() =>
          events.some((entry) => entry.type === "mcp_server_validation"),
        );
        await flushAsyncWork();
        await session.deleteMcpServer("shared", "user");

        workspaceDoc = JSON.parse(await fs.readFile(workspaceMcpFile, "utf-8")) as {
          servers: Array<{ name: string; transport: { command: string }; auth?: unknown }>;
        };
        userDoc = JSON.parse(await fs.readFile(userMcpFile, "utf-8")) as {
          servers: Array<{ name: string; transport: { command: string }; auth?: unknown }>;
        };
        expect(workspaceDoc.servers).toEqual([
          {
            name: "shared",
            transport: { type: "stdio", command: "workspace" },
            auth: { type: "api_key", headerName: "Authorization", prefix: "Bearer" },
          },
        ]);
        expect(userDoc.servers).toEqual([]);
      } finally {
        await fs.rm(workspace, { recursive: true, force: true });
        await fs.rm(home, { recursive: true, force: true });
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
        (entry) =>
          entry.type === "error" && entry.message === "MCP connection flow already running",
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

        const authRaw = await fs.readFile(
          path.join(tmpDir, ".cowork", "auth", "mcp-credentials.json"),
          "utf-8",
        );
        expect(authRaw).toContain("secret-token");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
