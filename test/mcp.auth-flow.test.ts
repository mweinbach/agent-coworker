import { beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MCPRegistryServer } from "../src/mcp/configRegistry";
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
    projectAgentDir: path.join(workspaceRoot, ".agent"),
    userAgentDir: path.join(userHome, ".agent"),
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

function createHarness(config: AgentConfig, server: MCPRegistryServer) {
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
    guardBusy: () => !state.running && !state.connecting,
  } as any;
  let emitMcpServersCalls = 0;
  const flow = new McpAuthFlow(
    context,
    {
      resolveByName: async (nameRaw: string) => (nameRaw.trim() === server.name ? server : null),
    } as any,
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
    getEmitMcpServersCalls: () => emitMcpServersCalls,
  };
}

describe("McpAuthFlow", () => {
  beforeEach(() => {
    mockAuthorizeMcpServerOAuth.mockReset();
    mockConsumeCapturedOAuthCode.mockReset();
    mockExchangeMcpServerOAuthCode.mockReset();
  });
  test("auto OAuth completes from the captured callback and writes the user auth file", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-flow-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-flow-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-flow-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);
    const server = inheritedOauthServer("quartr");
    const { flow, events, getEmitMcpServersCalls } = createHarness(config, server);
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
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });
});
