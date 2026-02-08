import fs from "node:fs/promises";
import path from "node:path";

import { createMCPClient } from "@ai-sdk/mcp";

import type { AgentConfig, MCPServerConfig } from "../types";

const activeClients: Map<string, { close: () => Promise<void> }> = new Map();

export async function loadMCPServers(config: AgentConfig): Promise<MCPServerConfig[]> {
  const serversByName = new Map<string, MCPServerConfig>();

  // Load in low->high priority order so higher priority overwrites.
  for (const dir of [...config.configDirs].reverse()) {
    const p = path.join(dir, "mcp-servers.json");
    try {
      const raw = await fs.readFile(p, "utf-8");
      const parsed = JSON.parse(raw) as { servers?: MCPServerConfig[] };
      for (const server of parsed.servers || []) {
        if (server?.name) serversByName.set(server.name, server);
      }
    } catch {
      // ignore missing/invalid files
    }
  }

  return Array.from(serversByName.values());
}

export async function loadMCPTools(
  servers: MCPServerConfig[],
  opts: { log?: (line: string) => void } = {}
): Promise<{ tools: Record<string, any>; errors: string[] }> {
  const tools: Record<string, any> = {};
  const errors: string[] = [];

  for (const server of servers) {
    const retries = server.retries ?? 3;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const client = await createMCPClient({
          name: server.name,
          transport: server.transport as any,
        });

        activeClients.set(server.name, client as any);

        const discovered = await client.tools();

        for (const [name, t] of Object.entries(discovered)) {
          tools[`mcp__${server.name}__${name}`] = t;
        }

        opts.log?.(
          `[MCP] Connected to ${server.name}: ${Object.keys(discovered).length} tools`
        );
        break;
      } catch (err) {
        if (attempt === retries) {
          const msg = `[MCP] Failed to connect to ${server.name} after ${attempt + 1} attempts: ${String(
            err
          )}`;
          if (server.required) throw new Error(msg);
          errors.push(msg);
          opts.log?.(msg);
        } else {
          opts.log?.(`[MCP] Retrying ${server.name} (attempt ${attempt + 2})...`);
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }
  }

  return { tools, errors };
}

export async function closeMCPClients(): Promise<void> {
  for (const [name, client] of activeClients) {
    try {
      await client.close();
    } catch {
      // ignore
    }
    activeClients.delete(name);
  }
}
