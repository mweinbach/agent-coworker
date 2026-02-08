import fs from "node:fs/promises";
import path from "node:path";

import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";

import type { AgentConfig, MCPServerConfig } from "../types";

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
): Promise<{ tools: Record<string, any>; errors: string[]; close: () => Promise<void> }> {
  const tools: Record<string, any> = {};
  const errors: string[] = [];
  const clients: Array<{ name: string; close: () => Promise<void> }> = [];

  const close = async () => {
    // Close in reverse order (last opened, first closed), in case transports depend on ordering.
    for (const c of clients.reverse()) {
      try {
        await c.close();
      } catch {
        // ignore
      }
    }
  };

  for (const server of servers) {
    const retries = server.retries ?? 3;

    for (let attempt = 0; attempt <= retries; attempt++) {
      let client: any | null = null;
      try {
        const transport =
          server.transport.type === "stdio"
            ? new Experimental_StdioMCPTransport({
                command: server.transport.command,
                args: server.transport.args || [],
                env: server.transport.env,
                cwd: server.transport.cwd,
              })
            : (server.transport as any);

        client = await createMCPClient({
          name: server.name,
          transport,
        });

        const discovered = await client.tools();

        for (const [name, t] of Object.entries(discovered)) {
          tools[`mcp__${server.name}__${name}`] = t;
        }

        clients.push({ name: server.name, close: client.close.bind(client) });

        opts.log?.(
          `[MCP] Connected to ${server.name}: ${Object.keys(discovered).length} tools`
        );
        break;
      } catch (err) {
        // If we created a client for this attempt, close it; otherwise we'd leak
        // transports (especially stdio processes).
        try {
          await client?.close?.();
        } catch {
          // ignore
        }

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

  return { tools, errors, close };
}
