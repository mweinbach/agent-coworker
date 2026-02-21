import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentConfig } from "../src/types";
import { loadMCPConfigRegistry, migrateLegacyMCPServers, upsertWorkspaceMCPServer } from "../src/mcp/configRegistry";

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

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

describe("mcp config registry", () => {
  test("workspace/user/system precedence with legacy fallback", async () => {
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
      const shared = snapshot.servers.find((server) => server.name === "shared");
      expect(shared?.source).toBe("workspace");
      expect(snapshot.servers.some((server) => server.name === "legacy-ws")).toBe(true);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInDir, { recursive: true, force: true });
    }
  });

  test("invalid json does not throw and surfaces warnings", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-invalid-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-invalid-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-invalid-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      await fs.mkdir(path.join(workspace, ".cowork"), { recursive: true });
      await fs.writeFile(path.join(workspace, ".cowork", "mcp-servers.json"), "{ bad json", "utf-8");
      const snapshot = await loadMCPConfigRegistry(config);
      expect(snapshot.warnings.length).toBeGreaterThan(0);
      expect(snapshot.files.find((file) => file.source === "workspace")?.parseError).toBeDefined();
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("upsertWorkspaceMCPServer moves workspace credential keys when renaming", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-rename-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-rename-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-rename-builtin-"));
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

      const authRaw = await fs.readFile(path.join(workspace, ".cowork", "auth", "mcp-credentials.json"), "utf-8");
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

  test("upsertWorkspaceMCPServer rejects rename when target name already exists", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-rename-collision-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-rename-collision-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-rename-collision-builtin-"));
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
      const doc = JSON.parse(raw) as { servers: Array<{ name: string; transport: { command: string; args?: string[] } }> };
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

  test("migrateLegacyMCPServers preserves existing .cowork entries and archives legacy file", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-migrate-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-migrate-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-migrate-builtin-"));
    const config = makeConfig(workspace, home, builtInConfigDir);

    try {
      await upsertWorkspaceMCPServer(config, {
        name: "existing",
        transport: { type: "stdio", command: "echo", args: ["existing"] },
      });
      await writeJson(path.join(workspace, ".agent", "mcp-servers.json"), {
        servers: [
          { name: "existing", transport: { type: "stdio", command: "legacy-existing" } },
          { name: "imported", transport: { type: "stdio", command: "legacy-imported" } },
        ],
      });

      const result = await migrateLegacyMCPServers(config, "workspace");
      expect(result.imported).toBe(1);
      expect(result.skippedConflicts).toBe(1);
      expect(result.archivedPath).toBeTruthy();

      const raw = await fs.readFile(path.join(workspace, ".cowork", "mcp-servers.json"), "utf-8");
      expect(raw).toContain("existing");
      expect(raw).toContain("imported");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });
});
