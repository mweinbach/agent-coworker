import fs from "node:fs/promises";
import path from "node:path";

import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";

import type { AgentConfig, MCPServerConfig } from "../types";

const PROJECT_MCP_FILE_NAME = "mcp-servers.json";
const DEFAULT_MCP_SERVERS = { servers: [] } as const;

export const DEFAULT_MCP_SERVERS_DOCUMENT = `${JSON.stringify(DEFAULT_MCP_SERVERS, null, 2)}\n`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseStringMap(value: unknown, fieldName: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`mcp-servers.json: ${fieldName} must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") {
      throw new Error(`mcp-servers.json: ${fieldName}.${k} must be a string`);
    }
    out[k] = v;
  }
  return out;
}

function parseTransport(
  value: unknown,
  index: number
): MCPServerConfig["transport"] {
  if (!isRecord(value)) {
    throw new Error(`mcp-servers.json: servers[${index}].transport must be an object`);
  }
  const type = asNonEmptyString(value.type);
  if (!type) {
    throw new Error(`mcp-servers.json: servers[${index}].transport.type is required`);
  }
  if (type === "stdio") {
    const command = asNonEmptyString(value.command);
    if (!command) {
      throw new Error(`mcp-servers.json: servers[${index}].transport.command is required for stdio`);
    }
    const argsRaw = value.args;
    if (argsRaw !== undefined && (!Array.isArray(argsRaw) || !argsRaw.every((arg) => typeof arg === "string"))) {
      throw new Error(`mcp-servers.json: servers[${index}].transport.args must be a string[]`);
    }
    const env = parseStringMap(value.env, `servers[${index}].transport.env`);
    const cwd = asNonEmptyString(value.cwd) ?? undefined;
    return {
      type: "stdio",
      command,
      ...(argsRaw !== undefined ? { args: argsRaw } : {}),
      ...(env ? { env } : {}),
      ...(cwd ? { cwd } : {}),
    };
  }
  if (type === "http" || type === "sse") {
    const url = asNonEmptyString(value.url);
    if (!url) {
      throw new Error(`mcp-servers.json: servers[${index}].transport.url is required for ${type}`);
    }
    const headers = parseStringMap(value.headers, `servers[${index}].transport.headers`);
    return {
      type,
      url,
      ...(headers ? { headers } : {}),
    };
  }
  throw new Error(`mcp-servers.json: servers[${index}].transport.type "${type}" is not supported`);
}

export function parseMCPServersDocument(rawJson: string): { servers: MCPServerConfig[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new Error(`mcp-servers.json: invalid JSON: ${String(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error("mcp-servers.json: root must be an object");
  }

  const serversRaw = parsed.servers;
  if (serversRaw === undefined) {
    return { servers: [] };
  }
  if (!Array.isArray(serversRaw)) {
    throw new Error("mcp-servers.json: servers must be an array");
  }

  const servers: MCPServerConfig[] = [];
  for (let i = 0; i < serversRaw.length; i++) {
    const item = serversRaw[i];
    if (!isRecord(item)) {
      throw new Error(`mcp-servers.json: servers[${i}] must be an object`);
    }
    const name = asNonEmptyString(item.name);
    if (!name) {
      throw new Error(`mcp-servers.json: servers[${i}].name is required`);
    }
    const transport = parseTransport(item.transport, i);
    if (item.required !== undefined && typeof item.required !== "boolean") {
      throw new Error(`mcp-servers.json: servers[${i}].required must be a boolean`);
    }
    if (
      item.retries !== undefined &&
      (typeof item.retries !== "number" || !Number.isFinite(item.retries))
    ) {
      throw new Error(`mcp-servers.json: servers[${i}].retries must be a number`);
    }
    servers.push({
      name,
      transport,
      ...(item.required !== undefined ? { required: item.required } : {}),
      ...(item.retries !== undefined ? { retries: item.retries } : {}),
    });
  }
  return { servers };
}

export async function readProjectMCPServersDocument(config: AgentConfig): Promise<{
  path: string;
  rawJson: string;
  projectServers: MCPServerConfig[];
  effectiveServers: MCPServerConfig[];
  parseError?: string;
}> {
  const filePath = path.join(config.projectAgentDir, PROJECT_MCP_FILE_NAME);
  let rawJson = DEFAULT_MCP_SERVERS_DOCUMENT;
  try {
    rawJson = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  let projectServers: MCPServerConfig[] = [];
  let parseError: string | undefined;
  try {
    projectServers = parseMCPServersDocument(rawJson).servers;
  } catch (error) {
    parseError = String(error);
  }

  const effectiveServers = await loadMCPServers(config);
  return {
    path: filePath,
    rawJson,
    projectServers,
    effectiveServers,
    ...(parseError ? { parseError } : {}),
  };
}

export async function writeProjectMCPServersDocument(projectAgentDir: string, rawJson: string): Promise<void> {
  parseMCPServersDocument(rawJson);
  await fs.mkdir(projectAgentDir, { recursive: true });
  const filePath = path.join(projectAgentDir, PROJECT_MCP_FILE_NAME);
  const payload = rawJson.endsWith("\n") ? rawJson : `${rawJson}\n`;
  const tempPath = path.join(
    projectAgentDir,
    `.mcp-servers.json.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  await fs.writeFile(tempPath, payload, "utf-8");
  await fs.rename(tempPath, filePath);
}

export async function loadMCPServers(config: AgentConfig): Promise<MCPServerConfig[]> {
  const serversByName = new Map<string, MCPServerConfig>();

  // Load in low->high priority order so higher priority overwrites.
  for (const dir of [...config.configDirs].reverse()) {
    const p = path.join(dir, PROJECT_MCP_FILE_NAME);
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
  opts: {
    log?: (line: string) => void;
    createClient?: typeof createMCPClient;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<{ tools: Record<string, any>; errors: string[]; close: () => Promise<void> }> {
  const createClient = opts.createClient ?? createMCPClient;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const tools: Record<string, any> = {};
  const errors: string[] = [];
  const clients: Array<{ name: string; close: () => Promise<void> }> = [];
  let closed = false;

  const retriesFor = (v: unknown): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) return 3;
    return Math.max(0, Math.floor(v));
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    // Close in reverse order (last opened, first closed), in case transports depend on ordering.
    for (const c of [...clients].reverse()) {
      try {
        await c.close();
      } catch {
        // ignore
      }
    }
  };

  for (const server of servers) {
    const retries = retriesFor(server.retries);

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

        client = await createClient({
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
          if (server.required) {
            await close();
            throw new Error(msg);
          }
          errors.push(msg);
          opts.log?.(msg);
        } else {
          opts.log?.(`[MCP] Retrying ${server.name} (attempt ${attempt + 2})...`);
          await sleep(1000 * (attempt + 1));
        }
      }
    }
  }

  return { tools, errors, close };
}
