import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  completeMCPServerOAuth,
  type MCPServerOAuthPending,
  readMCPAuthFiles,
  readMCPServerOAuthPending,
  renameMCPServerCredentials,
  resolveMCPServerAuthState,
  setMCPServerApiKeyCredential,
  setMCPServerOAuthClientInformation,
  setMCPServerOAuthPending,
} from "../src/mcp/authStore";
import type { MCPRegistryServer } from "../src/mcp/configRegistry";
import type { AgentConfig } from "../src/types";

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

function workspaceServer(name: string): MCPRegistryServer {
  return {
    name,
    source: "workspace",
    inherited: false,
    transport: { type: "http", url: "https://mcp.example.com" },
    auth: { type: "api_key", headerName: "Authorization", prefix: "Bearer" },
  };
}

function inheritedServer(name: string): MCPRegistryServer {
  return {
    name,
    source: "system",
    inherited: true,
    transport: { type: "http", url: "https://mcp.example.com" },
    auth: { type: "api_key", headerName: "Authorization", prefix: "Bearer" },
  };
}

function pluginServer(name: string, pluginScope: "workspace" | "user"): MCPRegistryServer {
  return {
    name,
    source: "plugin",
    inherited: pluginScope !== "workspace",
    pluginId: `${name}-plugin`,
    pluginName: `${name}-plugin`,
    pluginDisplayName: `${name} Plugin`,
    pluginScope,
    transport: { type: "http", url: "https://mcp.plugin.example.com" },
    auth: { type: "oauth", oauthMode: "auto" },
  };
}

