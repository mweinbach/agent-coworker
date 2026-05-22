import { beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import { CODEX_APPS_MCP_SERVER_NAME } from "../src/shared/openaiNativeConnectors";
import type { AgentConfig, MCPServerConfig } from "../src/types";

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
  test("loadMCPServers does not inject a direct codex_apps server", async () => {
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
      const codexApps = servers.find((server) => server.name === CODEX_APPS_MCP_SERVER_NAME);

      expect(codexApps).toBeUndefined();
    } finally {
      await fs.rm(tmpWorkspace, { recursive: true, force: true });
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });

  test("loadMCPTools filters codex_apps tools to enabled connector ids", async () => {
    const { tools } = await loadMCPTools(
      [
        {
          name: CODEX_APPS_MCP_SERVER_NAME,
          transport: { type: "http", url: "https://apps.example.invalid/mcp" },
          enabledConnectorIds: ["connector_gmail"],
        } as MCPServerConfig & { enabledConnectorIds: string[] },
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

    expect(Object.keys(tools)).toEqual([`mcp__${CODEX_APPS_MCP_SERVER_NAME}__search_email`]);
    expect((tools[`mcp__${CODEX_APPS_MCP_SERVER_NAME}__search_email`] as any)._meta).toEqual({
      connector_id: "connector_gmail",
      _codex_apps: { resource_uri: "app://g" },
    });
  });
});

describe("runtime auth injection", () => {
  test("loadMCPServers injects API key headers from auth store", async () => {
    const tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-runtime-api-workspace-"));
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-runtime-api-home-"));
    const builtInConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-runtime-api-builtin-"));

    try {
      const config = makeConfig(tmpWorkspace, tmpHome, builtInConfigDir);
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
      const config = makeConfig(tmpWorkspace, tmpHome, builtInConfigDir);

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
      const config = makeConfig(tmpWorkspace, tmpHome, builtInConfigDir);
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
      const config = makeConfig(tmpWorkspace, tmpHome, builtInConfigDir);
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
        expect((server.transport as any).authProvider).toBeDefined();
      }
    } finally {
      await fs.rm(tmpWorkspace, { recursive: true, force: true });
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(builtInConfigDir, { recursive: true, force: true });
    }
  });
});

describe("loadMCPTools", () => {
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

  test("collects errors for optional server failures", async () => {
    mockCreateMCPClient.mockRejectedValue(new Error("refused"));
    const servers: MCPServerConfig[] = [
      { name: "flaky", transport: { type: "stdio", command: "echo" }, retries: 0 },
    ];
    const result = await loadMCPTools(servers, { createClient: mockCreateMCPClient as any });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("flaky");
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
});
