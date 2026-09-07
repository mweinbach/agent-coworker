import path from "node:path";
import type { AgentConfig, MCPServerConfig } from "../types";
import type { loadMCPServers, loadMCPTools } from "./index";

type ToolLoadResult = Awaited<ReturnType<typeof loadMCPTools>>;
type CacheDependencies = {
  loadMCPServers: typeof loadMCPServers;
  loadMCPTools: typeof loadMCPTools;
};

export type WorkspaceMcpLoadOptions = Partial<CacheDependencies> & {
  log?: (line: string) => void;
};

type CachedConnection = ToolLoadResult & {
  configJson: string;
  retryAt: number;
  references: number;
};

interface CachedWorkspaceMcp {
  tools: Record<string, unknown>;
  errors: string[];
  serversConfigJson: string;
  connections: CachedConnection[];
  sessionIds: Set<string>;
  activeCalls: number;
  retired: boolean;
  retryAt: number;
}

const FAILURE_RETRY_DELAY_MS = 30_000;

function serializeServerConfigs(servers: MCPServerConfig[]): string {
  return JSON.stringify(servers, (_key, value) =>
    typeof value === "function" ? undefined : value,
  );
}

/** Connections belong to the workspace catalog; only active calls pin old generations. */
export class WorkspaceMcpToolCache {
  readonly entries = new Map<string, CachedWorkspaceMcp>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: CacheDependencies,
    private readonly now: () => number = Date.now,
  ) {}

  hasResources(): boolean {
    return (
      this.pending.size > 0 ||
      [...this.entries.values()].some((entry) => entry.connections.length > 0)
    );
  }

  /** Metadata snapshot for warmup. Execution must use withTools to lease the connection. */
  async load(
    config: AgentConfig,
    sessionId: string,
    opts: WorkspaceMcpLoadOptions = {},
  ): Promise<Pick<ToolLoadResult, "tools" | "errors">> {
    const workspaceKey = path.resolve(config.projectCoworkDir);
    return await this.serialize(workspaceKey, async () => {
      const entry = await this.refresh(workspaceKey, config, sessionId, opts);
      return { tools: entry.tools, errors: entry.errors };
    });
  }

  async withTools<T>(
    config: AgentConfig,
    sessionId: string,
    operation: (tools: Record<string, unknown>, errors: string[]) => Promise<T>,
    opts: WorkspaceMcpLoadOptions = {},
  ): Promise<T> {
    const workspaceKey = path.resolve(config.projectCoworkDir);
    const entry = await this.serialize(workspaceKey, async () => {
      const current = await this.refresh(workspaceKey, config, sessionId, opts);
      current.activeCalls += 1;
      return current;
    });
    try {
      // Calls do not hold the refresh lock: a slow tool cannot block hot swapping.
      return await operation(entry.tools, entry.errors);
    } finally {
      // Reference updates are synchronous and generation-owned. Do not queue
      // completed calls behind another session's potentially slow discovery.
      entry.activeCalls -= 1;
      if (entry.retired && entry.activeCalls === 0) {
        await this.releaseConnections(workspaceKey, entry.connections, opts.log);
      }
    }
  }

  private async refresh(
    workspaceKey: string,
    config: AgentConfig,
    sessionId: string,
    opts: WorkspaceMcpLoadOptions,
  ): Promise<CachedWorkspaceMcp> {
    const servers = await (opts.loadMCPServers ?? this.deps.loadMCPServers)(config, {
      log: opts.log,
    });
    const serversConfigJson = serializeServerConfigs(servers);
    const cached = this.entries.get(workspaceKey);
    if (cached?.serversConfigJson === serversConfigJson && this.now() < cached.retryAt) {
      cached.sessionIds.add(sessionId);
      return cached;
    }

    const reusable = new Map(cached?.connections.map((entry) => [entry.configJson, entry]));
    const created: CachedConnection[] = [];
    // Independently load changed servers, retaining healthy unchanged connections.
    const results = await Promise.allSettled(
      servers.map(async (server) => {
        const configJson = serializeServerConfigs([server]);
        const existing = reusable.get(configJson);
        if (existing && this.now() < existing.retryAt) return existing;
        const loaded = await (opts.loadMCPTools ?? this.deps.loadMCPTools)([server], {
          log: opts.log,
        });
        const connection: CachedConnection = {
          ...loaded,
          configJson,
          retryAt:
            loaded.errors.length > 0
              ? this.now() + FAILURE_RETRY_DELAY_MS
              : Number.POSITIVE_INFINITY,
          references: 0,
        };
        created.push(connection);
        return connection;
      }),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      await this.closeConnections(workspaceKey, created, opts.log);
      throw failure.reason;
    }
    const connections = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const tools: Record<string, unknown> = {};
    for (const connection of connections) {
      connection.references += 1;
      for (const [name, tool] of Object.entries(connection.tools)) {
        let key = name;
        let suffix = 2;
        while (Object.hasOwn(tools, key)) key = `${name}_${suffix++}`;
        if (key !== name)
          opts.log?.(`[MCP warn] Tool name collision: "${name}" remapped to "${key}"`);
        tools[key] = tool;
      }
    }
    const next: CachedWorkspaceMcp = {
      tools,
      errors: connections.flatMap((entry) => entry.errors),
      serversConfigJson,
      connections,
      sessionIds: new Set([...(cached?.sessionIds ?? []), sessionId]),
      activeCalls: 0,
      retired: false,
      retryAt: Math.min(Number.POSITIVE_INFINITY, ...connections.map((entry) => entry.retryAt)),
    };
    this.entries.set(workspaceKey, next);
    if (cached) await this.retire(workspaceKey, cached, opts.log);
    return next;
  }

  async closeSession(sessionId: string, log?: (line: string) => void): Promise<void> {
    // Include pending loads so closing during discovery releases the eventual connection.
    const workspaceKeys = new Set([...this.entries.keys(), ...this.pending.keys()]);
    await Promise.all(
      [...workspaceKeys].map(async (workspaceKey) => {
        await this.serialize(workspaceKey, async () => {
          const cached = this.entries.get(workspaceKey);
          if (cached?.sessionIds.delete(sessionId) && cached.sessionIds.size === 0) {
            this.entries.delete(workspaceKey);
            await this.retire(workspaceKey, cached, log);
          }
        });
      }),
    );
  }

  private async retire(
    workspaceKey: string,
    entry: CachedWorkspaceMcp,
    log?: (line: string) => void,
  ) {
    entry.retired = true;
    if (entry.activeCalls === 0)
      await this.releaseConnections(workspaceKey, entry.connections, log);
  }

  private async releaseConnections(
    workspaceKey: string,
    connections: CachedConnection[],
    log?: (line: string) => void,
  ) {
    const unused = connections.filter((entry) => --entry.references === 0);
    await this.closeConnections(workspaceKey, unused, log);
  }

  private async closeConnections(
    workspaceKey: string,
    connections: CachedConnection[],
    log: (line: string) => void = console.warn,
  ): Promise<void> {
    await Promise.all(
      connections.map(async (entry) => {
        try {
          await entry.close();
        } catch (error) {
          log(`[MCP] Error closing MCP servers for workspace ${workspaceKey}: ${String(error)}`);
        }
      }),
    );
  }

  private async serialize<T>(workspaceKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(workspaceKey) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    // Keep the per-workspace chain usable after either outcome without swallowing `run` for its caller.
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.pending.set(workspaceKey, settled);
    try {
      return await run;
    } finally {
      if (this.pending.get(workspaceKey) === settled) this.pending.delete(workspaceKey);
    }
  }
}
