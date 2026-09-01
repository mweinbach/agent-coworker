import fs from "node:fs/promises";

import { z } from "zod";

import type { AgentConfig, MCPServerConfig, PluginScope } from "../../types";
import { writeTextFileAtomic } from "../../utils/atomicFile";
import { fileLockRootForCoworkHome, withFileLock } from "../../utils/fileLock";
import { resolveMcpConfigPaths } from "../configPaths";
import {
  DEFAULT_MCP_SERVERS_DOCUMENT,
  parseMCPServerConfig,
  parseMCPServersDocument,
} from "./parser";

const errorWithCodeSchema = z.object({ code: z.string() }).passthrough();

export type MCPServerConfigSource = "workspace" | "user" | "plugin" | "system";
export type EditableMCPServerConfigSource = Extract<MCPServerConfigSource, "workspace" | "user">;

function sortServersByName(servers: MCPServerConfig[]): MCPServerConfig[] {
  return [...servers].sort((a, b) => a.name.localeCompare(b.name));
}

export async function readWorkspaceMCPServersDocument(config: AgentConfig): Promise<{
  path: string;
  rawJson: string;
  workspaceServers: MCPServerConfig[];
}> {
  const paths = resolveMcpConfigPaths(config);
  let rawJson = DEFAULT_MCP_SERVERS_DOCUMENT;
  try {
    rawJson = await fs.readFile(paths.workspaceConfigFile, "utf-8");
  } catch (error) {
    const parsedCode = errorWithCodeSchema.safeParse(error);
    if (!parsedCode.success || parsedCode.data.code !== "ENOENT") {
      throw error;
    }
  }
  const workspaceServers = parseMCPServersDocument(rawJson).servers;

  return {
    path: paths.workspaceConfigFile,
    rawJson,
    workspaceServers,
  };
}

async function readMCPServersDocumentFile(filePath: string): Promise<MCPServerConfig[]> {
  let rawJson = DEFAULT_MCP_SERVERS_DOCUMENT;
  try {
    rawJson = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    const parsedCode = errorWithCodeSchema.safeParse(error);
    if (!parsedCode.success || parsedCode.data.code !== "ENOENT") {
      throw error;
    }
  }
  return parseMCPServersDocument(rawJson).servers;
}

async function writeMCPServersDocumentFile(
  filePath: string,
  servers: MCPServerConfig[],
): Promise<void> {
  const payload = `${JSON.stringify({ servers: sortServersByName(servers) }, null, 2)}\n`;
  await writeTextFileAtomic(filePath, payload, { mode: 0o600 });
}

export async function writeWorkspaceMCPServersDocument(
  config: AgentConfig,
  rawJson: string,
): Promise<void> {
  parseMCPServersDocument(rawJson);
  const paths = resolveMcpConfigPaths(config);
  const payload = rawJson.endsWith("\n") ? rawJson : `${rawJson}\n`;
  await withFileLock(
    paths.workspaceConfigFile,
    async () => {
      await writeTextFileAtomic(paths.workspaceConfigFile, payload, { mode: 0o600 });
    },
    { lockRoot: fileLockRootForCoworkHome(config.userCoworkDir) },
  );
}

function editableConfigFile(config: AgentConfig, source: EditableMCPServerConfigSource): string {
  const paths = resolveMcpConfigPaths(config);
  return source === "workspace" ? paths.workspaceConfigFile : paths.userConfigFile;
}

export async function upsertWorkspaceMCPServer(
  config: AgentConfig,
  server: MCPServerConfig,
  previousName?: string,
): Promise<void> {
  await upsertMCPServer(config, "workspace", server, previousName);
}

export async function upsertMCPServer(
  config: AgentConfig,
  source: EditableMCPServerConfigSource,
  server: MCPServerConfig,
  previousName?: string,
): Promise<void> {
  const validated = parseMCPServerConfig(server);
  const filePath = editableConfigFile(config, source);
  await withFileLock(
    filePath,
    async () => {
      const servers = await readMCPServersDocumentFile(filePath);
      const trimmedPrevious = previousName?.trim();
      const isRename = trimmedPrevious && trimmedPrevious !== validated.name;
      if (isRename && servers.some((entry) => entry.name === validated.name)) {
        throw new Error(
          `mcp-servers.json: cannot rename "${trimmedPrevious}" to "${validated.name}" because "${validated.name}" already exists`,
        );
      }
      const nextServers = servers.filter(
        (entry) => entry.name !== (trimmedPrevious || validated.name),
      );
      nextServers.push(validated);
      await writeMCPServersDocumentFile(filePath, nextServers);

      if (isRename) {
        const { renameMCPServerCredentials } = await import("../authStore");
        await renameMCPServerCredentials({
          config,
          source,
          previousName: trimmedPrevious,
          nextName: validated.name,
        });
      }
    },
    { lockRoot: fileLockRootForCoworkHome(config.userCoworkDir) },
  );
}

export async function deleteWorkspaceMCPServer(
  config: AgentConfig,
  nameRaw: string,
): Promise<void> {
  await deleteMCPServer(config, "workspace", nameRaw);
}

export async function deleteMCPServer(
  config: AgentConfig,
  source: EditableMCPServerConfigSource,
  nameRaw: string,
): Promise<void> {
  const name = nameRaw.trim();
  if (!name) {
    throw new Error("mcp-servers.json: server name is required");
  }

  const filePath = editableConfigFile(config, source);
  await withFileLock(
    filePath,
    async () => {
      const servers = await readMCPServersDocumentFile(filePath);
      await writeMCPServersDocumentFile(
        filePath,
        servers.filter((entry) => entry.name !== name),
      );
    },
    { lockRoot: fileLockRootForCoworkHome(config.userCoworkDir) },
  );
}

export async function setMCPServerEnabled(opts: {
  config: AgentConfig;
  source: MCPServerConfigSource;
  name: string;
  enabled: boolean;
  pluginId?: string;
  pluginScope?: PluginScope;
}): Promise<void> {
  const name = opts.name.trim();
  if (!name) {
    throw new Error("mcp-servers.json: server name is required");
  }

  if (opts.source === "system") {
    throw new Error("mcp-servers.json: system MCP servers are read-only");
  }

  if (opts.source === "plugin") {
    if (!opts.pluginId?.trim() || !opts.pluginScope) {
      throw new Error("mcp-servers.json: plugin MCP server toggles require plugin metadata");
    }
    const { setPluginMcpServerEnabled } = await import("../../plugins/overrides");
    await setPluginMcpServerEnabled({
      config: opts.config,
      pluginId: opts.pluginId,
      scope: opts.pluginScope,
      serverName: name,
      enabled: opts.enabled,
    });
    return;
  }

  const filePath = editableConfigFile(opts.config, opts.source);
  await withFileLock(
    filePath,
    async () => {
      const servers = await readMCPServersDocumentFile(filePath);
      let found = false;
      const nextServers = servers.map((server) => {
        if (server.name !== name) return server;
        found = true;
        const next = { ...server };
        if (opts.enabled) {
          delete next.enabled;
        } else {
          next.enabled = false;
        }
        return next;
      });
      if (!found) {
        throw new Error(
          `mcp-servers.json: server "${name}" was not found in ${opts.source} config`,
        );
      }
      await writeMCPServersDocumentFile(filePath, nextServers);
    },
    { lockRoot: fileLockRootForCoworkHome(opts.config.userCoworkDir) },
  );
}
