import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentConfig } from "../src/types";
import {
  completeMCPServerOAuth,
  readMCPAuthFiles,
  resolveMCPServerAuthState,
  setMCPServerApiKeyCredential,
  setMCPServerOAuthPending,
  type MCPServerOAuthPending,
} from "../src/mcp/authStore";
import type { MCPRegistryServer } from "../src/mcp/configRegistry";

function makeConfig(workspaceRoot: string, userHome: string, builtInConfigDir: string): AgentConfig {
  return {
    provider: "google",
    model: "gemini-2.0-flash",
    subAgentModel: "gemini-2.0-flash",
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
      expect(result.storageFile).toBe(path.join(workspace, ".cowork", "auth", "mcp-credentials.json"));

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
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-inherited-builtin-"));
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

  test("resolveMCPServerAuthState derives missing/api_key/oauth_pending", async () => {
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

      expect(fileStat.mode & 0o777).toBe(0o600);
      expect(dirStat.mode & 0o777).toBe(0o700);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });
});
