import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  DEFAULT_MCP_SERVERS_DOCUMENT,
  loadMCPServers,
  loadMCPTools,
  __internal as mcpInternal,
  parseMCPServersDocument,
  readMCPServersSnapshot,
  readProjectMCPServersDocument,
  readWorkspaceMCPServersDocument,
  writeProjectMCPServersDocument,
  writeWorkspaceMCPServersDocument,
} from "../src/mcp";
import { setMCPServerEnabled } from "../src/mcp/configRegistry";
import { scratchRoots } from "../src/platform/sandbox";
import type { AgentConfig, MCPServerConfig } from "../src/types";
import { makeTmpProject } from "./helpers/wsHarness";

function makeConfig(
  workspaceRoot: string,
  userHome: string,
  builtInConfigDir: string,
  opts: { trustWorkspaceMcp?: boolean } = {},
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
    // Several auth-injection tests below seed workspace-scoped servers and need
    // them to actually load; the workspace-trust gate is covered separately in
    // test/mcp.workspace-trust.test.ts.
    ...(opts.trustWorkspaceMcp !== undefined ? { trustWorkspaceMcp: opts.trustWorkspaceMcp } : {}),
  };
}

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

const mockCreateMCPClient = mock(async (_opts: any) => ({
  tools: mock(async () => ({ ping: { description: "ping" } })),
  close: mock(async () => {}),
}));

describe("mcp parsing", () => {
  test("parseMCPServersDocument supports auth metadata and enabled state", () => {
    const parsed = parseMCPServersDocument(
      JSON.stringify({
        servers: [
          {
            name: "secure-http",
            transport: { type: "http", url: "https://mcp.example.com" },
            enabled: false,
            auth: { type: "api_key", headerName: "x-api-key", keyId: "primary" },
          },
          {
            name: "oauth-http",
            transport: { type: "sse", url: "https://mcp.oauth.example.com" },
            auth: { type: "oauth", oauthMode: "auto", scope: "tools.read" },
          },
        ],
      }),
    );

    expect(parsed.servers).toHaveLength(2);
    expect(parsed.servers[0]?.enabled).toBe(false);
    expect(parsed.servers[0]?.auth?.type).toBe("api_key");
    expect(parsed.servers[1]?.enabled).toBeUndefined();
    expect(parsed.servers[1]?.auth?.type).toBe("oauth");
  });

  test("parseMCPServersDocument rejects invalid auth schema", () => {
    expect(() =>
      parseMCPServersDocument(
        JSON.stringify({
          servers: [
            {
              name: "bad",
              transport: { type: "http", url: "https://x" },
              auth: { type: "oauth", oauthMode: "bad" },
            },
          ],
        }),
      ),
    ).toThrow("oauthMode");
  });
});

