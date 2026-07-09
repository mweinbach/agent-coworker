import { beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { __internal, closeMcpServersForSession, getOrLoadMCPToolsCached } from "../src/mcp";
import type { AgentConfig, MCPServerConfig } from "../src/types";

describe("MCP Caching and Lifecycle", () => {
  const workspaceA = path.resolve("/path/to/workspace-a");

  beforeEach(() => {
    __internal.workspaceMcpCache.clear();
  });

  const makeConfig = (projectCoworkDir: string): AgentConfig =>
    ({
      projectCoworkDir,
      provider: "openai",
      model: "gpt-4o",
      enableMcp: true,
    }) as unknown as AgentConfig;

  test("should cache connections and only spawn once for same config and workspace", async () => {
    const config = makeConfig("/path/to/workspace-a");
    const servers: MCPServerConfig[] = [
      {
        name: "test-server",
        transport: { type: "stdio", command: "node" },
      },
    ];

    const mockClose = mock(async () => {});
    const loadMCPServers = mock(async () => servers);
    const loadMCPTools = mock(async () => ({
      tools: { "mcp__test-server__tool": {} },
      errors: [],
      close: mockClose,
    }));

    // First load for session-1
    const result1 = await getOrLoadMCPToolsCached(config, "session-1", {
      loadMCPServers,
      loadMCPTools,
    });

    expect(loadMCPServers).toHaveBeenCalledTimes(1);
    expect(loadMCPTools).toHaveBeenCalledTimes(1);
    expect(result1.tools).toHaveProperty("mcp__test-server__tool");

    const cacheEntry = __internal.workspaceMcpCache.get(workspaceA);
    expect(cacheEntry).toBeDefined();
    expect(cacheEntry?.sessionIds.has("session-1")).toBe(true);

    // Second load for session-1 (same session, same config)
    const result2 = await getOrLoadMCPToolsCached(config, "session-1", {
      loadMCPServers,
      loadMCPTools,
    });

    expect(loadMCPServers).toHaveBeenCalledTimes(2); // loadMCPServers is called to fetch latest config, but loadMCPTools should NOT be called again
    expect(loadMCPTools).toHaveBeenCalledTimes(1);
    expect(result2.tools).toHaveProperty("mcp__test-server__tool");

    // Load for session-2 (different session, same config)
    const result3 = await getOrLoadMCPToolsCached(config, "session-2", {
      loadMCPServers,
      loadMCPTools,
    });

    expect(loadMCPServers).toHaveBeenCalledTimes(3);
    expect(loadMCPTools).toHaveBeenCalledTimes(1);
    expect(result3.tools).toHaveProperty("mcp__test-server__tool");
    expect(cacheEntry?.sessionIds.has("session-1")).toBe(true);
    expect(cacheEntry?.sessionIds.has("session-2")).toBe(true);
  });

  test("should not close connections on session close if other sessions are still using it", async () => {
    const config = makeConfig("/path/to/workspace-a");
    const servers: MCPServerConfig[] = [
      {
        name: "test-server",
        transport: { type: "stdio", command: "node" },
      },
    ];

    const mockClose = mock(async () => {});
    const loadMCPServers = mock(async () => servers);
    const loadMCPTools = mock(async () => ({
      tools: { "mcp__test-server__tool": {} },
      errors: [],
      close: mockClose,
    }));

    await getOrLoadMCPToolsCached(config, "session-1", { loadMCPServers, loadMCPTools });
    await getOrLoadMCPToolsCached(config, "session-2", { loadMCPServers, loadMCPTools });

    // Close session-1
    await closeMcpServersForSession("session-1");
    expect(mockClose).not.toHaveBeenCalled();

    const cacheEntry = __internal.workspaceMcpCache.get(workspaceA);
    expect(cacheEntry).toBeDefined();
    expect(cacheEntry?.sessionIds.has("session-1")).toBe(false);
    expect(cacheEntry?.sessionIds.has("session-2")).toBe(true);

    // Close session-2
    await closeMcpServersForSession("session-2");
    expect(mockClose).toHaveBeenCalledTimes(1);

    expect(__internal.workspaceMcpCache.has(workspaceA)).toBe(false);
  });

  test("should reload servers and close old connections if config changes", async () => {
    const config = makeConfig("/path/to/workspace-a");
    const servers1: MCPServerConfig[] = [
      {
        name: "test-server",
        transport: { type: "stdio", command: "node" },
      },
    ];
    const servers2: MCPServerConfig[] = [
      {
        name: "test-server",
        transport: { type: "stdio", command: "bun" }, // command changed
      },
    ];

    const mockClose1 = mock(async () => {});
    const mockClose2 = mock(async () => {});

    let currentServers = servers1;
    const loadMCPServers = mock(async () => currentServers);
    const loadMCPTools = mock(async (servers) => {
      const isBun = (servers[0]?.transport as { command?: string } | undefined)?.command === "bun";
      return {
        tools: { [isBun ? "bun-tool" : "node-tool"]: {} },
        errors: [],
        close: isBun ? mockClose2 : mockClose1,
      };
    });

    // First load (servers1)
    const result1 = await getOrLoadMCPToolsCached(config, "session-1", {
      loadMCPServers,
      loadMCPTools,
    });
    expect(result1.tools).toHaveProperty("node-tool");
    expect(loadMCPTools).toHaveBeenCalledTimes(1);

    // Change server configs
    currentServers = servers2;

    // Second load (servers2)
    const result2 = await getOrLoadMCPToolsCached(config, "session-1", {
      loadMCPServers,
      loadMCPTools,
    });

    expect(mockClose1).toHaveBeenCalledTimes(1); // Old servers should be closed
    expect(loadMCPTools).toHaveBeenCalledTimes(2);
    expect(result2.tools).toHaveProperty("bun-tool");
    expect(result2.tools).not.toHaveProperty("node-tool");
  });

  test("returns cached load errors on cache hit so later sessions can surface them", async () => {
    const config = makeConfig("/path/to/workspace-a");
    const servers: MCPServerConfig[] = [
      { name: "broken-server", transport: { type: "stdio", command: "node" } },
    ];

    const loadMCPServers = mock(async () => servers);
    const loadMCPTools = mock(async () => ({
      tools: {},
      errors: ["[MCP] Failed to connect to broken-server after 4 attempts: boom"],
      close: mock(async () => {}),
    }));

    const first = await getOrLoadMCPToolsCached(config, "session-1", {
      loadMCPServers,
      loadMCPTools,
    });
    expect(first.errors).toHaveLength(1);

    // Cache hit for a different session must still report the load errors.
    const second = await getOrLoadMCPToolsCached(config, "session-2", {
      loadMCPServers,
      loadMCPTools,
    });
    expect(loadMCPTools).toHaveBeenCalledTimes(1);
    expect(second.errors).toEqual(first.errors);
  });

  test("completes session close and logs when a cached close throws", async () => {
    const config = makeConfig("/path/to/workspace-a");
    const servers: MCPServerConfig[] = [
      { name: "test-server", transport: { type: "stdio", command: "node" } },
    ];

    const loadMCPServers = mock(async () => servers);
    const loadMCPTools = mock(async () => ({
      tools: { "mcp__test-server__tool": {} },
      errors: [],
      close: mock(async () => {
        throw new Error("close exploded");
      }),
    }));

    await getOrLoadMCPToolsCached(config, "session-1", { loadMCPServers, loadMCPTools });

    const warnSpy = mock((..._args: unknown[]) => {});
    const originalWarn = console.warn;
    console.warn = warnSpy as unknown as typeof console.warn;
    try {
      await closeMcpServersForSession("session-1");
    } finally {
      console.warn = originalWarn;
    }

    expect(__internal.workspaceMcpCache.has(workspaceA)).toBe(false);
    expect(
      warnSpy.mock.calls.some((call) => String(call[0]).includes("Error closing MCP servers")),
    ).toBe(true);
  });
});
