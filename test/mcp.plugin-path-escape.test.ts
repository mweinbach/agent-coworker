import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { loadMCPConfigRegistry } from "../src/mcp/configRegistry";
import { scratchRoots } from "../src/platform/sandbox/policy";
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

async function withPluginRoot(
  name: string,
  fn: (opts: { root: string; pluginRoot: string; config: AgentConfig }) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(scratchRoots()[0] ?? "/tmp", "mcp-plugin-mid-dotdot-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  const builtInConfigDir = path.join(root, "built-in");
  const pluginRoot = path.join(workspace, ".agents", "plugins", name);
  await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
  await fs.mkdir(path.join(home, ".cowork"), { recursive: true });
  await fs.mkdir(builtInConfigDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, ".codex-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name,
        description: "Plugin path boundary",
        interface: { displayName: "Path Boundary" },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  try {
    await fn({
      root,
      pluginRoot,
      config: makeConfig(workspace, home, builtInConfigDir),
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("plugin MCP mid-path escapes", () => {
  test("rejects a command path whose .. segment is not a leading prefix and drops the plugin", async () => {
    await withPluginRoot("mid-escape", async ({ pluginRoot, config }) => {
      await fs.writeFile(
        path.join(pluginRoot, ".mcp.json"),
        `${JSON.stringify(
          {
            mcpServers: {
              aaaKept: {
                type: "stdio",
                command: "node",
              },
              escapedCommand: {
                type: "stdio",
                command: "bin/../../outside/server",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const snapshot = await loadMCPConfigRegistry(config);

      expect(snapshot.servers.find((entry) => entry.name === "escapedCommand")).toBeUndefined();
      expect(snapshot.servers.find((entry) => entry.name === "aaaKept")).toBeUndefined();
      expect(snapshot.warnings).toEqual([
        expect.stringContaining("Ignoring malformed plugin MCP config"),
      ]);
      expect(snapshot.warnings[0]).toContain(
        'Plugin MCP server "escapedCommand" resolves command outside the plugin root',
      );
    });
  });

  test("rejects a hidden .. argument even when the command itself is not a path", async () => {
    await withPluginRoot("arg-escape", async ({ pluginRoot, config }) => {
      await fs.writeFile(
        path.join(pluginRoot, ".mcp.json"),
        `${JSON.stringify(
          {
            mcpServers: {
              escapedArgument: {
                type: "stdio",
                command: "node",
                args: ["--flag", "nested/../../outside/server.mjs"],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const snapshot = await loadMCPConfigRegistry(config);

      expect(snapshot.servers).toEqual([]);
      expect(snapshot.warnings[0]).toContain(
        'resolves argument "nested/../../outside/server.mjs" outside the plugin root',
      );
    });
  });

  test("resolves a .. segment that stays inside the plugin root", async () => {
    await withPluginRoot("contained", async ({ pluginRoot, config }) => {
      await fs.mkdir(path.join(pluginRoot, "bin"), { recursive: true });
      await fs.writeFile(path.join(pluginRoot, "bin", "server.js"), "// server\n", "utf-8");
      await fs.writeFile(
        path.join(pluginRoot, ".mcp.json"),
        `${JSON.stringify(
          {
            mcpServers: {
              containedServer: {
                type: "stdio",
                command: "bin/../bin/server.js",
                args: ["--port", "7337"],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const snapshot = await loadMCPConfigRegistry(config);
      const server = snapshot.servers.find((entry) => entry.name === "containedServer");

      expect(snapshot.warnings).toEqual([]);
      expect(server?.transport.type).toBe("stdio");
      if (server?.transport.type !== "stdio") return;
      expect(server.transport.command).toBe(path.join(pluginRoot, "bin", "server.js"));
      expect(server.transport.args).toEqual(["--port", "7337"]);
    });
  });
});
