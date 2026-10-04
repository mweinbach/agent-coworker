import { beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { __internal, closeMcpServersForSession, getOrLoadMCPToolsCached } from "../src/mcp";
import { WorkspaceMcpToolCache } from "../src/mcp/toolCache";
import type { AgentConfig, MCPServerConfig } from "../src/types";

describe("MCP Caching and Lifecycle", () => {
  const workspaceA = path.resolve("/path/to/workspace-a");
  const config = {
    projectCoworkDir: workspaceA,
    provider: "openai",
    model: "gpt-4o",
    enableMcp: true,
  } as unknown as AgentConfig;
  const stdioServer = (name: string, command = "bun"): MCPServerConfig => ({
    name,
    transport: { type: "stdio", command },
  });

  beforeEach(() => {
    __internal.workspaceMcpCache.clear();
  });

  test("transient failures are retried after backoff instead of cached for the session lifetime", async () => {
    let now = 0;
    let recovered = false;
    const loadMCPTools = mock(async () => ({
      tools: recovered ? { available: {} } : {},
      errors: recovered ? [] : ["temporarily unavailable"],
      close: async () => {},
    }));
    const cache = new WorkspaceMcpToolCache(
      { loadMCPServers: async () => [stdioServer("flaky")], loadMCPTools },
      () => now,
    );
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
    const loadGate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const close = mock(async () => {});
    const deps = {
      loadMCPServers: async () => [stdioServer("shared")],
      loadMCPTools: mock(async () => {
        started.resolve();
        await loadGate.promise;
        return { tools: { shared: {} }, errors: [], close };
      }),
    };
    const first = getOrLoadMCPToolsCached(config, "session-1", deps);
    const second = getOrLoadMCPToolsCached(config, "session-2", deps);
    await started.promise;
    loadGate.resolve();
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
    const loadGate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const close = mock(async () => {});
    const loading = getOrLoadMCPToolsCached(config, "session-1", {
      loadMCPServers: async () => [stdioServer("shared")],
      loadMCPTools: async () => {
        started.resolve();
        await loadGate.promise;
        return { tools: {}, errors: [], close };
      },
    });
    await started.promise;
    const closing = closeMcpServersForSession("session-1");
    loadGate.resolve();
    await Promise.all([loading, closing]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(__internal.workspaceMcpCache.has(workspaceA)).toBe(false);
  });

  test("configuration replacement retires idle clients while retaining every session owner", async () => {
    let command = "old";
    const oldClose = mock(async () => {});
    const newClose = mock(async () => {});
    const deps = {
      loadMCPServers: async () => [stdioServer("shared", command)],
      loadMCPTools: mock(async () => ({
        tools: { [command]: {} },
        errors: [],
        close: command === "old" ? oldClose : newClose,
      })),
    };
    const r1 = await getOrLoadMCPToolsCached(config, "session-1", deps);
    expect(r1.tools).toHaveProperty("old");
    await getOrLoadMCPToolsCached(config, "session-2", deps);
    expect(deps.loadMCPTools).toHaveBeenCalledTimes(1);

    command = "new";
    const r2 = await getOrLoadMCPToolsCached(config, "session-1", deps);
    expect(r2.tools).toHaveProperty("new");
    expect(oldClose).toHaveBeenCalledTimes(1);
    await closeMcpServersForSession("session-2");
    expect(newClose).not.toHaveBeenCalled();
    await closeMcpServersForSession("session-1");
    expect(newClose).toHaveBeenCalledTimes(1);
  });

  test("adding and removing a server preserves unchanged connections", async () => {
    let servers = [stdioServer("first", "first")];
    const closes = new Map<string, ReturnType<typeof mock>>();
    const loadMCPTools = mock(async ([server]: MCPServerConfig[]) => {
      const close = mock(async () => {});
      closes.set(server!.name, close);
      return { tools: { [`mcp__${server!.name}__run`]: {} }, errors: [], close };
    });
    const cache = new WorkspaceMcpToolCache({ loadMCPServers: async () => servers, loadMCPTools });
    await cache.load(config, "session-1");
    await cache.load(config, "session-2");
    servers = [...servers, stdioServer("second", "second")];
    const added = await cache.load(config, "session-1");
    expect(Object.keys(added.tools)).toEqual(["mcp__first__run", "mcp__second__run"]);
    expect(loadMCPTools).toHaveBeenCalledTimes(2);
    expect(closes.get("first")).not.toHaveBeenCalled();
    servers = servers.slice(1);
    const removed = await cache.load(config, "session-2");
    expect(Object.keys(removed.tools)).toEqual(["mcp__second__run"]);
    expect(loadMCPTools).toHaveBeenCalledTimes(2);
    expect(closes.get("first")).toHaveBeenCalledTimes(1);
    await cache.closeSession("session-1");
    expect(closes.get("second")).not.toHaveBeenCalled();
    await cache.closeSession("session-2");
    expect(closes.get("second")).toHaveBeenCalledTimes(1);
  });

  test("a hot swap drains an active call before closing its connection", async () => {
    let command = "old";
    const oldClose = mock(async () => {});
    const newClose = mock(async () => {});
    const cache = new WorkspaceMcpToolCache({
      loadMCPServers: async () => [stdioServer("shared", command)],
      loadMCPTools: async () => ({
        tools: { generation: command },
        errors: [],
        close: command === "old" ? oldClose : newClose,
      }),
    });
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const calling = cache.withTools(config, "session-1", async (tools) => {
      started.resolve();
      await gate.promise;
      expect(oldClose).not.toHaveBeenCalled();
      return tools.generation;
    });
    await started.promise;
    command = "new";
    expect(await cache.withTools(config, "session-2", async (tools) => tools.generation)).toBe(
      "new",
    );
    expect(oldClose).not.toHaveBeenCalled();
    await cache.closeSession("session-1");
    gate.resolve();
    expect(await calling).toBe("old");
    expect(oldClose).toHaveBeenCalledTimes(1);
    await cache.closeSession("session-2");
    expect(newClose).toHaveBeenCalledTimes(1);
  });

  test("a session joining during teardown gets a live replacement", async () => {
    const closeGate = Promise.withResolvers<void>();
    const closingStarted = Promise.withResolvers<void>();
    let loads = 0;
    const deps = {
      loadMCPServers: async () => [stdioServer("shared")],
      loadMCPTools: async () => {
        const generation = ++loads;
        return {
          tools: { [generation]: {} },
          errors: [],
          close: async () => {
            if (generation === 1) {
              closingStarted.resolve();
              await closeGate.promise;
            }
          },
        };
      },
    };
    await getOrLoadMCPToolsCached(config, "session-1", deps);
    const closing = closeMcpServersForSession("session-1");
    await closingStarted.promise;
    const joining = getOrLoadMCPToolsCached(config, "session-2", deps);
    closeGate.resolve();
    const [, result] = await Promise.all([closing, joining]);
    expect(loads).toBe(2);
    expect(result.tools).toEqual({ 2: {} });
    expect(__internal.workspaceMcpCache.get(workspaceA)?.sessionIds.has("session-2")).toBe(true);
    await closeMcpServersForSession("session-2");
  });

  test("a completed call returns while another session is still connecting a new server", async () => {
    let command = "old";
    const connect = Promise.withResolvers<void>();
    const connecting = Promise.withResolvers<void>();
    const finishCall = Promise.withResolvers<void>();
    const calling = Promise.withResolvers<void>();
    const cache = new WorkspaceMcpToolCache({
      loadMCPServers: async () => [stdioServer("shared", command)],
      loadMCPTools: async () => {
        if (command === "new") {
          connecting.resolve();
          await connect.promise;
        }
        return { tools: {}, errors: [], close: async () => {} };
      },
    });
    const call = cache.withTools(config, "session-1", async () => {
      calling.resolve();
      await finishCall.promise;
      return "complete";
    });
    await calling.promise;
    command = "new";
    const refresh = cache.load(config, "session-2");
    await connecting.promise;
    finishCall.resolve();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(
        await Promise.race([
          call,
          new Promise<string>((resolve) => {
            timeout = setTimeout(() => resolve("blocked"), 100);
          }),
        ]),
      ).toBe("complete");
    } finally {
      clearTimeout(timeout);
      connect.resolve();
      await Promise.all([call, refresh]);
      await cache.closeSession("session-1");
      await cache.closeSession("session-2");
    }
  });

  test("a failed replacement does not tear down the working cached client", async () => {
    let command = "working";
    const close = mock(async () => {});
    const deps = {
      loadMCPServers: async () => [stdioServer("shared", command)],
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

  test("returns cached tools and load errors on cache hit across sessions", async () => {
    const loadMCPServers = mock(async () => [stdioServer("broken-server", "node")]);
    const loadMCPTools = mock(async () => ({
      tools: { "mcp__broken-server__tool": {} },
      errors: ["[MCP] Failed to connect to broken-server after 4 attempts: boom"],
      close: mock(async () => {}),
    }));

    const first = await getOrLoadMCPToolsCached(config, "session-1", {
      loadMCPServers,
      loadMCPTools,
    });
    expect(first.errors).toHaveLength(1);
    expect(first.tools).toHaveProperty("mcp__broken-server__tool");

    const second = await getOrLoadMCPToolsCached(config, "session-1", {
      loadMCPServers,
      loadMCPTools,
    });
    const third = await getOrLoadMCPToolsCached(config, "session-2", {
      loadMCPServers,
      loadMCPTools,
    });
    expect(loadMCPServers).toHaveBeenCalledTimes(3);
    expect(loadMCPTools).toHaveBeenCalledTimes(1);
    expect(second.tools).toHaveProperty("mcp__broken-server__tool");
    expect(third.errors).toEqual(first.errors);
  });

  test("remaps colliding tool names across servers and keeps both connections", async () => {
    const servers = ["alpha", "beta", "gamma"].map((n) => stdioServer(n, n));
    const logs: string[] = [];
    const cache = new WorkspaceMcpToolCache({
      loadMCPServers: async () => servers,
      loadMCPTools: mock(async ([server]: MCPServerConfig[]) => ({
        tools: { mcp__shared__run: { server: server!.name } },
        errors: [],
        close: mock(async () => {}),
      })),
    });
    const result = await cache.load(config, "session-1", { log: (line) => logs.push(line) });
    expect(result.tools).toEqual({
      mcp__shared__run: { server: "alpha" },
      mcp__shared__run_2: { server: "beta" },
      mcp__shared__run_3: { server: "gamma" },
    });
    expect(logs).toEqual(
      expect.arrayContaining([
        '[MCP warn] Tool name collision: "mcp__shared__run" remapped to "mcp__shared__run_2"',
        '[MCP warn] Tool name collision: "mcp__shared__run" remapped to "mcp__shared__run_3"',
      ]),
    );
    await cache.closeSession("session-1");
  });

  test("a failed multi-server refresh closes only connections created in that attempt", async () => {
    let servers = [stdioServer("stable", "stable")];
    const stableClose = mock(async () => {});
    const createdClose = mock(async () => {});
    const cache = new WorkspaceMcpToolCache({
      loadMCPServers: async () => servers,
      loadMCPTools: async ([server]) => {
        if (server!.name === "broken") throw new Error("connect failed");
        return {
          tools: { [`mcp__${server!.name}__run`]: {} },
          errors: [],
          close: server!.name === "fresh" ? createdClose : stableClose,
        };
      },
    });
    await cache.load(config, "session-1");
    servers = [stdioServer("fresh", "fresh"), stdioServer("broken", "broken")];
    await expect(cache.load(config, "session-1")).rejects.toThrow("connect failed");
    expect(createdClose).toHaveBeenCalledTimes(1);
    expect(stableClose).not.toHaveBeenCalled();
    await cache.closeSession("session-1");
    expect(stableClose).toHaveBeenCalledTimes(1);
  });

  test("completes session close and logs when a cached close throws", async () => {
    await getOrLoadMCPToolsCached(config, "session-1", {
      loadMCPServers: async () => [stdioServer("test-server", "node")],
      loadMCPTools: async () => ({
        tools: { "mcp__test-server__tool": {} },
        errors: [],
        close: async () => {
          throw new Error("close exploded");
        },
      }),
    });

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
