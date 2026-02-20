import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentConfig, MCPServerConfig } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const base = "/tmp/mcp-test";
  return {
    provider: "google",
    model: "gemini-2.0-flash",
    subAgentModel: "gemini-2.0-flash",
    workingDirectory: base,
    outputDirectory: path.join(base, "output"),
    uploadsDirectory: path.join(base, "uploads"),
    userName: "tester",
    knowledgeCutoff: "2025-01",
    projectAgentDir: path.join(base, ".agent"),
    userAgentDir: path.join(base, ".agent-user"),
    builtInDir: base,
    builtInConfigDir: path.join(base, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    ...overrides,
  };
}

async function writeJson(filePath: string, obj: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(obj, null, 2), "utf-8");
}

const mockCreateMCPClient = mock(async (_opts: any) => ({
  tools: mock(async () => ({})),
  close: mock(async () => {}),
}));

import { loadMCPServers, loadMCPTools } from "../src/mcp/index";

function loadMCPToolsWithMock(
  servers: MCPServerConfig[],
  opts: { log?: (line: string) => void; sleep?: (ms: number) => Promise<void> } = {}
) {
  return loadMCPTools(servers, {
    ...opts,
    createClient: mockCreateMCPClient as any,
  });
}

// ---------------------------------------------------------------------------
// loadMCPServers
// ---------------------------------------------------------------------------

