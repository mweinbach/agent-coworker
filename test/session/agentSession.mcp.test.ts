import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  REAL_AGENT,
  AgentSession,
  ASK_SKIP_TOKEN,
  SessionCostTracker,
  createExperimentalA2uiSurfaceManager,
  createRuntime,
  defaultSupportedModel,
  fs,
  getSupportedModel,
  MAX_ATTACHMENT_BASE64_SIZE,
  MAX_ATTACHMENT_INLINE_BYTE_SIZE,
  MAX_TURN_ATTACHMENT_COUNT,
  MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE,
  mockClosePooledCodexAppServerClient,
  mockConnectModelProvider,
  mockGenerateSessionTitle,
  mockGetAiCoworkerPaths,
  mockRunTurn,
  mockWritePersistedSessionSnapshot,
  os,
  path,
  resetAgentSessionMocks,
  makeSession,
  makeConfig,
  makeEmit,
  makeSessionBackupFactory,
  flushAsyncWork,
  waitForCondition,
  withEnv,
  isRecord,
} from "./agentSession.harness";
import type { TodoItem } from "./agentSession.harness";

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