describe("workspace mcp document", () => {
  test("readWorkspaceMCPServersDocument returns default payload when missing", async () => {
    const tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-doc-workspace-"));
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-doc-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-doc-builtin-"));
    try {
      const config = makeConfig(tmpWorkspace, tmpHome, builtInConfigDir);
      const payload = await readWorkspaceMCPServersDocument(config);
      expect(payload.path).toBe(path.join(tmpWorkspace, ".cowork", "mcp-servers.json"));
      expect(payload.rawJson).toBe(DEFAULT_MCP_SERVERS_DOCUMENT);
      expect(payload.workspaceServers).toEqual([]);
    } finally {
      await fs.rm(tmpWorkspace, { recursive: true, force: true });
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("writeWorkspaceMCPServersDocument validates and writes newline-terminated json", async () => {
    const tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-doc-write-workspace-"));
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-doc-write-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-doc-write-builtin-"));
    try {
      const config = makeConfig(tmpWorkspace, tmpHome, builtInConfigDir);
      const raw = JSON.stringify(
        { servers: [{ name: "local", transport: { type: "stdio", command: "echo" } }] },
        null,
        2,
      );
      await writeWorkspaceMCPServersDocument(config, raw);
      const persisted = await fs.readFile(
        path.join(tmpWorkspace, ".cowork", "mcp-servers.json"),
        "utf-8",
      );
      expect(persisted).toBe(`${raw}\n`);
    } finally {
      await fs.rm(tmpWorkspace, { recursive: true, force: true });
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("writeProjectMCPServersDocument writes to the .cowork path used by readProjectMCPServersDocument", async () => {
    const tmpWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-doc-project-write-workspace-"),
    );
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-doc-project-write-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-doc-project-write-builtin-"),
    );
    try {
      const config = makeConfig(tmpWorkspace, tmpHome, builtInConfigDir);
      const raw = JSON.stringify(
        { servers: [{ name: "project", transport: { type: "stdio", command: "echo" } }] },
        null,
        2,
      );
      await writeProjectMCPServersDocument(config.projectCoworkDir, raw);

      const workspaceFile = path.join(tmpWorkspace, ".cowork", "mcp-servers.json");
      const legacyFile = path.join(tmpWorkspace, ".agent", "mcp-servers.json");
      const persisted = await fs.readFile(workspaceFile, "utf-8");
      expect(persisted).toBe(`${raw}\n`);
      await expect(fs.access(legacyFile)).rejects.toBeDefined();

      const projectDoc = await readProjectMCPServersDocument(config);
      expect(projectDoc.path).toBe(workspaceFile);
      expect(projectDoc.rawJson).toBe(`${raw}\n`);
      expect(projectDoc.projectServers.map((server) => server.name)).toEqual(["project"]);
    } finally {
      await fs.rm(tmpWorkspace, { recursive: true, force: true });
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });
});

describe("mcp layered snapshot", () => {
  test("readMCPServersSnapshot merges canonical workspace, user, and system layers", async () => {
    const tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-snapshot-workspace-"));
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-snapshot-home-"));
    const builtInDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-snapshot-builtin-"));
    const builtInConfigDir = path.join(builtInDir, "config");

    try {
      const config = makeConfig(tmpWorkspace, tmpHome, builtInConfigDir);

      await writeJson(path.join(builtInConfigDir, "mcp-servers.json"), {
        servers: [
          { name: "shared", transport: { type: "stdio", command: "system" } },
          { name: "sys", transport: { type: "stdio", command: "sys" } },
        ],
      });
      await writeJson(path.join(tmpHome, ".cowork", "config", "mcp-servers.json"), {
        servers: [
          { name: "shared", transport: { type: "stdio", command: "user" } },
          { name: "user", transport: { type: "stdio", command: "user-only" } },
        ],
      });
      await writeJson(path.join(tmpWorkspace, ".agent", "mcp-servers.json"), {
        servers: [{ name: "legacy-ws", transport: { type: "stdio", command: "legacy" } }],
      });
      await writeJson(path.join(tmpWorkspace, ".cowork", "mcp-servers.json"), {
        servers: [
          { name: "shared", transport: { type: "stdio", command: "workspace" } },
          {
            name: "workspace",
            transport: { type: "stdio", command: "workspace-only" },
            enabled: false,
          },
        ],
      });

      const snapshot = await readMCPServersSnapshot(config);
      const names = snapshot.servers.map((server) => server.name);
      expect(names).toContain("shared");
      expect(names).toContain("workspace");
      expect(names).not.toContain("legacy-ws");

      const shared = snapshot.servers.find((server) => server.name === "shared");
      expect(shared?.source).toBe("workspace");
      expect(shared?.enabled).toBe(true);
      expect(snapshot.servers.find((server) => server.name === "workspace")?.enabled).toBe(false);

      expect(snapshot.files.some((file) => file.legacy)).toBe(false);
    } finally {
      await fs.rm(tmpWorkspace, { recursive: true, force: true });
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(builtInDir, { recursive: true, force: true });
    }
  });

  test("setMCPServerEnabled updates source-owned workspace and user MCP configs", async () => {
    const tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-toggle-workspace-"));
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-toggle-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-toggle-builtin-"));
    try {
      const config = makeConfig(tmpWorkspace, tmpHome, builtInConfigDir);
      await writeJson(path.join(tmpWorkspace, ".cowork", "mcp-servers.json"), {
        servers: [{ name: "local", transport: { type: "stdio", command: "local" } }],
      });
      await writeJson(path.join(tmpHome, ".cowork", "config", "mcp-servers.json"), {
        servers: [{ name: "global", transport: { type: "stdio", command: "global" } }],
      });

      await setMCPServerEnabled({
        config,
        source: "workspace",
        name: "local",
        enabled: false,
      });
      await setMCPServerEnabled({
        config,
        source: "user",
        name: "global",
        enabled: false,
      });

      const snapshot = await readMCPServersSnapshot(config);
      expect(snapshot.servers.find((server) => server.name === "local")?.enabled).toBe(false);
      expect(snapshot.servers.find((server) => server.name === "global")?.enabled).toBe(false);

      const runtimeServers = await loadMCPServers(config);
      expect(runtimeServers.map((server) => server.name)).not.toContain("local");
      expect(runtimeServers.map((server) => server.name)).not.toContain("global");
    } finally {
      await fs.rm(tmpWorkspace, { recursive: true, force: true });
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("setMCPServerEnabled rejects read-only system MCP configs", async () => {
    const tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-toggle-system-workspace-"));
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-toggle-system-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-toggle-system-builtin-"));
    try {
      const config = makeConfig(tmpWorkspace, tmpHome, builtInConfigDir);
      await expect(
        setMCPServerEnabled({
          config,
          source: "system",
          name: "builtin",
          enabled: false,
        }),
      ).rejects.toThrow("read-only");
    } finally {
      await fs.rm(tmpWorkspace, { recursive: true, force: true });
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });
});

describe("codex apps MCP bridge", () => {
  test("loadMCPServers does not inject a direct codex_apps server from connector settings", async () => {
    const tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-codex-apps-workspace-"));
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-codex-apps-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-codex-apps-builtin-"));
    try {
      const config = makeConfig(tmpWorkspace, tmpHome, builtInConfigDir);
      config.provider = "codex-cli";
      config.userCoworkDir = path.join(tmpHome, ".cowork");
      config.skillsDirs = [path.join(tmpHome, ".cowork", "skills")];
      config.experimentalFeatures = { openAiNativeConnectors: true };

      const servers = await loadMCPServers(config);
      const codexApps = servers.find((server) => server.name === "codex_apps");

      expect(codexApps).toBeUndefined();
    } finally {
      await fs.rm(tmpWorkspace, { recursive: true, force: true });
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("loadMCPServers retains explicitly configured codex_apps MCP servers", async () => {
    const tmpWorkspace = await fs.mkdtemp(
      path.join(scratchRoots()[0] ?? "/tmp", "mcp-codex-apps-explicit-"),
    );
    const tmpHome = await fs.mkdtemp(
      path.join(scratchRoots()[0] ?? "/tmp", "mcp-codex-apps-explicit-home-"),
    );
    const builtInConfigDir = await fs.mkdtemp(
      path.join(scratchRoots()[0] ?? "/tmp", "mcp-codex-apps-explicit-builtin-"),
    );
    try {
      const config = makeConfig(tmpWorkspace, tmpHome, builtInConfigDir, {
        trustWorkspaceMcp: true,
      });
      await writeJson(path.join(tmpWorkspace, ".cowork", "mcp-servers.json"), {
        servers: [
          {
            name: "codex_apps",
            transport: { type: "http", url: "https://apps.example.invalid/mcp" },
          },
        ],
      });

      const servers = await loadMCPServers(config);

      expect(servers).toEqual([
        expect.objectContaining({
          name: "codex_apps",
          transport: { type: "http", url: "https://apps.example.invalid/mcp" },
        }),
      ]);
    } finally {
      await fs.rm(tmpWorkspace, { recursive: true, force: true });
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("loadMCPTools keeps codex_apps connector metadata without connector filtering", async () => {
    const { tools } = await loadMCPTools(
      [
        {
          name: "codex_apps",
          transport: { type: "http", url: "https://apps.example.invalid/mcp" },
          ...({ enabledConnectorIds: ["connector_gmail"] } as Record<string, unknown>),
        } as MCPServerConfig,
      ],
      {
        createClient: async () => ({
          close: async () => {},
          tools: async () => ({
            search_email: {
              description: "Search Gmail",
              connectorId: "connector_gmail",
              _meta: { connector_id: "connector_gmail", _codex_apps: { resource_uri: "app://g" } },
            },
            search_files: {
              description: "Search files",
              connectorId: "connector_dropbox",
              _meta: { connector_id: "connector_dropbox" },
            },
          }),
        }),
      },
    );

    expect(Object.keys(tools)).toEqual([
      "mcp__codex_apps__search_email",
      "mcp__codex_apps__search_files",
    ]);
    expect((tools.mcp__codex_apps__search_email as any)._meta).toEqual({
      connector_id: "connector_gmail",
      _codex_apps: { resource_uri: "app://g" },
    });
    expect((tools.mcp__codex_apps__search_files as any)._meta).toEqual({
      connector_id: "connector_dropbox",
    });
  });
});

describe("runtime auth injection", () => {
  test.each(["hydrate", "snapshot"] as const)(
    "%s reads each credential file once per call and sees updated credentials on the next call",
    async (operation) => {
      const root = await makeTmpProject("mcp-auth-bulk-");
      const config = makeConfig(root, path.join(root, "home"), path.join(root, "built-in"), {
        trustWorkspaceMcp: true,
      });
      const workspaceAuthFile = path.join(config.projectCoworkDir, "auth", "mcp-credentials.json");
      const userAuthFile = path.join(config.userCoworkDir, "auth", "mcp-credentials.json");
      const fileSpy = spyOn(Bun, "file");
      try {
        const serverConfig = (name: string) => ({
          name,
          transport: { type: "http", url: "https://mcp.example.com", headers: { "x-base": "1" } },
          auth: { type: "api_key" },
        });
        await writeJson(path.join(config.projectCoworkDir, "mcp-servers.json"), {
          servers: [serverConfig("workspace-api"), serverConfig("shadowed")],
        });
        await writeJson(path.join(config.userCoworkDir, "config", "mcp-servers.json"), {
          servers: [serverConfig("user-api")],
        });
        const readsPerCall: unknown[][] = [];
        for (const suffix of ["1111", "2222"]) {
          const updatedAt = new Date().toISOString();
          const credential = (value: string) => ({ apiKey: { value, updatedAt } });
          await writeJson(workspaceAuthFile, {
            version: 1,
            updatedAt,
            servers: { "workspace-api": credential(`workspace-key-${suffix}`) },
          });
          await writeJson(userAuthFile, {
            version: 1,
            updatedAt,
            servers: {
              "user-api": credential(`user-key-${suffix}`),
              shadowed: credential("must-not-leak"),
            },
          });
          fileSpy.mockClear();
          if (operation === "hydrate") {
            const servers = await loadMCPServers(config);
            expect(servers).toHaveLength(3);
            for (const server of servers) {
              expect(server.transport.type).toBe("http");
              if (server.transport.type !== "http") throw new Error("Expected HTTP transport");
              expect(server.transport.headers?.["x-base"]).toBe("1");
              const expectedKey =
                server.name === "shadowed"
                  ? undefined
                  : `Bearer ${server.name === "workspace-api" ? "workspace" : "user"}-key-${suffix}`;
              expect(server.transport.headers?.Authorization).toBe(expectedKey);
            }
          } else {
            const snapshot = await readMCPServersSnapshot(config);
            expect(snapshot.servers).toHaveLength(3);
            for (const server of snapshot.servers) {
              expect(server.authScope).toBe(server.name === "user-api" ? "user" : "workspace");
              expect(server.authMode).toBe(server.name === "shadowed" ? "missing" : "api_key");
              if (server.name !== "shadowed") expect(server.authMessage).toContain(suffix);
            }
          }
          readsPerCall.push(
            fileSpy.mock.calls
              .map(([filePath]) => filePath)
              .filter((filePath) => filePath === workspaceAuthFile || filePath === userAuthFile),
          );
        }
        expect(readsPerCall).toEqual([
          [workspaceAuthFile, userAuthFile],
          [workspaceAuthFile, userAuthFile],
        ]);
      } finally {
        fileSpy.mockRestore();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  test.each(["empty", "disabled", "untrusted"] as const)(
    "%s runtime server lists do not read credentials",
    async (scenario) => {
      const root = await makeTmpProject("mcp-auth-empty-");
      const config = makeConfig(root, path.join(root, "home"), path.join(root, "built-in"));
      const fileSpy = spyOn(Bun, "file");
      try {
        if (scenario !== "empty") {
          await writeJson(path.join(config.projectCoworkDir, "mcp-servers.json"), {
            servers: [
              {
                name: "blocked",
                transport: { type: "http", url: "https://mcp.example.com" },
                enabled: scenario !== "disabled",
              },
            ],
          });
        }
        expect(await loadMCPServers(config)).toEqual([]);
        if (scenario === "empty") {
          expect((await readMCPServersSnapshot(config)).servers).toEqual([]);
        }
        expect(
          fileSpy.mock.calls.filter(([filePath]) =>
            String(filePath).endsWith("mcp-credentials.json"),
          ),
        ).toEqual([]);
      } finally {
        fileSpy.mockRestore();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  test("loadMCPServers injects API key headers from auth store", async () => {
    const tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-runtime-api-workspace-"));
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-runtime-api-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-runtime-api-builtin-"));

    try {
      const config = makeConfig(tmpWorkspace, tmpHome, builtInConfigDir, {
        trustWorkspaceMcp: true,
      });
      await writeJson(path.join(tmpWorkspace, ".cowork", "mcp-servers.json"), {
        servers: [
          {
            name: "api-server",
            transport: { type: "http", url: "https://mcp.example.com", headers: { "x-base": "1" } },
            auth: { type: "api_key", headerName: "Authorization", prefix: "Bearer" },
          },
        ],
      });
      await writeJson(path.join(tmpWorkspace, ".cowork", "auth", "mcp-credentials.json"), {
        version: 1,
        updatedAt: new Date().toISOString(),
        servers: {
          "api-server": {
            apiKey: {
              value: "secret",
              updatedAt: new Date().toISOString(),
            },
          },
        },
      });

      const servers = await loadMCPServers(config);
      const server = servers.find((entry) => entry.name === "api-server");
      expect(server).toBeDefined();
      expect(server?.transport.type).toBe("http");
      if (server?.transport.type === "http") {
        expect(server.transport.headers?.Authorization).toBe("Bearer secret");
        expect(server.transport.headers?.["x-base"]).toBe("1");
      }
    } finally {
      await fs.rm(tmpWorkspace, { recursive: true, force: true });
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("loadMCPServers does not reuse user credentials for workspace-shadowed server names", async () => {
    const tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-runtime-scope-workspace-"));
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-runtime-scope-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-runtime-scope-builtin-"));

    try {
      const config = makeConfig(tmpWorkspace, tmpHome, builtInConfigDir, {
        trustWorkspaceMcp: true,
      });

      await writeJson(path.join(tmpHome, ".cowork", "config", "mcp-servers.json"), {
        servers: [
          {
            name: "shadowed",
            transport: { type: "http", url: "https://trusted-user.example.com" },
            auth: { type: "api_key", headerName: "Authorization", prefix: "Bearer" },
          },
        ],
      });
      await writeJson(path.join(tmpWorkspace, ".cowork", "mcp-servers.json"), {
        servers: [
          {
            name: "shadowed",
            transport: {
              type: "http",
              url: "https://workspace.example.com",
              headers: { "x-base": "workspace" },
            },
            auth: { type: "api_key", headerName: "Authorization", prefix: "Bearer" },
          },
        ],
      });
      await writeJson(path.join(tmpHome, ".cowork", "auth", "mcp-credentials.json"), {
        version: 1,
        updatedAt: new Date().toISOString(),
        servers: {
          shadowed: {
            apiKey: {
              value: "user-secret",
              updatedAt: new Date().toISOString(),
            },
          },
        },
      });

      const servers = await loadMCPServers(config);
      const server = servers.find((entry) => entry.name === "shadowed");
      expect(server).toBeDefined();
      expect(server?.transport.type).toBe("http");
      if (server?.transport.type === "http") {
        expect(server.transport.url).toBe("https://workspace.example.com");
        expect(server.transport.headers?.Authorization).toBeUndefined();
        expect(server.transport.headers?.["x-base"]).toBe("workspace");
      }
    } finally {
      await fs.rm(tmpWorkspace, { recursive: true, force: true });
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("loadMCPServers injects oauth bearer headers when token exists", async () => {
    const tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-runtime-oauth-workspace-"));
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-runtime-oauth-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-runtime-oauth-builtin-"));

    try {
      const config = makeConfig(tmpWorkspace, tmpHome, builtInConfigDir, {
        trustWorkspaceMcp: true,
      });
      await writeJson(path.join(tmpWorkspace, ".cowork", "mcp-servers.json"), {
        servers: [
          {
            name: "oauth-server",
            transport: { type: "http", url: "https://mcp.oauth.example.com" },
            auth: { type: "oauth", oauthMode: "auto" },
          },
        ],
      });
      await writeJson(path.join(tmpWorkspace, ".cowork", "auth", "mcp-credentials.json"), {
        version: 1,
        updatedAt: new Date().toISOString(),
        servers: {
          "oauth-server": {
            oauth: {
              tokens: {
                accessToken: "oauth-token",
                tokenType: "Bearer",
                updatedAt: new Date().toISOString(),
              },
            },
          },
        },
      });

      const servers = await loadMCPServers(config);
      const server = servers.find((entry) => entry.name === "oauth-server");
      expect(server).toBeDefined();
      if (server?.transport.type === "http") {
        expect(server.transport.headers?.Authorization).toBe("Bearer oauth-token");
        expect((server.transport as any).authProvider).toBeDefined();
      }
    } finally {
      await fs.rm(tmpWorkspace, { recursive: true, force: true });
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("loadMCPServers keeps oauth provider when access token is expired but refreshable", async () => {
    const tmpWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-runtime-oauth-refresh-workspace-"),
    );
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-runtime-oauth-refresh-home-"));
    const builtInConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcp-runtime-oauth-refresh-builtin-"),
    );

    try {
      const config = makeConfig(tmpWorkspace, tmpHome, builtInConfigDir, {
        trustWorkspaceMcp: true,
      });
      await writeJson(path.join(tmpWorkspace, ".cowork", "mcp-servers.json"), {
        servers: [
          {
            name: "oauth-server",
            transport: { type: "http", url: "https://mcp.oauth.example.com" },
            auth: { type: "oauth", oauthMode: "auto" },
          },
        ],
      });
      await writeJson(path.join(tmpWorkspace, ".cowork", "auth", "mcp-credentials.json"), {
        version: 1,
        updatedAt: new Date().toISOString(),
        servers: {
          "oauth-server": {
            oauth: {
              tokens: {
                accessToken: "expired-oauth-token",
                tokenType: "Bearer",
                refreshToken: "refresh-token",
                expiresAt: new Date(Date.now() - 60_000).toISOString(),
                updatedAt: new Date().toISOString(),
              },
            },
          },
        },
      });

      const servers = await loadMCPServers(config);
      const server = servers.find((entry) => entry.name === "oauth-server");
      expect(server).toBeDefined();
      if (server?.transport.type === "http") {
        const provider = (server.transport as { authProvider?: OAuthClientProvider }).authProvider;
        expect(provider).toBeDefined();
        if (!provider) throw new Error("Expected OAuth provider");
        expect(await provider.tokens()).toMatchObject({
          access_token: "expired-oauth-token",
          refresh_token: "refresh-token",
        });
        await provider.saveTokens({
          access_token: "refreshed-oauth-token",
          token_type: "Bearer",
          refresh_token: "next-refresh-token",
          expires_in: 3600,
        });
        expect(await provider.tokens()).toMatchObject({ access_token: "refreshed-oauth-token" });
        const reloaded = (await loadMCPServers(config)).find(
          (entry) => entry.name === "oauth-server",
        );
        expect(reloaded?.transport.type).toBe("http");
        if (reloaded?.transport.type !== "http") throw new Error("Expected HTTP transport");
        expect(reloaded.transport.headers?.Authorization).toBe("Bearer refreshed-oauth-token");
        const reloadedProvider = (reloaded.transport as { authProvider?: OAuthClientProvider })
          .authProvider;
        expect(await reloadedProvider?.tokens()).toMatchObject({
          access_token: "refreshed-oauth-token",
          refresh_token: "next-refresh-token",
        });
      }
    } finally {
      await fs.rm(tmpWorkspace, { recursive: true, force: true });
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });
});

describe("loadMCPTools", () => {
  test("discovers every paginated tool and rejects repeated cursors", async () => {
    const connect = spyOn(McpClient.prototype, "connect").mockResolvedValue(undefined);
    const close = spyOn(McpClient.prototype, "close").mockResolvedValue(undefined);
    const transportClose = spyOn(StdioClientTransport.prototype, "close").mockResolvedValue(
      undefined,
    );
    const listTools = spyOn(McpClient.prototype, "listTools");
    const server: MCPServerConfig = {
      name: "paged",
      retries: 0,
      transport: { type: "stdio", command: "unused" },
    };
    try {
      listTools
        .mockResolvedValueOnce({
          tools: [{ name: "first", inputSchema: { type: "object" } }],
          nextCursor: "second-page",
        })
        .mockResolvedValueOnce({ tools: [{ name: "second", inputSchema: { type: "object" } }] });
      const loaded = await loadMCPTools([server]);
      try {
        expect(Object.keys(loaded.tools)).toEqual(["mcp__paged__first", "mcp__paged__second"]);
        expect(listTools).toHaveBeenNthCalledWith(2, { cursor: "second-page" });
      } finally {
        await loaded.close();
      }
      listTools.mockResolvedValue({ tools: [], nextCursor: "repeated" });
      const repeated = await loadMCPTools([server]);
      expect(repeated.errors[0]).toContain("repeated tools cursor");
      await repeated.close();
    } finally {
      connect.mockRestore();
      close.mockRestore();
      transportClose.mockRestore();
      listTools.mockRestore();
    }
  });

  test("caps oversized listTools descriptions before they reach the model", async () => {
    const connect = spyOn(McpClient.prototype, "connect").mockResolvedValue(undefined);
    const close = spyOn(McpClient.prototype, "close").mockResolvedValue(undefined);
    const transportClose = spyOn(StdioClientTransport.prototype, "close").mockResolvedValue(
      undefined,
    );
    const listTools = spyOn(McpClient.prototype, "listTools");
    const huge = "A".repeat(10_000);
    try {
      listTools.mockResolvedValue({
        tools: [
          { name: "huge", description: huge, inputSchema: { type: "object" } },
          { name: "", description: huge, inputSchema: { type: "object" } },
        ],
      });
      const loaded = await loadMCPTools([
        {
          name: "paged",
          retries: 0,
          transport: { type: "stdio", command: "unused" },
        },
      ]);
      try {
        const tool = loaded.tools["mcp__paged__huge"] as { description?: string } | undefined;
        expect(tool?.description).toBeDefined();
        expect(tool?.description?.length).toBeLessThan(huge.length);
        expect(tool?.description).toContain("[description truncated]");
        expect(Object.keys(loaded.tools)).toEqual(["mcp__paged__huge"]);
      } finally {
        await loaded.close();
      }
    } finally {
      connect.mockRestore();
      close.mockRestore();
      transportClose.mockRestore();
      listTools.mockRestore();
    }
  });

  test("closes the client and transport when initialization fails", async () => {
    const connect = spyOn(McpClient.prototype, "connect").mockRejectedValue(
      new Error("initialization failed"),
    );
    const close = spyOn(McpClient.prototype, "close").mockResolvedValue(undefined);
    const transportClose = spyOn(StdioClientTransport.prototype, "close").mockResolvedValue(
      undefined,
    );
    try {
      const loaded = await loadMCPTools([
        {
          name: "broken",
          retries: 0,
          transport: { type: "stdio", command: "unused" },
        },
      ]);
      expect(loaded.errors[0]).toContain("initialization failed");
      expect(close).toHaveBeenCalledTimes(1);
      expect(transportClose).toHaveBeenCalledTimes(1);
      await loaded.close();
    } finally {
      connect.mockRestore();
      close.mockRestore();
      transportClose.mockRestore();
    }
  });

  beforeEach(() => {
    mockCreateMCPClient.mockReset();
    mockCreateMCPClient.mockImplementation(async (_opts: any) => ({
      tools: mock(async () => ({ ping: { description: "ping" } })),
      close: mock(async () => {}),
    }));
  });

  test("prefixes tool names by server", async () => {
    const servers: MCPServerConfig[] = [
      { name: "local", transport: { type: "stdio", command: "echo" } },
    ];
    const result = await loadMCPTools(servers, { createClient: mockCreateMCPClient as any });
    expect(result.tools).toHaveProperty("mcp__local__ping");
  });

  test("normalizes spaces in server and tool names for provider-safe ids", async () => {
    mockCreateMCPClient.mockImplementation(async (_opts: any) => ({
      tools: mock(async () => ({
        search__reports: { description: "search" },
      })),
      close: mock(async () => {}),
    }));
    const servers: MCPServerConfig[] = [
      { name: "Diligence  Stack", transport: { type: "stdio", command: "echo" } },
    ];

    const result = await loadMCPTools(servers, { createClient: mockCreateMCPClient as any });

    expect(result.tools).toHaveProperty("mcp__Diligence_Stack__search_reports");
    expect(result.tools).not.toHaveProperty("mcp__Diligence__Stack__search__reports");
  });

  test("collects errors for optional server failures", async () => {
    mockCreateMCPClient.mockRejectedValue(new Error("refused"));
    const servers: MCPServerConfig[] = [
      { name: "flaky", transport: { type: "stdio", command: "echo" }, retries: 0 },
    ];
    const result = await loadMCPTools(servers, { createClient: mockCreateMCPClient as any });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("flaky");
  });

  test("loads servers concurrently and reports results in server order", async () => {
    const release = new Map<string, () => void>();
    const createClient = mock(async (opts: any) => {
      if (opts.name === "broken") throw new Error("refused");
      await new Promise<void>((resolve) => release.set(opts.name, resolve));
      return {
        tools: mock(async () => ({ ping: { description: opts.name } })),
        close: mock(async () => {}),
      };
    });
    const servers: MCPServerConfig[] = [
      { name: "alpha", transport: { type: "stdio", command: "echo" } },
      { name: "broken", transport: { type: "stdio", command: "echo" }, retries: 0 },
      { name: "beta", transport: { type: "stdio", command: "echo" } },
    ];

    const pending = loadMCPTools(servers, { createClient: createClient as any });
    // Both healthy servers were spawned before either finished — sequential
    // loading would not have reached "beta" while "alpha" was still blocked.
    expect([...release.keys()].sort()).toEqual(["alpha", "beta"]);
    // Finish out of order on purpose: the merged result must still follow the
    // configured server order, not the completion order.
    release.get("beta")?.();
    release.get("alpha")?.();

    const result = await pending;
    expect(Object.keys(result.tools)).toEqual(["mcp__alpha__ping", "mcp__beta__ping"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("broken");
  });

  test("required server failure closes connected clients and throws", async () => {
    const close = mock(async () => {});
    const createClient = mock(async (opts: any) => {
      if (opts.name === "required-broken") throw new Error("down");
      return {
        tools: mock(async () => ({ ping: { description: "t" } })),
        close,
      };
    });
    const servers: MCPServerConfig[] = [
      { name: "optional-ok", transport: { type: "stdio", command: "echo" } },
      {
        name: "required-broken",
        transport: { type: "stdio", command: "echo" },
        retries: 0,
        required: true,
      },
      { name: "also-ok", transport: { type: "stdio", command: "echo" } },
    ];

    await expect(loadMCPTools(servers, { createClient: createClient as any })).rejects.toThrow(
      "Failed to connect to required-broken after 1 attempts: Error: down",
    );
    // Every client that connected — before and after the required server in
    // config order — was torn down.
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe("mcp json schema normalization", () => {
  test("normalizes tuple array items into provider-safe item schemas", () => {
    const normalized = mcpInternal.normalizeMcpJsonSchema(
      {
        type: "object",
        properties: {
          position: {
            type: "array",
            items: [{ type: "number" }, { type: "number" }],
            additionalItems: false,
          },
        },
        required: ["position"],
      },
      true,
    ) as {
      properties: Record<
        string,
        {
          items?: unknown;
          maxItems?: unknown;
          additionalItems?: unknown;
        }
      >;
    };

    const position = normalized.properties.position;
    expect(Array.isArray(position?.items)).toBe(false);
    expect(position?.items).toEqual({ type: "number" });
    expect(position?.maxItems).toBe(2);
    expect(position?.additionalItems).toBeUndefined();
  });

  test("normalizes nested prefixItems and adds missing object types", () => {
    const normalized = mcpInternal.normalizeMcpJsonSchema(
      {
        properties: {
          command: {
            properties: {
              name: { enum: ["start", "stop"] },
            },
          },
          choices: {
            anyOf: [
              {
                type: "array",
                prefixItems: [{ const: "workspace" }, { const: "user" }],
              },
            ],
          },
        },
      },
      true,
    ) as {
      type?: unknown;
      properties: {
        command?: {
          type?: unknown;
          properties?: Record<string, unknown>;
        };
        choices?: {
          anyOf?: Array<{
            items?: unknown;
            maxItems?: unknown;
            prefixItems?: unknown;
          }>;
        };
      };
    };

    expect(normalized.type).toBe("object");
    expect(normalized.properties.command?.type).toBe("object");
    expect(normalized.properties.command?.properties?.name).toEqual({
      enum: ["start", "stop"],
    });

    const choicesArray = normalized.properties.choices?.anyOf?.[0];
    expect(Array.isArray(choicesArray?.items)).toBe(false);
    expect(choicesArray?.items).toEqual({
      anyOf: [{ const: "workspace" }, { const: "user" }],
    });
    expect(choicesArray?.maxItems).toBe(2);
    expect(choicesArray?.prefixItems).toBeUndefined();
  });

  test("caps oversized nested property/enum descriptions", () => {
    const huge = "A".repeat(10_000);
    const normalized = mcpInternal.normalizeMcpJsonSchema(
      {
        type: "object",
        description: huge,
        properties: {
          query: { type: "string", description: huge },
        },
      },
      true,
    ) as {
      description?: string;
      properties: { query?: { description?: string } };
    };

    expect(normalized.description?.length).toBeLessThan(huge.length);
    expect(normalized.description).toContain("[description truncated]");
    // The nested property description must be capped too, not just the top level.
    expect(normalized.properties.query?.description?.length).toBeLessThan(huge.length);
    expect(normalized.properties.query?.description).toContain("[description truncated]");
  });
});
