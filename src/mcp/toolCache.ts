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

interface CachedWorkspaceMcp extends ToolLoadResult {
  serversConfigJson: string;
  sessionIds: Set<string>;
  retryAt: number;
}

const FAILURE_RETRY_DELAY_MS = 30_000;

function serializeServerConfigs(servers: MCPServerConfig[]): string {
  return JSON.stringify(servers, (_key, value) =>
    typeof value === "function" ? undefined : value,
  );
}

/** Owns shared connections until every session using their tool definitions releases them. */
export class WorkspaceMcpToolCache {
  readonly entries = new Map<string, CachedWorkspaceMcp>();
  private readonly retired = new Map<string, Set<CachedWorkspaceMcp>>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: CacheDependencies,
    private readonly now: () => number = Date.now,
  ) {}

  async load(
    config: AgentConfig,
    sessionId: string,
    opts: WorkspaceMcpLoadOptions = {},
  ): Promise<Pick<ToolLoadResult, "tools" | "errors">> {
    const workspaceKey = path.resolve(config.projectCoworkDir);
    return await this.serialize(workspaceKey, async () => {
      const servers = await (opts.loadMCPServers ?? this.deps.loadMCPServers)(config, {
        log: opts.log,
      });
      const serversConfigJson = serializeServerConfigs(servers);
      const cached = this.entries.get(workspaceKey);
      if (cached?.serversConfigJson === serversConfigJson && this.now() < cached.retryAt) {
        cached.sessionIds.add(sessionId);
        await this.releaseRetiredSession(workspaceKey, sessionId, opts.log);
        return { tools: cached.tools, errors: cached.errors };
      }

      if (cached) {
        opts.log?.(
          cached.serversConfigJson === serversConfigJson
            ? `[MCP] Retrying failed MCP connections for workspace ${workspaceKey}.`
            : `[MCP] Server configuration changed for workspace ${workspaceKey}. Reloading...`,
        );
      }
      // Keep the working generation until its replacement has loaded successfully.
      const loaded: ToolLoadResult =
        servers.length > 0
          ? await (opts.loadMCPTools ?? this.deps.loadMCPTools)(servers, { log: opts.log })
          : { tools: {}, errors: [], close: async () => {} };
      const next: CachedWorkspaceMcp = {
        ...loaded,
        serversConfigJson,
        sessionIds: new Set([sessionId]),
        retryAt:
          loaded.errors.length > 0 ? this.now() + FAILURE_RETRY_DELAY_MS : Number.POSITIVE_INFINITY,
      };
      this.entries.set(workspaceKey, next);
      if (cached) {
        const retired = this.retired.get(workspaceKey) ?? new Set<CachedWorkspaceMcp>();
        retired.add(cached);
        this.retired.set(workspaceKey, retired);
      }
      await this.releaseRetiredSession(workspaceKey, sessionId, opts.log);
      return { tools: next.tools, errors: next.errors };
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    // Pending loads participate too: closing during discovery must release the
    // connection that the load eventually creates, not leave it ownerless.
    const workspaceKeys = new Set([
      ...this.entries.keys(),
      ...this.retired.keys(),
      ...this.pending.keys(),
    ]);
    await Promise.all(
      [...workspaceKeys].map(async (workspaceKey) => {
        await this.serialize(workspaceKey, async () => {
          const cached = this.entries.get(workspaceKey);
          if (cached?.sessionIds.delete(sessionId) && cached.sessionIds.size === 0) {
            this.entries.delete(workspaceKey);
            await this.closeEntry(workspaceKey, cached);
          }
          await this.releaseRetiredSession(workspaceKey, sessionId);
        });
      }),
    );
  }

  private async releaseRetiredSession(
    workspaceKey: string,
    sessionId: string,
    log?: (line: string) => void,
  ): Promise<void> {
    const retired = this.retired.get(workspaceKey);
    if (!retired) return;
    for (const entry of retired) {
      entry.sessionIds.delete(sessionId);
      if (entry.sessionIds.size === 0) {
        retired.delete(entry);
        await this.closeEntry(workspaceKey, entry, log);
      }
    }
    if (retired.size === 0) this.retired.delete(workspaceKey);
  }

  private async closeEntry(
    workspaceKey: string,
    entry: CachedWorkspaceMcp,
    log: (line: string) => void = console.warn,
  ): Promise<void> {
    try {
      await entry.close();
    } catch (error) {
      log(`[MCP] Error closing MCP servers for workspace ${workspaceKey}: ${String(error)}`);
    }
  }

  private async serialize<T>(workspaceKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(workspaceKey) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const settled = run.then(
      () => {},
      () => {},
    );
    this.pending.set(workspaceKey, settled);
    try {
      return await run;
    } finally {
      if (this.pending.get(workspaceKey) === settled) this.pending.delete(workspaceKey);
    }
  }
}