describe("mcp auth store", () => {
  test("workspace server credentials write to workspace auth file", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const result = await setMCPServerApiKeyCredential({
        config,
        server: workspaceServer("workspace-key"),
        apiKey: "workspace-secret",
      });
      expect(result.scope).toBe("workspace");
      expect(result.storageFile).toBe(
        path.join(workspace, ".cowork", "auth", "mcp-credentials.json"),
      );

      const workspaceRaw = await fs.readFile(result.storageFile, "utf-8");
      expect(workspaceRaw).toContain("workspace-secret");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("inherited server credentials write to user auth file", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-inherited-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-inherited-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-auth-inherited-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const result = await setMCPServerApiKeyCredential({
        config,
        server: inheritedServer("system-key"),
        apiKey: "user-secret",
      });
      expect(result.scope).toBe("user");
      expect(result.storageFile).toBe(path.join(home, ".cowork", "auth", "mcp-credentials.json"));

      const userRaw = await fs.readFile(result.storageFile, "utf-8");
      expect(userRaw).toContain("user-secret");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("workspace auth resolution does not fall back to user credentials for shadowed names", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-scope-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-scope-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-scope-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      await setMCPServerApiKeyCredential({
        config,
        server: inheritedServer("shadowed"),
        apiKey: "user-secret",
      });

      const state = await resolveMCPServerAuthState(config, workspaceServer("shadowed"));
      expect(state.mode).toBe("missing");
      expect(state.scope).toBe("workspace");
      expect(state.message).toContain("API key required");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("workspace-scoped plugin OAuth state stays in workspace auth storage", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-plugin-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-plugin-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-plugin-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);
    const server = pluginServer("plugin-oauth", "workspace");

    try {
      await setMCPServerOAuthPending({
        config,
        server,
        pending: {
          challengeId: "challenge-1",
          state: "state-1",
          codeVerifier: "verifier-1",
          redirectUri: "http://127.0.0.1/callback",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });

      const workspaceFiles = await readMCPAuthFiles(config);
      expect(
        workspaceFiles.workspace.doc.servers["plugin-oauth"]?.oauth?.pending?.challengeId,
      ).toBe("challenge-1");
      expect(workspaceFiles.user.doc.servers["plugin-oauth"]).toBeUndefined();

      const pendingState = await readMCPServerOAuthPending({ config, server });
      expect(pendingState.scope).toBe("workspace");
      expect(pendingState.pending?.challengeId).toBe("challenge-1");

      await completeMCPServerOAuth({
        config,
        server,
        tokens: {
          accessToken: "workspace-access-token",
          tokenType: "Bearer",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });

      const resolved = await resolveMCPServerAuthState(config, server);
      expect(resolved.scope).toBe("workspace");
      expect(resolved.mode).toBe("oauth");
      expect(resolved.oauthTokens?.accessToken).toBe("workspace-access-token");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("user-scoped plugin OAuth state stays in user auth storage", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-plugin-user-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-plugin-user-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-auth-plugin-user-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);
    const server = pluginServer("plugin-user-oauth", "user");

    try {
      await setMCPServerOAuthPending({
        config,
        server,
        pending: {
          challengeId: "challenge-2",
          state: "state-2",
          codeVerifier: "verifier-2",
          redirectUri: "http://127.0.0.1/callback",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });

      const files = await readMCPAuthFiles(config);
      expect(files.workspace.doc.servers["plugin-user-oauth"]).toBeUndefined();
      expect(files.user.doc.servers["plugin-user-oauth"]?.oauth?.pending?.challengeId).toBe(
        "challenge-2",
      );

      const pendingState = await readMCPServerOAuthPending({ config, server });
      expect(pendingState.scope).toBe("user");
      expect(pendingState.pending?.challengeId).toBe("challenge-2");

      await completeMCPServerOAuth({
        config,
        server,
        tokens: {
          accessToken: "user-access-token",
          tokenType: "Bearer",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });

      const resolved = await resolveMCPServerAuthState(config, server);
      expect(resolved.scope).toBe("user");
      expect(resolved.mode).toBe("oauth");
      expect(resolved.oauthTokens?.accessToken).toBe("user-access-token");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("resolveMCPServerAuthState derives missing/api_key/oauth_pending and handles expired oauth tokens", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-mode-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-mode-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-mode-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const apiServer = workspaceServer("api-server");
      const missing = await resolveMCPServerAuthState(config, apiServer);
      expect(missing.mode).toBe("missing");

      await setMCPServerApiKeyCredential({ config, server: apiServer, apiKey: "secret" });
      const api = await resolveMCPServerAuthState(config, apiServer);
      expect(api.mode).toBe("api_key");

      const oauthServer: MCPRegistryServer = {
        name: "oauth-server",
        source: "workspace",
        inherited: false,
        transport: { type: "http", url: "https://mcp.oauth.example.com" },
        auth: { type: "oauth", oauthMode: "auto" },
      };
      const pending: MCPServerOAuthPending = {
        challengeId: "challenge-1",
        state: "state-1",
        codeVerifier: "verifier-1",
        redirectUri: "http://127.0.0.1/callback",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
      await setMCPServerOAuthPending({ config, server: oauthServer, pending });
      const oauthPending = await resolveMCPServerAuthState(config, oauthServer);
      expect(oauthPending.mode).toBe("oauth_pending");

      await completeMCPServerOAuth({
        config,
        server: oauthServer,
        tokens: {
          accessToken: "expired-token",
          tokenType: "Bearer",
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        },
      });
      const oauthExpired = await resolveMCPServerAuthState(config, oauthServer);
      expect(oauthExpired.mode).toBe("error");
      expect(oauthExpired.message).toContain("expired");

      await completeMCPServerOAuth({
        config,
        server: oauthServer,
        tokens: {
          accessToken: "expired-token-refreshable",
          tokenType: "Bearer",
          refreshToken: "refresh-token",
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        },
      });
      const oauthRefreshable = await resolveMCPServerAuthState(config, oauthServer);
      expect(oauthRefreshable.mode).toBe("oauth");
      expect(oauthRefreshable.message).toContain("refresh token");
      expect(oauthRefreshable.oauthTokens?.refreshToken).toBe("refresh-token");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("credential files are hardened with 0600 and auth dirs with 0700", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-perms-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-perms-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-perms-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      await setMCPServerApiKeyCredential({
        config,
        server: workspaceServer("perms"),
        apiKey: "secret",
      });

      const files = await readMCPAuthFiles(config);
      const authDirPath = path.dirname(files.workspace.filePath);
      const fileStat = await fs.stat(files.workspace.filePath);
      const dirStat = await fs.stat(authDirPath);

      if (process.platform === "win32") {
        // Windows only exposes limited POSIX mode semantics; assert writable owner bits exist.
        expect(fileStat.mode & 0o200).toBe(0o200);
        expect(dirStat.mode & 0o200).toBe(0o200);
      } else {
        expect(fileStat.mode & 0o777).toBe(0o600);
        expect(dirStat.mode & 0o777).toBe(0o700);
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("setMCPServerApiKeyCredential recovers from malformed auth store and rewrites sanitized doc", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-malformed-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-malformed-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-auth-malformed-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);
    const authFile = path.join(workspace, ".cowork", "auth", "mcp-credentials.json");

    try {
      await fs.mkdir(path.dirname(authFile), { recursive: true });
      await fs.writeFile(authFile, "{ this is not valid JSON", "utf-8");

      const result = await setMCPServerApiKeyCredential({
        config,
        server: workspaceServer("workspace-key"),
        apiKey: "workspace-secret",
      });

      expect(result.scope).toBe("workspace");

      const parsed = JSON.parse(await fs.readFile(authFile, "utf-8")) as Record<string, any>;
      expect(parsed.version).toBe(1);
      expect(parsed.servers?.["workspace-key"]?.apiKey?.value).toBe("workspace-secret");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("setMCPServerOAuthClientInformation persists redirect URIs for dynamic clients", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-clientinfo-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-clientinfo-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-auth-clientinfo-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const oauthServer: MCPRegistryServer = {
        name: "oauth-server",
        source: "workspace",
        inherited: false,
        transport: { type: "http", url: "https://mcp.oauth.example.com" },
        auth: { type: "oauth", oauthMode: "auto" },
      };

      await setMCPServerOAuthClientInformation({
        config,
        server: oauthServer,
        clientInformation: {
          clientId: "registered-client",
          clientSecret: "registered-secret",
          tokenEndpointAuthMethod: "none",
          redirectUris: [
            "http://127.0.0.1:1455/oauth/callback",
            "http://127.0.0.1:2455/oauth/callback",
          ],
        },
      });

      const files = await readMCPAuthFiles(config);
      expect(files.workspace.doc.servers["oauth-server"]?.oauth?.clientInformation).toMatchObject({
        clientId: "registered-client",
        clientSecret: "registered-secret",
        tokenEndpointAuthMethod: "none",
        redirectUris: [
          "http://127.0.0.1:1455/oauth/callback",
          "http://127.0.0.1:2455/oauth/callback",
        ],
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("renameMCPServerCredentials re-keys workspace credentials for renamed servers", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-rename-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-rename-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-rename-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      await setMCPServerApiKeyCredential({
        config,
        server: workspaceServer("old-name"),
        apiKey: "workspace-secret",
      });

      const rename = await renameMCPServerCredentials({
        config,
        source: "workspace",
        previousName: "old-name",
        nextName: "new-name",
      });
      expect(rename.moved).toBe(true);
      expect(rename.scope).toBe("workspace");

      const files = await readMCPAuthFiles(config);
      expect(files.workspace.doc.servers["old-name"]).toBeUndefined();
      expect(files.workspace.doc.servers["new-name"]?.apiKey?.value).toBe("workspace-secret");

      const newState = await resolveMCPServerAuthState(config, workspaceServer("new-name"));
      expect(newState.mode).toBe("api_key");
      const oldState = await resolveMCPServerAuthState(config, workspaceServer("old-name"));
      expect(oldState.mode).toBe("missing");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });
});