describe("loadMCPServers", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-servers-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("loads servers from mcp-servers.json in configDirs", async () => {
    const dir1 = path.join(tmpDir, "dir1");
    await writeJson(path.join(dir1, "mcp-servers.json"), {
      servers: [
        { name: "server-a", transport: { type: "stdio", command: "echo", args: [] } },
      ],
    });

    const config = makeConfig({ configDirs: [dir1] });
    const servers = await loadMCPServers(config);

    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("server-a");
  });

  test("handles missing files gracefully", async () => {
    const dir1 = path.join(tmpDir, "nonexistent");
    const config = makeConfig({ configDirs: [dir1] });
    const servers = await loadMCPServers(config);

    expect(servers).toEqual([]);
  });

  test("handles invalid JSON gracefully", async () => {
    const dir1 = path.join(tmpDir, "bad-json");
    await fs.mkdir(dir1, { recursive: true });
    await fs.writeFile(path.join(dir1, "mcp-servers.json"), "NOT VALID JSON {{{", "utf-8");

    const config = makeConfig({ configDirs: [dir1] });
    const servers = await loadMCPServers(config);

    expect(servers).toEqual([]);
  });

  test("merges servers from multiple config dirs (later overrides earlier by name)", async () => {
    // The source iterates configDirs in reverse order (low->high priority),
    // so configDirs[0] is highest priority.
    const dirLow = path.join(tmpDir, "low");
    const dirHigh = path.join(tmpDir, "high");

    await writeJson(path.join(dirLow, "mcp-servers.json"), {
      servers: [
        { name: "shared", transport: { type: "stdio", command: "old-cmd", args: [] } },
        { name: "only-low", transport: { type: "stdio", command: "low-cmd", args: [] } },
      ],
    });

    await writeJson(path.join(dirHigh, "mcp-servers.json"), {
      servers: [
        { name: "shared", transport: { type: "stdio", command: "new-cmd", args: [] } },
      ],
    });

    // configDirs order: high priority first (index 0)
    const config = makeConfig({ configDirs: [dirHigh, dirLow] });
    const servers = await loadMCPServers(config);

    const shared = servers.find((s) => s.name === "shared");
    expect(shared).toBeDefined();
    expect((shared!.transport as any).command).toBe("new-cmd");

    const onlyLow = servers.find((s) => s.name === "only-low");
    expect(onlyLow).toBeDefined();
  });

  test("returns empty array when no servers configured", async () => {
    const dir1 = path.join(tmpDir, "empty");
    await writeJson(path.join(dir1, "mcp-servers.json"), { servers: [] });

    const config = makeConfig({ configDirs: [dir1] });
    const servers = await loadMCPServers(config);

    expect(servers).toEqual([]);
  });

  test("returns empty array when configDirs is empty", async () => {
    const config = makeConfig({ configDirs: [] });
    const servers = await loadMCPServers(config);

    expect(servers).toEqual([]);
  });

  test("ignores entries without name", async () => {
    const dir1 = path.join(tmpDir, "no-name");
    await writeJson(path.join(dir1, "mcp-servers.json"), {
      servers: [
        { transport: { type: "stdio", command: "echo", args: [] } },
        { name: "", transport: { type: "stdio", command: "echo", args: [] } },
        { name: "valid", transport: { type: "stdio", command: "echo", args: [] } },
      ],
    });

    const config = makeConfig({ configDirs: [dir1] });
    const servers = await loadMCPServers(config);

    // The source checks `if (server?.name)` which is falsy for undefined and ""
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("valid");
  });

  test("handles file with no servers key", async () => {
    const dir1 = path.join(tmpDir, "no-key");
    await writeJson(path.join(dir1, "mcp-servers.json"), { other: "data" });

    const config = makeConfig({ configDirs: [dir1] });
    const servers = await loadMCPServers(config);

    expect(servers).toEqual([]);
  });

  test("loads servers with http transport", async () => {
    const dir1 = path.join(tmpDir, "http");
    await writeJson(path.join(dir1, "mcp-servers.json"), {
      servers: [
        { name: "http-server", transport: { type: "http", url: "http://localhost:3000" } },
      ],
    });

    const config = makeConfig({ configDirs: [dir1] });
    const servers = await loadMCPServers(config);

    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("http-server");
    expect((servers[0].transport as any).type).toBe("http");
  });

  test("preserves required and retries fields", async () => {
    const dir1 = path.join(tmpDir, "fields");
    await writeJson(path.join(dir1, "mcp-servers.json"), {
      servers: [
        {
          name: "important",
          transport: { type: "stdio", command: "x", args: [] },
          required: true,
          retries: 5,
        },
      ],
    });

    const config = makeConfig({ configDirs: [dir1] });
    const servers = await loadMCPServers(config);

    expect(servers[0].required).toBe(true);
    expect(servers[0].retries).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// loadMCPTools
// ---------------------------------------------------------------------------

describe("loadMCPTools", () => {
  beforeEach(() => {
    mockCreateMCPClient.mockClear();

    // Default: successful client
    mockCreateMCPClient.mockImplementation(async () => ({
      tools: mock(async () => ({
        toolA: { description: "Tool A" },
        toolB: { description: "Tool B" },
      })),
      close: mock(async () => {}),
    }));
  });

  test("returns empty tools/errors for empty servers array", async () => {
    const result = await loadMCPToolsWithMock([]);

    expect(result.tools).toEqual({});
    expect(result.errors).toEqual([]);
    expect(typeof result.close).toBe("function");
  });

  test("prefixes tool names with mcp__serverName__toolName format", async () => {
    const servers: MCPServerConfig[] = [
      { name: "myServer", transport: { type: "stdio", command: "echo", args: [] } },
    ];

    const result = await loadMCPToolsWithMock(servers);

    expect(result.tools).toHaveProperty("mcp__myServer__toolA");
    expect(result.tools).toHaveProperty("mcp__myServer__toolB");
    expect(Object.keys(result.tools)).toHaveLength(2);
  });

  test("loads tools from multiple servers", async () => {
    let callCount = 0;
    mockCreateMCPClient.mockImplementation(async () => {
      callCount++;
      return {
        tools: mock(async () => ({
          [`tool${callCount}`]: { description: `Tool ${callCount}` },
        })),
        close: mock(async () => {}),
      };
    });

    const servers: MCPServerConfig[] = [
      { name: "serverA", transport: { type: "stdio", command: "a", args: [] } },
      { name: "serverB", transport: { type: "stdio", command: "b", args: [] } },
    ];

    const result = await loadMCPToolsWithMock(servers);

    expect(result.tools).toHaveProperty("mcp__serverA__tool1");
    expect(result.tools).toHaveProperty("mcp__serverB__tool2");
  });

  test("handles server connection failures for optional servers", async () => {
    mockCreateMCPClient.mockRejectedValue(new Error("Connection refused"));

    const servers: MCPServerConfig[] = [
      { name: "flaky", transport: { type: "stdio", command: "x", args: [] }, retries: 0 },
    ];

    const result = await loadMCPToolsWithMock(servers);

    expect(result.tools).toEqual({});
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("flaky");
    expect(result.errors[0]).toContain("Connection refused");
  });

  test("retry logic retries the configured number of times", async () => {
    mockCreateMCPClient.mockRejectedValue(new Error("timeout"));

    const servers: MCPServerConfig[] = [
      { name: "retry-server", transport: { type: "stdio", command: "x", args: [] }, retries: 2 },
    ];

    // Override setTimeout to speed up retries
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: Function) => origSetTimeout(fn, 0)) as any;

    try {
      const result = await loadMCPToolsWithMock(servers);

      // retries=2 means 1 initial + 2 retries = 3 total attempts
      expect(mockCreateMCPClient).toHaveBeenCalledTimes(3);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("3 attempts");
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });

  test("defaults to 3 retries when retries is not specified", async () => {
    mockCreateMCPClient.mockRejectedValue(new Error("fail"));

    const servers: MCPServerConfig[] = [
      { name: "default-retries", transport: { type: "stdio", command: "x", args: [] } },
    ];

    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: Function) => origSetTimeout(fn, 0)) as any;

    try {
      const result = await loadMCPToolsWithMock(servers);

      // default retries=3 means 1 initial + 3 retries = 4 total attempts
      expect(mockCreateMCPClient).toHaveBeenCalledTimes(4);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("4 attempts");
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });

  test("required servers throw on failure", async () => {
    mockCreateMCPClient.mockRejectedValue(new Error("Connection refused"));

    const servers: MCPServerConfig[] = [
      {
        name: "critical",
        transport: { type: "stdio", command: "x", args: [] },
        required: true,
        retries: 0,
      },
    ];

    await expect(loadMCPToolsWithMock(servers)).rejects.toThrow("critical");
  });

  test("required server failure closes previously connected optional clients", async () => {
    const optionalClose = mock(async () => {});
    let call = 0;
    mockCreateMCPClient.mockImplementation(async () => {
      call++;
      if (call === 1) {
        return {
          tools: mock(async () => ({ optionalTool: {} })),
          close: optionalClose,
        };
      }
      throw new Error("required-down");
    });

    const servers: MCPServerConfig[] = [
      { name: "optional-first", transport: { type: "stdio", command: "x", args: [] }, retries: 0 },
      {
        name: "required-second",
        transport: { type: "stdio", command: "y", args: [] },
        required: true,
        retries: 0,
      },
    ];

    await expect(loadMCPToolsWithMock(servers)).rejects.toThrow("required-second");
    expect(optionalClose).toHaveBeenCalledTimes(1);
  });

  test("negative retries are clamped to 0", async () => {
    mockCreateMCPClient.mockRejectedValue(new Error("fail-fast"));
    const servers: MCPServerConfig[] = [
      { name: "negative-retry", transport: { type: "stdio", command: "x", args: [] }, retries: -5 },
    ];

    const result = await loadMCPToolsWithMock(servers);
    expect(mockCreateMCPClient).toHaveBeenCalledTimes(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("1 attempts");
  });

  test("optional servers add to errors array on failure", async () => {
    mockCreateMCPClient.mockRejectedValue(new Error("Cannot connect"));

    const servers: MCPServerConfig[] = [
      {
        name: "optional-server",
        transport: { type: "stdio", command: "x", args: [] },
        required: false,
        retries: 0,
      },
    ];

    const result = await loadMCPToolsWithMock(servers);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("optional-server");
    expect(result.errors[0]).toContain("Cannot connect");
  });

  test("logs connection success messages", async () => {
    const logFn = mock(() => {});

    const servers: MCPServerConfig[] = [
      { name: "logged-server", transport: { type: "stdio", command: "x", args: [] } },
    ];

    await loadMCPToolsWithMock(servers, { log: logFn });

    const logCalls = logFn.mock.calls.map((c) => c[0]);
    const successLog = logCalls.find((msg: string) => msg.includes("Connected to logged-server"));
    expect(successLog).toBeDefined();
    expect(successLog).toContain("2 tools");
  });

  test("logs error messages for failed optional servers", async () => {
    mockCreateMCPClient.mockRejectedValue(new Error("refused"));
    const logFn = mock(() => {});

    const servers: MCPServerConfig[] = [
      { name: "fail-server", transport: { type: "stdio", command: "x", args: [] }, retries: 0 },
    ];

    await loadMCPToolsWithMock(servers, { log: logFn });

    const logCalls = logFn.mock.calls.map((c) => c[0]);
    const errorLog = logCalls.find((msg: string) => msg.includes("Failed to connect"));
    expect(errorLog).toBeDefined();
    expect(errorLog).toContain("fail-server");
  });

  test("logs retry attempts", async () => {
    let attempt = 0;
    mockCreateMCPClient.mockImplementation(async () => {
      attempt++;
      if (attempt < 2) throw new Error("not ready");
      return {
        tools: mock(async () => ({ t: {} })),
        close: mock(async () => {}),
      };
    });

    const logFn = mock(() => {});

    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: Function) => origSetTimeout(fn, 0)) as any;

    try {
      const servers: MCPServerConfig[] = [
        { name: "flaky", transport: { type: "stdio", command: "x", args: [] }, retries: 3 },
      ];

      await loadMCPToolsWithMock(servers, { log: logFn });

      const logCalls = logFn.mock.calls.map((c) => c[0]);
      const retryLog = logCalls.find((msg: string) => msg.includes("Retrying"));
      expect(retryLog).toBeDefined();
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });

  test("succeeds on retry after initial failure", async () => {
    let attempt = 0;
    mockCreateMCPClient.mockImplementation(async () => {
      attempt++;
      if (attempt === 1) throw new Error("temporary failure");
      return {
        tools: mock(async () => ({ recovered: { description: "recovered tool" } })),
        close: mock(async () => {}),
      };
    });

    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: Function) => origSetTimeout(fn, 0)) as any;

    try {
      const servers: MCPServerConfig[] = [
        { name: "recoverable", transport: { type: "stdio", command: "x", args: [] }, retries: 2 },
      ];

      const result = await loadMCPToolsWithMock(servers);

      expect(result.tools).toHaveProperty("mcp__recoverable__recovered");
      expect(result.errors).toEqual([]);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });

  test("passes server name and transport to createMCPClient", async () => {
    const transport = { type: "stdio" as const, command: "my-cmd", args: ["--flag"] };
    const servers: MCPServerConfig[] = [
      { name: "check-args", transport },
    ];

    await loadMCPToolsWithMock(servers);

    expect(mockCreateMCPClient).toHaveBeenCalledTimes(1);
    const callArg = mockCreateMCPClient.mock.calls[0][0] as any;
    expect(callArg.name).toBe("check-args");
    // stdio transport is wrapped in a proper MCP transport implementation
    expect(callArg.transport).toBeDefined();
    expect(typeof callArg.transport.start).toBe("function");
    expect(typeof callArg.transport.send).toBe("function");
    expect(typeof callArg.transport.close).toBe("function");
  });

  test("passes http transport config through to createMCPClient", async () => {
    const transport = { type: "http" as const, url: "http://localhost:3000" };
    const servers: MCPServerConfig[] = [
      { name: "http-args", transport },
    ];

    await loadMCPToolsWithMock(servers);

    expect(mockCreateMCPClient).toHaveBeenCalledTimes(1);
    const callArg = mockCreateMCPClient.mock.calls[0][0] as any;
    expect(callArg.name).toBe("http-args");
    expect(callArg.transport).toBe(transport);
  });

  test("works without log option", async () => {
    const servers: MCPServerConfig[] = [
      { name: "no-log", transport: { type: "stdio", command: "x", args: [] } },
    ];

    // Should not throw even though no log function is provided
    const result = await loadMCPToolsWithMock(servers);
    expect(result.tools).toHaveProperty("mcp__no-log__toolA");
  });
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

describe("loadMCPTools().close", () => {
  test("closes all clients created during discovery", async () => {
    const closeFns = [mock(async () => {}), mock(async () => {})];
    let i = 0;

    mockCreateMCPClient.mockImplementation(async () => ({
      tools: mock(async () => ({ t: {} })),
      close: closeFns[i++],
    }));

    const servers: MCPServerConfig[] = [
      { name: "srv1", transport: { type: "stdio", command: "x", args: [] } },
      { name: "srv2", transport: { type: "stdio", command: "y", args: [] } },
    ];

    const result = await loadMCPToolsWithMock(servers);
    await expect(result.close()).resolves.toBeUndefined();

    expect(closeFns[0]).toHaveBeenCalledTimes(1);
    expect(closeFns[1]).toHaveBeenCalledTimes(1);
  });

  test("handles errors during close gracefully", async () => {
    const closeFn = mock(async () => {
      throw new Error("close failed");
    });
    mockCreateMCPClient.mockImplementation(async () => ({
      tools: mock(async () => ({ t: {} })),
      close: closeFn,
    }));

    const servers: MCPServerConfig[] = [
      { name: "err-close", transport: { type: "stdio", command: "x", args: [] } },
    ];

    const result = await loadMCPToolsWithMock(servers);
    await expect(result.close()).resolves.toBeUndefined();
  });

  test("is idempotent when called more than once", async () => {
    const closeFn = mock(async () => {});
    mockCreateMCPClient.mockImplementation(async () => ({
      tools: mock(async () => ({ t: {} })),
      close: closeFn,
    }));

    const servers: MCPServerConfig[] = [
      { name: "idempotent-close", transport: { type: "stdio", command: "x", args: [] } },
    ];

    const result = await loadMCPToolsWithMock(servers);
    await result.close();
    await result.close();

    expect(closeFn).toHaveBeenCalledTimes(1);
  });
});
