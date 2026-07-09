import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  deleteMCPServer,
  loadMCPConfigRegistry,
  upsertMCPServer,
  upsertWorkspaceMCPServer,
} from "../src/mcp/configRegistry";
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
    projectCoworkDir: path.join(workspaceRoot, ".cowork"),
    userCoworkDir: path.join(userHome, ".cowork"),
    workspaceAgentsDir: path.join(workspaceRoot, ".agents"),
    userAgentsDir: path.join(userHome, ".agents"),
    workspacePluginsDir: path.join(workspaceRoot, ".agents", "plugins"),
    userPluginsDir: path.join(userHome, ".agents", "plugins"),
    builtInDir: path.dirname(builtInConfigDir),
    builtInConfigDir,
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    enableMcp: true,
  };
}

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

describe("mcp config registry", () => {
  test("workspace/user/system precedence ignores legacy .agent MCP files", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-home-"));
    const builtInDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-builtin-"));
    const builtInConfigDir = path.join(builtInDir, "config");
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      await writeJson(path.join(builtInConfigDir, "mcp-servers.json"), {
        servers: [{ name: "shared", transport: { type: "stdio", command: "system" } }],
      });
      await writeJson(path.join(home, ".cowork", "config", "mcp-servers.json"), {
        servers: [{ name: "shared", transport: { type: "stdio", command: "user" } }],
      });
      await writeJson(path.join(workspace, ".agent", "mcp-servers.json"), {
        servers: [{ name: "legacy-ws", transport: { type: "stdio", command: "legacy" } }],
      });
      await writeJson(path.join(workspace, ".cowork", "mcp-servers.json"), {
        servers: [{ name: "shared", transport: { type: "stdio", command: "workspace" } }],
      });

      const snapshot = await loadMCPConfigRegistry(config);

      // workspace still wins for "shared" due to higher precedence
      const shared = snapshot.servers.find((server) => server.name === "shared");
      expect(shared?.source).toBe("workspace");

      const legacyWs = snapshot.servers.find((server) => server.name === "legacy-ws");
      expect(legacyWs).toBeUndefined();

      expect(snapshot.files.some((file) => file.source === "workspace" && file.legacy)).toBe(false);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInDir, { recursive: true, force: true });
    }
  });

  test("invalid workspace json records warning and still loads other layers", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-invalid-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-invalid-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-registry-invalid-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      await writeJson(path.join(home, ".cowork", "config", "mcp-servers.json"), {
        servers: [{ name: "from-user", transport: { type: "stdio", command: "user" } }],
      });
      await fs.mkdir(path.join(workspace, ".cowork"), { recursive: true });
      await fs.writeFile(
        path.join(workspace, ".cowork", "mcp-servers.json"),
        "{ bad json",
        "utf-8",
      );
      const snapshot = await loadMCPConfigRegistry(config);

      expect(snapshot.servers.find((server) => server.name === "from-user")?.source).toBe("user");
      const workspaceFile = snapshot.files.find((file) => file.source === "workspace");
      expect(workspaceFile?.exists).toBe(true);
      expect(workspaceFile?.serverCount).toBe(0);
      expect(workspaceFile?.parseError).toContain("invalid JSON");
      expect(snapshot.warnings).toHaveLength(1);
      expect(snapshot.warnings[0]).toContain("workspace");
      expect(snapshot.warnings[0]).toContain(path.join(workspace, ".cowork", "mcp-servers.json"));
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("plugin MCP servers retain oauth auth config and plugin scope metadata", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-registry-plugin-oauth-workspace-"),
    );
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-plugin-oauth-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-registry-plugin-oauth-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const pluginRoot = path.join(workspace, ".agents", "plugins", "oauth-toolkit");
      await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify(
          {
            name: "oauth-toolkit",
            description: "Plugin oauth helpers",
            interface: { displayName: "OAuth Toolkit" },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      await fs.writeFile(
        path.join(pluginRoot, ".mcp.json"),
        `${JSON.stringify(
          {
            mcpServers: {
              oauthPlugin: {
                type: "http",
                url: "https://mcp.plugin.example.com",
                auth: {
                  type: "oauth",
                  oauthMode: "auto",
                  scope: "plugin.read",
                },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const snapshot = await loadMCPConfigRegistry(config);
      const server = snapshot.servers.find((entry) => entry.name === "oauthPlugin");
      expect(server).toBeTruthy();
      expect(server?.source).toBe("plugin");
      expect(server?.pluginId).toBe("oauth-toolkit");
      expect(server?.pluginDisplayName).toBe("OAuth Toolkit");
      expect(server?.pluginScope).toBe("workspace");
      expect(server?.inherited).toBe(false);
      expect(server?.auth).toEqual({
        type: "oauth",
        oauthMode: "auto",
        scope: "plugin.read",
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("icon round-trips through upsert and registry read", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-icon-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-icon-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-icon-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      await upsertWorkspaceMCPServer(config, {
        name: "iconized",
        transport: { type: "http", url: "https://mcp.example.com" },
        icon: "https://example.com/icon.png",
      });

      const snapshot = await loadMCPConfigRegistry(config);
      const server = snapshot.servers.find((entry) => entry.name === "iconized");
      expect(server?.icon).toBe("https://example.com/icon.png");

      const raw = JSON.parse(
        await fs.readFile(path.join(workspace, ".cowork", "mcp-servers.json"), "utf-8"),
      );
      expect(raw.servers[0].icon).toBe("https://example.com/icon.png");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("plugin MCP servers fall back to the owning plugin's icon", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-plugin-icon-ws-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-plugin-icon-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-registry-plugin-icon-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const pluginRoot = path.join(workspace, ".agents", "plugins", "icon-toolkit");
      await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify(
          {
            name: "icon-toolkit",
            description: "Plugin icon helpers",
            interface: { displayName: "Icon Toolkit", logo: "https://example.com/plugin-logo.png" },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      await fs.writeFile(
        path.join(pluginRoot, ".mcp.json"),
        `${JSON.stringify(
          {
            mcpServers: {
              inheritsIcon: { type: "http", url: "https://mcp.plugin.example.com" },
              ownIcon: {
                type: "http",
                url: "https://mcp2.plugin.example.com",
                icon: "https://example.com/server-icon.png",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const snapshot = await loadMCPConfigRegistry(config);
      const inherited = snapshot.servers.find((entry) => entry.name === "inheritsIcon");
      expect(inherited?.icon).toBe("https://example.com/plugin-logo.png");
      const explicit = snapshot.servers.find((entry) => entry.name === "ownIcon");
      expect(explicit?.icon).toBe("https://example.com/server-icon.png");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("plugin MCP stdio transports rebase only filesystem paths against the plugin root", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-registry-plugin-stdio-workspace-"),
    );
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-plugin-stdio-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-registry-plugin-stdio-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const pluginRoot = path.join(workspace, ".agents", "plugins", "stdio-toolkit");
      await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
      await fs.mkdir(path.join(pluginRoot, "bin"), { recursive: true });
      await fs.mkdir(path.join(pluginRoot, "dist"), { recursive: true });
      await fs.mkdir(path.join(pluginRoot, "nested"), { recursive: true });
      await fs.mkdir(path.join(pluginRoot, "runtime"), { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify(
          {
            name: "stdio-toolkit",
            description: "Plugin stdio helpers",
            interface: { displayName: "Stdio Toolkit" },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      await fs.writeFile(path.join(pluginRoot, "bin", "server.js"), "// server\n", "utf-8");
      await fs.writeFile(path.join(pluginRoot, "dist", "server.mjs"), "// bundled\n", "utf-8");
      await fs.writeFile(path.join(pluginRoot, "nested", "server.js"), "// nested\n", "utf-8");
      await fs.writeFile(
        path.join(pluginRoot, ".mcp.json"),
        `${JSON.stringify(
          {
            mcpServers: {
              bundledServer: {
                type: "stdio",
                command: "./bin/server.js",
                args: [
                  "./dist/server.mjs",
                  "nested/server.js",
                  "@modelcontextprotocol/server-filesystem",
                  "https://api.example.com",
                  "--port",
                  "7337",
                ],
                cwd: "./runtime",
              },
              pathServer: {
                type: "stdio",
                command: "node",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const snapshot = await loadMCPConfigRegistry(config);
      const bundledServer = snapshot.servers.find((entry) => entry.name === "bundledServer");
      expect(bundledServer?.transport.type).toBe("stdio");
      if (bundledServer?.transport.type === "stdio") {
        expect(bundledServer.transport.command).toBe(path.join(pluginRoot, "bin", "server.js"));
        expect(bundledServer.transport.cwd).toBe(path.join(pluginRoot, "runtime"));
        expect(bundledServer.transport.args).toEqual([
          path.join(pluginRoot, "dist", "server.mjs"),
          path.join(pluginRoot, "nested", "server.js"),
          "@modelcontextprotocol/server-filesystem",
          "https://api.example.com",
          "--port",
          "7337",
        ]);
      }

      const pathServer = snapshot.servers.find((entry) => entry.name === "pathServer");
      expect(pathServer?.transport.type).toBe("stdio");
      if (pathServer?.transport.type === "stdio") {
        expect(pathServer.transport.command).toBe("node");
        expect(pathServer.transport.cwd).toBeUndefined();
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("plugin MCP stdio transports reject relative paths that escape the plugin root", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-registry-plugin-escape-workspace-"),
    );
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-plugin-escape-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-registry-plugin-escape-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const pluginRoot = path.join(workspace, ".agents", "plugins", "escape-toolkit");
      await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify(
          {
            name: "escape-toolkit",
            description: "Plugin escape helpers",
            interface: { displayName: "Escape Toolkit" },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      await fs.writeFile(
        path.join(pluginRoot, ".mcp.json"),
        `${JSON.stringify(
          {
            mcpServers: {
              escapedServer: {
                type: "stdio",
                command: "node",
                args: ["../outside/server.mjs"],
                cwd: "../outside",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const snapshot = await loadMCPConfigRegistry(config);

      expect(snapshot.servers.find((entry) => entry.name === "escapedServer")).toBeUndefined();
      expect(snapshot.warnings).toEqual([
        expect.stringContaining("Ignoring malformed plugin MCP config"),
      ]);
      expect(snapshot.warnings[0]).toContain(
        'resolves argument "../outside/server.mjs" outside the plugin root',
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("plugin MCP stdio transports reject absolute cwd paths outside the plugin root", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-registry-plugin-absolute-cwd-workspace-"),
    );
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-plugin-absolute-cwd-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-registry-plugin-absolute-cwd-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const pluginRoot = path.join(workspace, ".agents", "plugins", "absolute-cwd-toolkit");
      await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify(
          {
            name: "absolute-cwd-toolkit",
            description: "Plugin absolute cwd helpers",
            interface: { displayName: "Absolute Cwd Toolkit" },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      await fs.writeFile(
        path.join(pluginRoot, ".mcp.json"),
        `${JSON.stringify(
          {
            mcpServers: {
              escapedServer: {
                type: "stdio",
                command: "node",
                cwd: os.tmpdir(),
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const snapshot = await loadMCPConfigRegistry(config);

      expect(snapshot.servers.find((entry) => entry.name === "escapedServer")).toBeUndefined();
      expect(snapshot.warnings).toEqual([
        expect.stringContaining("Ignoring malformed plugin MCP config"),
      ]);
      expect(snapshot.warnings[0]).toContain("resolves cwd outside the plugin root");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("plugin MCP stdio transports reject symlinked paths that escape the plugin root", async () => {
    if (process.platform === "win32") {
      // Symlinks require elevated privileges on Windows
      return;
    }
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-registry-plugin-symlink-workspace-"),
    );
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-plugin-symlink-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-registry-plugin-symlink-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      const pluginRoot = path.join(workspace, ".agents", "plugins", "symlink-toolkit");
      const outsideRoot = path.join(workspace, "outside");
      await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
      await fs.mkdir(path.join(pluginRoot, "bin"), { recursive: true });
      await fs.mkdir(outsideRoot, { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify(
          {
            name: "symlink-toolkit",
            description: "Plugin symlink helpers",
            interface: { displayName: "Symlink Toolkit" },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      const outsideCommand = path.join(outsideRoot, "server.js");
      await fs.writeFile(outsideCommand, "// outside\n", "utf-8");
      await fs.symlink(
        outsideCommand,
        path.join(pluginRoot, "bin", "server.js"),
        process.platform === "win32" ? "file" : undefined,
      );
      await fs.writeFile(
        path.join(pluginRoot, ".mcp.json"),
        `${JSON.stringify(
          {
            mcpServers: {
              escapedServer: {
                type: "stdio",
                command: "./bin/server.js",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const snapshot = await loadMCPConfigRegistry(config);

      expect(snapshot.servers.find((entry) => entry.name === "escapedServer")).toBeUndefined();
      expect(snapshot.warnings).toEqual([
        expect.stringContaining("Ignoring malformed plugin MCP config"),
      ]);
      expect(snapshot.warnings[0]).toContain("resolves command outside the plugin root");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("upsertWorkspaceMCPServer moves workspace credential keys when renaming", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-rename-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-rename-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-registry-rename-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      await writeJson(path.join(workspace, ".cowork", "auth", "mcp-credentials.json"), {
        version: 1,
        updatedAt: new Date().toISOString(),
        servers: {
          old: {
            apiKey: {
              value: "secret-key",
              updatedAt: new Date().toISOString(),
            },
          },
        },
      });

      await upsertWorkspaceMCPServer(config, {
        name: "old",
        transport: { type: "stdio", command: "echo", args: ["before"] },
      });
      await upsertWorkspaceMCPServer(
        config,
        {
          name: "new",
          transport: { type: "stdio", command: "echo", args: ["after"] },
        },
        "old",
      );

      const authRaw = await fs.readFile(
        path.join(workspace, ".cowork", "auth", "mcp-credentials.json"),
        "utf-8",
      );
      const authDoc = JSON.parse(authRaw) as {
        servers: Record<string, { apiKey?: { value?: string } }>;
      };
      expect(authDoc.servers.old).toBeUndefined();
      expect(authDoc.servers.new?.apiKey?.value).toBe("secret-key");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("upsertMCPServer can manage global user MCP configs without touching workspace config", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-user-upsert-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-user-upsert-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-registry-user-upsert-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      await writeJson(path.join(workspace, ".cowork", "mcp-servers.json"), {
        servers: [{ name: "workspace-only", transport: { type: "stdio", command: "workspace" } }],
      });

      await upsertMCPServer(config, "user", {
        name: "global-mail",
        transport: { type: "http", url: "https://mail.example.com/mcp" },
        auth: { type: "oauth", oauthMode: "auto" },
      });

      let snapshot = await loadMCPConfigRegistry(config);
      expect(snapshot.servers.find((entry) => entry.name === "global-mail")).toMatchObject({
        source: "user",
        inherited: true,
      });
      expect(snapshot.servers.find((entry) => entry.name === "workspace-only")?.source).toBe(
        "workspace",
      );

      const workspaceRaw = await fs.readFile(
        path.join(workspace, ".cowork", "mcp-servers.json"),
        "utf-8",
      );
      expect(workspaceRaw).toContain("workspace-only");
      expect(workspaceRaw).not.toContain("global-mail");

      await deleteMCPServer(config, "user", "global-mail");
      snapshot = await loadMCPConfigRegistry(config);
      expect(snapshot.servers.find((entry) => entry.name === "global-mail")).toBeUndefined();
      expect(snapshot.servers.find((entry) => entry.name === "workspace-only")?.source).toBe(
        "workspace",
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("upsertWorkspaceMCPServer rejects rename when target name already exists", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-rename-collision-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-rename-collision-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-registry-rename-collision-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      await upsertWorkspaceMCPServer(config, {
        name: "server-a",
        transport: { type: "stdio", command: "echo", args: ["a"] },
      });
      await upsertWorkspaceMCPServer(config, {
        name: "server-b",
        transport: { type: "stdio", command: "echo", args: ["b"] },
      });

      await expect(
        upsertWorkspaceMCPServer(
          config,
          { name: "server-b", transport: { type: "stdio", command: "echo", args: ["renamed"] } },
          "server-a",
        ),
      ).rejects.toThrow(/cannot rename.*already exists/);

      // Verify neither entry was corrupted
      const raw = await fs.readFile(path.join(workspace, ".cowork", "mcp-servers.json"), "utf-8");
      const doc = JSON.parse(raw) as {
        servers: Array<{ name: string; transport: { command: string; args?: string[] } }>;
      };
      const names = doc.servers.map((s) => s.name);
      expect(names).toContain("server-a");
      expect(names).toContain("server-b");
      expect(names.filter((n) => n === "server-b")).toHaveLength(1);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("new-format config overrides legacy for same server name", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-override-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-override-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-registry-override-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      await writeJson(path.join(workspace, ".cowork", "mcp-servers.json"), {
        servers: [{ name: "my-server", transport: { type: "stdio", command: "legacy-cmd" } }],
      });
      await writeJson(path.join(workspace, ".cowork", "mcp-servers.json"), {
        servers: [{ name: "my-server", transport: { type: "stdio", command: "new-cmd" } }],
      });

      const snapshot = await loadMCPConfigRegistry(config);
      const server = snapshot.servers.find((s) => s.name === "my-server");
      expect(server?.source).toBe("workspace");
      expect((server?.transport as { command?: string } | undefined)?.command).toBe("new-cmd");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("user legacy .agent MCP files are not loaded", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-user-legacy-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-user-legacy-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-registry-user-legacy-builtin-"),
    );
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      await writeJson(path.join(home, ".agent", "mcp-servers.json"), {
        servers: [
          { name: "user-legacy-server", transport: { type: "stdio", command: "user-legacy-cmd" } },
        ],
      });

      const snapshot = await loadMCPConfigRegistry(config);
      const server = snapshot.servers.find((s) => s.name === "user-legacy-server");
      expect(server).toBeUndefined();
      expect(snapshot.files.some((file) => file.legacy)).toBe(false);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });
});
