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
