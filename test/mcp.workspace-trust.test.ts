import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadMCPServers } from "../src/mcp";
import type { AgentConfig } from "../src/types";

function makeConfig(opts: {
  workspaceRoot: string;
  userHome: string;
  builtInConfigDir: string;
  trustWorkspaceMcp?: boolean;
}): AgentConfig {
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
    workingDirectory: opts.workspaceRoot,
    outputDirectory: path.join(opts.workspaceRoot, "output"),
    uploadsDirectory: path.join(opts.workspaceRoot, "uploads"),
    userName: "tester",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(opts.workspaceRoot, ".cowork"),
    userCoworkDir: path.join(opts.userHome, ".cowork"),
    workspaceAgentsDir: path.join(opts.workspaceRoot, ".agents"),
    userAgentsDir: path.join(opts.userHome, ".agents"),
    workspacePluginsDir: path.join(opts.workspaceRoot, ".agents", "plugins"),
    userPluginsDir: path.join(opts.userHome, ".agents", "plugins"),
    builtInDir: path.dirname(opts.builtInConfigDir),
    builtInConfigDir: opts.builtInConfigDir,
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    enableMcp: true,
    trustWorkspaceMcp: opts.trustWorkspaceMcp,
  };
}

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

async function withDirs(
  run: (dirs: { workspace: string; home: string; builtInConfigDir: string }) => Promise<void>,
) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-trust-ws-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-trust-home-"));
  const builtInDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-trust-builtin-"));
  const builtInConfigDir = path.join(builtInDir, "config");
  await fs.mkdir(builtInConfigDir, { recursive: true });
  try {
    await run({ workspace, home, builtInConfigDir });
  } finally {
    await Promise.all([
      fs.rm(workspace, { recursive: true, force: true }),
      fs.rm(home, { recursive: true, force: true }),
      fs.rm(builtInDir, { recursive: true, force: true }),
    ]);
  }
}

async function seedServers(dirs: { workspace: string; home: string }) {
  await writeJson(path.join(dirs.workspace, ".cowork", "mcp-servers.json"), {
    servers: [
      { name: "ws-stdio", transport: { type: "stdio", command: "/bin/sh", args: ["-c", ":"] } },
      { name: "ws-http", transport: { type: "http", url: "https://example.test/mcp" } },
    ],
  });
  await writeJson(path.join(dirs.home, ".cowork", "config", "mcp-servers.json"), {
    servers: [{ name: "user-stdio", transport: { type: "stdio", command: "/bin/echo" } }],
  });
}

async function seedWorkspacePluginStdioServer(dirs: { workspace: string }) {
  const pluginRoot = path.join(dirs.workspace, ".agents", "plugins", "stdio-plugin");
  await writeJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"), {
    name: "stdio-plugin",
    description: "Workspace plugin with stdio MCP",
    interface: { displayName: "Stdio Plugin" },
  });
  await writeJson(path.join(pluginRoot, ".mcp.json"), {
    mcpServers: {
      pluginStdio: {
        type: "stdio",
        command: "/bin/echo",
        args: ["plugin"],
      },
    },
  });
}

describe("workspace MCP trust gate", () => {
  test("untrusted workspace does not auto-start its own servers (stdio or http)", async () => {
    await withDirs(async (dirs) => {
      await seedServers(dirs);
      await seedWorkspacePluginStdioServer(dirs);
      const config = makeConfig({
        workspaceRoot: dirs.workspace,
        userHome: dirs.home,
        builtInConfigDir: dirs.builtInConfigDir,
      });

      const logs: string[] = [];
      const servers = await loadMCPServers(config, { log: (line) => logs.push(line) });
      const names = servers.map((server) => server.name);

      // All workspace-owned servers are blocked — stdio (local command) AND
      // http/sse (drive-by outbound connection that exfiltrates tool inputs).
      expect(names).not.toContain("ws-stdio");
      expect(names).not.toContain("ws-http");
      expect(names).not.toContain("pluginStdio");
      // Trusted user-layer stdio servers still load.
      expect(names).toContain("user-stdio");
      expect(
        logs.some((line) => line.includes('Not auto-starting workspace stdio server "ws-stdio"')),
      ).toBe(true);
      expect(
        logs.some((line) => line.includes('Not auto-starting workspace http server "ws-http"')),
      ).toBe(true);
      expect(
        logs.some((line) =>
          line.includes('Not auto-starting workspace stdio server "pluginStdio"'),
        ),
      ).toBe(true);
    });
  });

  test("trusted workspace (user/env opt-in) auto-starts its servers", async () => {
    await withDirs(async (dirs) => {
      await seedServers(dirs);
      await seedWorkspacePluginStdioServer(dirs);
      const config = makeConfig({
        workspaceRoot: dirs.workspace,
        userHome: dirs.home,
        builtInConfigDir: dirs.builtInConfigDir,
        trustWorkspaceMcp: true,
      });

      const servers = await loadMCPServers(config);
      const names = servers.map((server) => server.name);
      expect(names).toContain("ws-stdio");
      expect(names).toContain("ws-http");
      expect(names).toContain("pluginStdio");
    });
  });

  test("explicit validation may include otherwise-untrusted workspace servers", async () => {
    await withDirs(async (dirs) => {
      await seedServers(dirs);
      await seedWorkspacePluginStdioServer(dirs);
      const config = makeConfig({
        workspaceRoot: dirs.workspace,
        userHome: dirs.home,
        builtInConfigDir: dirs.builtInConfigDir,
      });

      const auto = await loadMCPServers(config);
      expect(auto.map((server) => server.name)).not.toContain("ws-stdio");
      expect(auto.map((server) => server.name)).not.toContain("ws-http");
      expect(auto.map((server) => server.name)).not.toContain("pluginStdio");

      const validation = await loadMCPServers(config, { includeUntrustedWorkspace: true });
      const names = validation.map((server) => server.name);
      expect(names).toContain("ws-stdio");
      expect(names).toContain("ws-http");
      expect(names).toContain("pluginStdio");
    });
  });
});
