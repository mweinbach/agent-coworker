import { beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { __internal, closeMcpServersForSession, getOrLoadMCPToolsCached } from "../src/mcp";
import { WorkspaceMcpToolCache } from "../src/mcp/toolCache";
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

  test("transient failures are retried after backoff instead of cached for the session lifetime", async () => {
    let now = 0;
    let recovered = false;
    const loadMCPTools = mock(async () => ({
      tools: recovered ? { available: {} } : {},
      errors: recovered ? [] : ["temporarily unavailable"],
      close: async () => {},
    }));
    const cache = new WorkspaceMcpToolCache(
      {
        loadMCPServers: async () => [
          { name: "flaky", transport: { type: "stdio", command: "bun" } },
        ],
        loadMCPTools,
      },
      () => now,
    );
    const config = makeConfig(workspaceA);
    await cache.load(config, "session-1");
    recovered = true;
    await cache.load(config, "session-1");
    expect(loadMCPTools).toHaveBeenCalledTimes(1);
    now = 60_000;
    const result = await cache.load(config, "session-1");
    expect(loadMCPTools).toHaveBeenCalledTimes(2);
    expect(result.errors).toEqual([]);
    expect(result.tools).toEqual({ available: {} });
    await cache.closeSession("session-1");
  });

  test("concurrent first loads share one connection and retain both session owners", async () => {
    const config = makeConfig(workspaceA);
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const close = mock(async () => {});
    const deps = {
      loadMCPServers: async () => [
        { name: "shared", transport: { type: "stdio" as const, command: "bun" } },
      ],
      loadMCPTools: mock(async () => {
        signalStarted();
        await loadGate;
        return { tools: { shared: {} }, errors: [], close };
      }),
    };
    const first = getOrLoadMCPToolsCached(config, "session-1", deps);
    const second = getOrLoadMCPToolsCached(config, "session-2", deps);
    await started;
    releaseLoad();
    await Promise.all([first, second]);
    expect(deps.loadMCPTools).toHaveBeenCalledTimes(1);
    expect(__internal.workspaceMcpCache.get(workspaceA)?.sessionIds).toEqual(
      new Set(["session-1", "session-2"]),
    );
    await closeMcpServersForSession("session-1");
    expect(close).not.toHaveBeenCalled();
    await closeMcpServersForSession("session-2");
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("closing a session during discovery releases its eventual connection", async () => {
    const config = makeConfig(workspaceA);
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const close = mock(async () => {});
    const loading = getOrLoadMCPToolsCached(config, "session-1", {
      loadMCPServers: async () => [
        { name: "shared", transport: { type: "stdio", command: "bun" } },
      ],
      loadMCPTools: async () => {
        signalStarted();
        await loadGate;
        return { tools: {}, errors: [], close };
      },
    });
    await started;
    const closing = closeMcpServersForSession("session-1");
    releaseLoad();
    await Promise.all([loading, closing]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(__internal.workspaceMcpCache.has(workspaceA)).toBe(false);
  });

  test("configuration replacement keeps old clients alive for sessions still using them", async () => {
    const config = makeConfig(workspaceA);
    let command = "old";
    const oldClose = mock(async () => {});
    const newClose = mock(async () => {});
    const deps = {
      loadMCPServers: async () => [
        { name: "shared", transport: { type: "stdio" as const, command } },
      ],
      loadMCPTools: async () => ({
        tools: { [command]: {} },
        errors: [],
        close: command === "old" ? oldClose : newClose,
      }),
    };
    await getOrLoadMCPToolsCached(config, "session-1", deps);
    await getOrLoadMCPToolsCached(config, "session-2", deps);
    command = "new";
    await getOrLoadMCPToolsCached(config, "session-1", deps);
    expect(oldClose).not.toHaveBeenCalled();
    await closeMcpServersForSession("session-2");
    expect(oldClose).toHaveBeenCalledTimes(1);
    expect(newClose).not.toHaveBeenCalled();
    await closeMcpServersForSession("session-1");
    expect(newClose).toHaveBeenCalledTimes(1);
  });

  test("a session joining during teardown gets a live replacement", async () => {
    const config = makeConfig(workspaceA);
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let signalClosing!: () => void;
    const closingStarted = new Promise<void>((resolve) => {
      signalClosing = resolve;
    });
    let loads = 0;
    const deps = {
      loadMCPServers: async () => [
        { name: "shared", transport: { type: "stdio" as const, command: "bun" } },
      ],
      loadMCPTools: async () => {
        const generation = ++loads;
        return {
          tools: { [generation]: {} },
          errors: [],
          close: async () => {
            if (generation === 1) {
              signalClosing();
              await closeGate;
            }
          },
        };
      },
    };
    await getOrLoadMCPToolsCached(config, "session-1", deps);
    const closing = closeMcpServersForSession("session-1");
    await closingStarted;
    const joining = getOrLoadMCPToolsCached(config, "session-2", deps);
    releaseClose();
    const [, result] = await Promise.all([closing, joining]);
    expect(loads).toBe(2);
    expect(result.tools).toEqual({ 2: {} });
    expect(__internal.workspaceMcpCache.get(workspaceA)?.sessionIds.has("session-2")).toBe(true);
    await closeMcpServersForSession("session-2");
  });

  test("a failed replacement does not tear down the working cached client", async () => {
    const config = makeConfig(workspaceA);
    let command = "working";
    const close = mock(async () => {});
    const deps = {
      loadMCPServers: async () => [
        { name: "shared", transport: { type: "stdio" as const, command } },
      ],
      loadMCPTools: async () => {
        if (command === "broken") throw new Error("replacement failed");
        return { tools: { working: {} }, errors: [], close };
      },
    };
    await getOrLoadMCPToolsCached(config, "session-1", deps);
    command = "broken";
    await expect(getOrLoadMCPToolsCached(config, "session-2", deps)).rejects.toThrow(
      "replacement failed",
    );
    expect(close).not.toHaveBeenCalled();
    await closeMcpServersForSession("session-1");
    expect(close).toHaveBeenCalledTimes(1);
  });

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
