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

  describe("provider catalog/auth methods", () => {
    test("emitProviderCatalog emits provider_catalog event", async () => {
      const catalog = {
        all: [{ id: "openai", name: "OpenAI", models: ["gpt-5.2"], defaultModel: "gpt-5.2" }],
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
          google: "gemini-3-flash-preview",
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
        expect(evt.challenge.method).toBe("auto");
        expect(evt.challenge.url).toBeUndefined();
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
      (session as any).state.providerState = {
        provider: "openai",
        model: "gpt-5.2",
        responseId: "resp_before_auth",
        updatedAt: "2026-02-16T00:00:00.000Z",
      };

      await session.setProviderApiKey("openai", "api_key", "sk-test");

      const authEvt = events.find((e) => e.type === "provider_auth_result");
      expect(authEvt).toBeDefined();
      if (authEvt && authEvt.type === "provider_auth_result") {
        expect(authEvt.ok).toBe(true);
        expect(authEvt.provider).toBe("openai");
        expect(authEvt.methodId).toBe("api_key");
      }
      expect(getProviderStatusesImpl).toHaveBeenCalledWith(
        expect.objectContaining({
          refreshBedrockDiscovery: false,
        }),
      );
      expect(events.some((e) => e.type === "provider_status")).toBe(true);
      expect(events.some((e) => e.type === "provider_catalog")).toBe(true);
      expect((session as any).state.providerState).toBeNull();
    });

    test("setProviderConfig only requests Bedrock discovery refreshes for Bedrock mutations", async () => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "session-bedrock-config-"));
      const connectionsFile = path.join(home, ".cowork", "auth", "connections.json");
      const getProviderCatalogImpl = mock(async () => ({
        all: [
          {
            id: "bedrock",
            name: "Amazon Bedrock",
            models: ["amazon.nova-lite-v1:0"],
            defaultModel: "amazon.nova-lite-v1:0",
          },
        ],
        default: { bedrock: "amazon.nova-lite-v1:0" },
        connected: ["bedrock"],
      }));
      const getProviderStatusesImpl = mock(async () => [
        {
          provider: "bedrock",
          authorized: true,
          verified: false,
          mode: "credentials",
          account: null,
          message: "Credentials saved.",
          checkedAt: "2026-04-14T00:00:00.000Z",
          methodId: "aws_default",
        },
      ]);
      const { session, events } = makeSession({
        config: {
          ...makeConfig("/tmp/test-session"),
          provider: "bedrock",
          model: "amazon.nova-lite-v1:0",
          userCoworkDir: path.join(home, ".cowork"),
        },
        getAiCoworkerPathsImpl: mock(({ homedir }: { homedir?: string } = {}) => ({
          rootDir: path.join(homedir ?? home, ".cowork"),
          authDir: path.join(homedir ?? home, ".cowork", "auth"),
          configDir: path.join(homedir ?? home, ".cowork", "config"),
          sessionsDir: path.join(homedir ?? home, ".cowork", "sessions"),
          logsDir: path.join(homedir ?? home, ".cowork", "logs"),
          skillsDir: path.join(homedir ?? home, ".cowork", "skills"),
          connectionsFile,
        })),
        getProviderCatalogImpl: getProviderCatalogImpl as any,
        getProviderStatusesImpl: getProviderStatusesImpl as any,
      });

      await session.setProviderConfig("bedrock", "aws_default", {});

      const authEvt = events.findLast((e) => e.type === "provider_auth_result");
      expect(authEvt).toBeDefined();
      if (authEvt && authEvt.type === "provider_auth_result") {
        expect(authEvt.ok).toBe(true);
        expect(authEvt.provider).toBe("bedrock");
        expect(authEvt.methodId).toBe("aws_default");
      }
      expect(getProviderStatusesImpl).toHaveBeenCalledWith(
        expect.objectContaining({
          refreshBedrockDiscovery: true,
        }),
      );
      expect(events.some((e) => e.type === "provider_status")).toBe(true);
      expect(events.some((e) => e.type === "provider_catalog")).toBe(true);
    });

    test("copyProviderApiKey emits provider_auth_result and refreshes status/catalog", async () => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "session-copy-provider-key-"));
      const connectionsFile = path.join(home, ".cowork", "auth", "connections.json");
      await fs.mkdir(path.dirname(connectionsFile), { recursive: true });
      await fs.writeFile(
        connectionsFile,
        JSON.stringify({
          version: 1,
          updatedAt: "2026-03-11T00:00:00.000Z",
          services: {
            "opencode-go": {
              service: "opencode-go",
              mode: "api_key",
              apiKey: "opencode-go-key-1234",
              updatedAt: "2026-03-11T00:00:00.000Z",
            },
          },
        }),
        "utf-8",
      );

      const statuses = [
        {
          provider: "opencode-zen",
          authorized: true,
          verified: false,
          mode: "api_key",
          account: null,
          message: "API key saved.",
          checkedAt: "2026-03-11T00:00:00.000Z",
          savedApiKeyMasks: { api_key: "open...1234" },
        },
      ];
      const getProviderCatalogImpl = mock(async () => ({
        all: [
          {
            id: "opencode-go",
            name: "OpenCode Go",
            models: ["glm-5", "kimi-k2.5"],
            defaultModel: "glm-5",
          },
          {
            id: "opencode-zen",
            name: "OpenCode Zen",
            models: [
              "glm-5",
              "kimi-k2.5",
              "nemotron-3-super-free",
              "mimo-v2-flash-free",
              "big-pickle",
              "minimax-m2.5-free",
              "minimax-m2.5",
            ],
            defaultModel: "glm-5",
          },
        ],
        default: { "opencode-go": "glm-5", "opencode-zen": "glm-5" },
        connected: ["opencode-go", "opencode-zen"],
      }));
      const getProviderStatusesImpl = mock(async () => statuses);
      const connectProviderImpl = mock(async (opts: any) => ({
        ok: true,
        provider: opts.provider,
        mode: "api_key",
        storageFile: connectionsFile,
        message: "Provider key saved.",
        maskedApiKey: "open...1234",
      }));
      const { session, events } = makeSession({
        config: {
          ...makeConfig("/tmp/test-session"),
          userCoworkDir: path.join(home, ".cowork"),
        },
        connectProviderImpl: connectProviderImpl as any,
        getAiCoworkerPathsImpl: mock(({ homedir }: { homedir?: string } = {}) => ({
          rootDir: path.join(homedir ?? home, ".cowork"),
          authDir: path.join(homedir ?? home, ".cowork", "auth"),
          configDir: path.join(homedir ?? home, ".cowork", "config"),
          sessionsDir: path.join(homedir ?? home, ".cowork", "sessions"),
          logsDir: path.join(homedir ?? home, ".cowork", "logs"),
          skillsDir: path.join(homedir ?? home, ".cowork", "skills"),
          connectionsFile,
        })),
        getProviderCatalogImpl: getProviderCatalogImpl as any,
        getProviderStatusesImpl: getProviderStatusesImpl as any,
      });

      await session.copyProviderApiKey("opencode-zen", "opencode-go");

      const authEvt = events.find((e) => e.type === "provider_auth_result");
      expect(authEvt).toBeDefined();
      if (authEvt && authEvt.type === "provider_auth_result") {
        expect(authEvt.ok).toBe(true);
        expect(authEvt.provider).toBe("opencode-zen");
        expect(authEvt.methodId).toBe("api_key");
        expect(authEvt.message).toContain("Copied OpenCode Go API key");
      }
      expect(connectProviderImpl).toHaveBeenCalledTimes(1);
      expect(connectProviderImpl.mock.calls[0]?.[0]?.provider).toBe("opencode-zen");
      expect(connectProviderImpl.mock.calls[0]?.[0]?.apiKey).toBe("opencode-go-key-1234");
      expect(events.some((e) => e.type === "provider_status")).toBe(true);
      expect(events.some((e) => e.type === "provider_catalog")).toBe(true);
    });

    test("callbackProviderAuth emits provider_auth_result for oauth method", async () => {
      const getProviderCatalogImpl = mock(async () => ({
        all: [{ id: "codex-cli", name: "Codex CLI", models: ["gpt-5.2"], defaultModel: "gpt-5.2" }],
        default: { "codex-cli": "gpt-5.2" },
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
      (session as any).state.providerState = {
        provider: "codex-cli",
        model: "gpt-5.2",
        responseId: "resp_before_oauth",
        updatedAt: "2026-02-16T00:00:00.000Z",
        accountId: "acct_123",
      };

      await session.authorizeProviderAuth("codex-cli", "oauth_cli");
      await session.callbackProviderAuth("codex-cli", "oauth_cli");

      const authEvt = events.find((e) => e.type === "provider_auth_result");
      expect(authEvt).toBeDefined();
      if (authEvt && authEvt.type === "provider_auth_result") {
        expect(authEvt.ok).toBe(true);
        expect(authEvt.provider).toBe("codex-cli");
      }
      expect((session as any).state.providerState).toBeNull();
    });

    test("callbackProviderAuth rejects pasted auth codes for auto Codex oauth", async () => {
      const getProviderCatalogImpl = mock(async () => ({
        all: [{ id: "codex-cli", name: "Codex CLI", models: ["gpt-5.2"], defaultModel: "gpt-5.2" }],
        default: { "codex-cli": "gpt-5.2" },
        connected: ["codex-cli"],
      }));
      const getProviderStatusesImpl = mock(async () => []);
      const { session, events } = makeSession({
        connectProviderImpl: mockConnectModelProvider,
        getAiCoworkerPathsImpl: mockGetAiCoworkerPaths,
        getProviderCatalogImpl: getProviderCatalogImpl as any,
        getProviderStatusesImpl: getProviderStatusesImpl as any,
      });
      (session as any).state.providerState = {
        provider: "codex-cli",
        model: "gpt-5.2",
        responseId: "resp_before_oauth",
        updatedAt: "2026-02-16T00:00:00.000Z",
        accountId: "acct_123",
      };

      await session.authorizeProviderAuth("codex-cli", "oauth_cli");
      await session.callbackProviderAuth("codex-cli", "oauth_cli", "manual-auth-code");

      const authEvt = events.findLast((e) => e.type === "provider_auth_result");
      expect(authEvt).toBeDefined();
      if (authEvt && authEvt.type === "provider_auth_result") {
        expect(authEvt.ok).toBe(false);
        expect(authEvt.provider).toBe("codex-cli");
        expect(authEvt.methodId).toBe("oauth_cli");
        expect(authEvt.message).toContain("does not accept a pasted authorization code");
      }
      expect(mockConnectModelProvider).not.toHaveBeenCalled();
    });

    test("logoutProviderAuth emits provider_auth_result and clears provider state", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-provider-logout-"));
      const getProviderCatalogImpl = mock(async () => ({
        all: [{ id: "codex-cli", name: "Codex CLI", models: ["gpt-5.2"], defaultModel: "gpt-5.2" }],
        default: { "codex-cli": "gpt-5.2" },
        connected: [],
      }));
      const getProviderStatusesImpl = mock(async () => []);
      const connectProviderImpl = mock(async (_opts: any) => ({
        ok: true,
        provider: "codex-cli",
        mode: "oauth",
        storageFile: "/tmp/mock-home/.cowork/auth/connections.json",
        message: "OAuth sign-in completed.",
      }));
      const { session, events } = makeSession({
        config: makeConfig(dir),
        connectProviderImpl: connectProviderImpl as any,
        getAiCoworkerPathsImpl: mockGetAiCoworkerPaths,
        getProviderCatalogImpl: getProviderCatalogImpl as any,
        getProviderStatusesImpl: getProviderStatusesImpl as any,
      });
      (session as any).state.providerState = {
        provider: "codex-cli",
        model: "gpt-5.2",
        responseId: "resp_before_logout",
        updatedAt: "2026-02-16T00:00:00.000Z",
        accountId: "acct_123",
      };

      await session.logoutProviderAuth("codex-cli");

      const authEvt = events.findLast((e) => e.type === "provider_auth_result");
      expect(authEvt).toBeDefined();
      if (authEvt && authEvt.type === "provider_auth_result") {
        expect(authEvt.ok).toBe(true);
        expect(authEvt.provider).toBe("codex-cli");
        expect(authEvt.methodId).toBe("logout");
      }
      expect(events.some((e) => e.type === "provider_status")).toBe(true);
      expect(events.some((e) => e.type === "provider_catalog")).toBe(true);
      expect((session as any).state.providerState).toBeNull();
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

      expect(mockGetAiCoworkerPaths).toHaveBeenCalledWith({ homedir: os.homedir() });
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
});
