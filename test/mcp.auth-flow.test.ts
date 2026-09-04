import { beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readMCPServerOAuthPending, setMCPServerOAuthPending } from "../src/mcp/authStore";
import type { MCPRegistryServer } from "../src/mcp/configRegistry";
import { scratchRoots } from "../src/platform/sandbox/policy";
import type { SessionEvent } from "../src/server/protocol";
import { McpAuthFlow } from "../src/server/session/mcp/McpAuthFlow";
import type { AgentConfig } from "../src/types";

const mockAuthorizeMcpServerOAuth = mock(async () => {
  throw new Error("mockAuthorizeMcpServerOAuth not configured");
});
const mockConsumeCapturedOAuthCode = mock(async () => undefined as string | undefined);
const mockExchangeMcpServerOAuthCode = mock(async () => {
  throw new Error("mockExchangeMcpServerOAuthCode not configured");
});

function makeConfig(
  workspaceRoot: string,
  userHome: string,
  builtInConfigDir: string,
): AgentConfig {
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
    workingDirectory: workspaceRoot,
    outputDirectory: path.join(workspaceRoot, "output"),
    uploadsDirectory: path.join(workspaceRoot, "uploads"),
    userName: "tester",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(workspaceRoot, ".cowork"),
    userCoworkDir: path.join(userHome, ".cowork"),
    builtInDir: path.dirname(builtInConfigDir),
    builtInConfigDir,
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    enableMcp: true,
  };
}

function inheritedOauthServer(name: string): MCPRegistryServer {
  return {
    name,
    source: "system",
    inherited: true,
    transport: { type: "http", url: "https://mcp.quartr.com/mcp" },
    auth: { type: "oauth", oauthMode: "auto", scope: "read" },
  };
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

function createHarness(
  config: AgentConfig,
  server: MCPRegistryServer,
  resolveByName = async (nameRaw: string): Promise<MCPRegistryServer | null> =>
    nameRaw.trim() === server.name ? server : null,
) {
  const events: SessionEvent[] = [];
  const state = {
    config,
    connecting: false,
    running: false,
  };
  const context = {
    id: "session-mcp-auth-flow",
    state,
    emit: (event: SessionEvent) => {
      events.push(event);
    },
    emitError: (code: string, source: string, message: string) => {
      events.push({
        type: "error",
        sessionId: "session-mcp-auth-flow",
        code,
        source,
        message,
      } as SessionEvent);
    },
    guardBusy: () => !state.running && !state.connecting,
  } as any;
  let emitMcpServersCalls = 0;
  const flow = new McpAuthFlow(
    context,
    { resolveByName } as any,
    async () => {
      emitMcpServersCalls += 1;
    },
    {
      authorizeMCPServerOAuth: mockAuthorizeMcpServerOAuth,
      consumeCapturedOAuthCode: mockConsumeCapturedOAuthCode,
      exchangeMCPServerOAuthCode: mockExchangeMcpServerOAuthCode,
    },
  );
  return {
    flow,
    events,
    state,
    getEmitMcpServersCalls: () => emitMcpServersCalls,
  };
}

describe("McpAuthFlow", () => {
  beforeEach(() => {
    mockAuthorizeMcpServerOAuth.mockReset();
    mockConsumeCapturedOAuthCode.mockReset();
    mockExchangeMcpServerOAuthCode.mockReset();
  });

  test.each(["authorize", "callback", "setApiKey"] as const)(
    "%s serializes MCP work without changing provider connection state",
    async (method) => {
      const lookupReady = Promise.withResolvers<void>();
      const lookup = mock(async () => {
        await lookupReady.promise;
        return null;
      });
      const { flow, state, events } = createHarness(
        makeConfig("/unused-workspace", "/unused-home", "/unused-builtin"),
        inheritedOauthServer("probe"),
        lookup,
      );
      const invoke = () =>
        method === "setApiKey" ? flow.setApiKey("probe", "test-key") : flow[method]("probe");
      const first = invoke();
      const second = invoke();
      const completed = Promise.all([first, second]);
      try {
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(state.connecting).toBe(false);
        expect(events.some((event) => event.type === "error" && event.code === "busy")).toBe(true);
        lookupReady.resolve();
        await completed;
        expect(state.connecting).toBe(false);

        lookup.mockRejectedValueOnce(new Error("Lookup failed"));
        await invoke();
        expect(state.connecting).toBe(false);
        expect(
          events.some(
            (event) =>
              event.type === "mcp_server_auth_result" &&
              !event.ok &&
              event.message?.includes("Lookup failed"),
          ),
        ).toBe(true);
      } finally {
        lookupReady.resolve();
        await completed;
        flow.close();
      }
    },
  );

  for (const busyState of ["running", "connecting"] as const) {
    test.each(["authorize", "callback", "setApiKey"] as const)(
      `%s remains available while model state is ${busyState}`,
      async (method) => {
        const lookup = mock(async () => null);
        const { flow, state, events } = createHarness(
          makeConfig("/unused-workspace", "/unused-home", "/unused-builtin"),
          inheritedOauthServer("probe"),
          lookup,
        );
        state[busyState] = true;
        try {
          if (method === "setApiKey") await flow.setApiKey("probe", "test-key");
          else await flow[method]("probe");
          expect(lookup).toHaveBeenCalledTimes(1);
          expect(state[busyState]).toBe(true);
          expect(events.some((event) => event.type === "error")).toBe(false);
        } finally {
          flow.close();
        }
      },
    );
  }

  test("auto OAuth completes during model work and writes the user auth file", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-flow-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-flow-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-flow-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);
    const server = inheritedOauthServer("quartr");
    const { flow, events, state, getEmitMcpServersCalls } = createHarness(config, server);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const userAuthFile = path.join(home, ".cowork", "auth", "mcp-credentials.json");

    try {
      mockAuthorizeMcpServerOAuth.mockResolvedValue({
        challenge: {
          method: "auto",
          instructions: "Complete sign-in in your browser.",
          url: "https://mcp.quartr.com/oauth/authorize?client_id=test-client",
          expiresAt,
        },
        pending: {
          challengeId: "challenge-1",
          state: "state-1",
          codeVerifier: "code-verifier-1",
          redirectUri: "http://127.0.0.1:1455/oauth/callback",
          createdAt,
          expiresAt,
          authorizationServerUrl: "https://mcp.quartr.com",
          resource: "https://mcp.quartr.com/",
        },
        openedBrowser: true,
      });

      let consumeCalls = 0;
      mockConsumeCapturedOAuthCode.mockImplementation(async () => {
        consumeCalls += 1;
        return consumeCalls >= 2 ? "oauth-code-1" : undefined;
      });

      mockExchangeMcpServerOAuthCode.mockImplementation(async ({ code, pending }: any) => ({
        tokens: {
          accessToken: `access-for-${code}`,
          refreshToken: "refresh-token-1",
          tokenType: "Bearer",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          scope: "read",
          resource: pending.resource,
          updatedAt: new Date().toISOString(),
        },
        message: "OAuth token exchange successful.",
      }));

      await flow.authorize("quartr");
      state.running = true;
      state.connecting = true;

      expect(
        events.some(
          (event) => event.type === "mcp_server_auth_challenge" && event.name === "quartr",
        ),
      ).toBe(true);

      await waitForCondition(async () => {
        const raw = await fs.readFile(userAuthFile, "utf-8").catch(() => null);
        if (!raw) return false;
        const parsed = JSON.parse(raw) as {
          servers?: Record<
            string,
            { oauth?: { pending?: unknown; tokens?: { accessToken?: string } } }
          >;
        };
        return (
          parsed.servers?.quartr?.oauth?.tokens?.accessToken === "access-for-oauth-code-1" &&
          parsed.servers?.quartr?.oauth?.pending === undefined &&
          events.some(
            (event) =>
              event.type === "mcp_server_auth_result" &&
              event.name === "quartr" &&
              event.ok &&
              event.mode === "oauth",
          )
        );
      });

      expect(mockConsumeCapturedOAuthCode).toHaveBeenCalledTimes(2);
      expect(mockExchangeMcpServerOAuthCode).toHaveBeenCalledTimes(1);
      expect(getEmitMcpServersCalls()).toBe(2);
      expect(state.running).toBe(true);
      expect(state.connecting).toBe(true);
    } finally {
      state.running = false;
      state.connecting = false;
      flow.close();
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("an older token exchange cannot clear a newer authorization challenge", async () => {
    const scratchRoot = scratchRoots()[0];
    const workspace = await fs.mkdtemp(path.join(scratchRoot, "mcp-auth-flow-stale-workspace-"));
    const home = await fs.mkdtemp(path.join(scratchRoot, "mcp-auth-flow-stale-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(scratchRoot, "mcp-auth-flow-stale-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);
    const server = inheritedOauthServer("quartr");
    const older = createHarness(config, server);
    const newer = createHarness(config, server);
    const pending = {
      challengeId: "older-challenge",
      state: "older-state",
      codeVerifier: "older-verifier",
      redirectUri: "http://127.0.0.1:1455/oauth/callback",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      authorizationServerUrl: "https://mcp.quartr.com",
    };
    const exchangeStarted = Promise.withResolvers<void>();
    const releaseExchange = Promise.withResolvers<void>();
    let completion: ReturnType<McpAuthFlow["callback"]> | undefined;
    try {
      await setMCPServerOAuthPending({ config, server, pending });
      mockExchangeMcpServerOAuthCode.mockImplementation(async () => {
        exchangeStarted.resolve();
        await releaseExchange.promise;
        return { tokens: { accessToken: "older-token" }, message: "Token exchange successful." };
      });
      completion = older.flow.callback(server.name, "older-code");
      await exchangeStarted.promise;

      mockAuthorizeMcpServerOAuth.mockResolvedValue({
        challenge: {
          method: "code",
          instructions: "Complete the newer sign-in.",
          url: "https://mcp.quartr.com/oauth/authorize",
          expiresAt: pending.expiresAt,
        },
        pending: { ...pending, challengeId: "newer-challenge", state: "newer-state" },
        openedBrowser: false,
      });
      await newer.flow.authorize(server.name);
      releaseExchange.resolve();

      await expect(completion).resolves.toBeNull();
      await expect(readMCPServerOAuthPending({ config, server })).resolves.toMatchObject({
        pending: { challengeId: "newer-challenge" },
      });
      expect(
        older.events.some((event) => event.type === "mcp_server_auth_result" && event.ok),
      ).toBe(false);
    } finally {
      releaseExchange.resolve();
      await completion;
      older.flow.close();
      newer.flow.close();
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("close does not abort in-flight auto OAuth completion", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-flow-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-flow-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-flow-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);
    const server = inheritedOauthServer("quartr");
    const { flow, events } = createHarness(config, server);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const userAuthFile = path.join(home, ".cowork", "auth", "mcp-credentials.json");

    try {
      mockAuthorizeMcpServerOAuth.mockResolvedValue({
        challenge: {
          method: "auto",
          instructions: "Complete sign-in in your browser.",
          url: "https://mcp.quartr.com/oauth/authorize?client_id=test-client",
          expiresAt,
        },
        pending: {
          challengeId: "challenge-close",
          state: "state-close",
          codeVerifier: "code-verifier-close",
          redirectUri: "http://127.0.0.1:1455/oauth/callback",
          createdAt,
          expiresAt,
          authorizationServerUrl: "https://mcp.quartr.com",
          resource: "https://mcp.quartr.com/",
        },
        openedBrowser: true,
      });

      let consumeCalls = 0;
      mockConsumeCapturedOAuthCode.mockImplementation(async () => {
        consumeCalls += 1;
        return consumeCalls >= 3 ? "oauth-code-close" : undefined;
      });

      mockExchangeMcpServerOAuthCode.mockImplementation(async ({ code }: any) => ({
        tokens: {
          accessToken: `access-for-${code}`,
          refreshToken: "refresh-token-close",
          tokenType: "Bearer",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          scope: "read",
          updatedAt: new Date().toISOString(),
        },
        message: "OAuth token exchange successful.",
      }));

      await flow.authorize("quartr");
      flow.close();

      await waitForCondition(async () => {
        const raw = await fs.readFile(userAuthFile, "utf-8").catch(() => null);
        if (!raw) return false;
        const parsed = JSON.parse(raw) as {
          servers?: Record<string, { oauth?: { tokens?: { accessToken?: string } } }>;
        };
        return parsed.servers?.quartr?.oauth?.tokens?.accessToken === "access-for-oauth-code-close";
      });

      expect(
        events.some(
          (event) =>
            event.type === "mcp_server_auth_result" &&
            event.name === "quartr" &&
            event.ok &&
            event.mode === "oauth",
        ),
      ).toBe(true);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });
});
