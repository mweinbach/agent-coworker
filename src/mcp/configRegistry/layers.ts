import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { AgentConfig, MCPServerConfig } from "../../types";
import {
  buildPluginCatalogSnapshot,
  comparePluginCatalogEntries,
  readPluginMcpServers,
} from "../../plugins";
import { isPathInside } from "../../utils/paths";
import { resolveMcpConfigPaths } from "../configPaths";
import { parseMCPServersDocument } from "./parser";
import type {
  MCPConfigRegistrySnapshot,
  MCPRegistryFileState,
  MCPRegistryServer,
  MCPServerSource,
} from "./types";

type MCPConfigLayer = {
  source: MCPServerSource;
  file: MCPRegistryFileState;
  servers: MCPServerConfig[];
};

const errorWithCodeSchema = z.object({ code: z.string() }).passthrough();

async function readLayer(opts: {
  source: MCPServerSource;
  filePath: string;
  editable: boolean;
  legacy: boolean;
}): Promise<MCPConfigLayer> {
  let exists = false;
  let rawJson = "";
  let parseError: string | undefined;
  try {
    rawJson = await fs.readFile(opts.filePath, "utf-8");
    exists = true;
  } catch (error) {
    const parsedCode = errorWithCodeSchema.safeParse(error);
    if (!parsedCode.success || parsedCode.data.code !== "ENOENT") {
      throw error;
    }
  }

  let servers: MCPServerConfig[] = [];
  if (exists) {
    try {
      servers = parseMCPServersDocument(rawJson).servers;
    } catch (error) {
      parseError = String(error);
    }
  }

  return {
    source: opts.source,
    file: {
      source: opts.source,
      path: opts.filePath,
      exists,
      editable: opts.editable,
      legacy: opts.legacy,
      ...(parseError ? { parseError } : {}),
      serverCount: servers.length,
    },
    servers,
  };
}

function mergeLayers(layers: MCPConfigLayer[]): MCPRegistryServer[] {
  const precedence: MCPServerSource[] = ["system", "user_legacy", "user", "workspace_legacy", "workspace"];
  const bySource = new Map(layers.map((layer) => [layer.source, layer]));
  const mergedByName = new Map<string, MCPRegistryServer>();

  for (const source of precedence) {
    const layer = bySource.get(source);
    if (!layer) continue;
    for (const server of layer.servers) {
      mergedByName.set(server.name, {
        ...server,
        source,
        inherited: source !== "workspace" && source !== "workspace_legacy",
      });
    }
  }

  return [...mergedByName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function isRelativeFilesystemPath(value: string): boolean {
  return !path.isAbsolute(value) && (value.startsWith(".") || value.includes("/") || value.includes("\\"));
}

function resolvePluginLocalPath(serverName: string, pluginRootDir: string, value: string, label: string): string {
  const resolved = path.resolve(pluginRootDir, value);
  if (!isPathInside(pluginRootDir, resolved)) {
    throw new Error(`Plugin MCP server "${serverName}" resolves ${label} outside the plugin root.`);
  }
  return resolved;
}

function rebasePluginLocalTransport(server: MCPServerConfig, pluginRootDir: string): MCPServerConfig {
  if (server.transport.type !== "stdio") {
    return server;
  }

  const command = isRelativeFilesystemPath(server.transport.command)
    ? resolvePluginLocalPath(server.name, pluginRootDir, server.transport.command, "command")
    : server.transport.command;
  const args = server.transport.args?.map((arg) =>
    isRelativeFilesystemPath(arg)
      ? resolvePluginLocalPath(server.name, pluginRootDir, arg, `argument "${arg}"`)
      : arg);
  const cwd = server.transport.cwd
    ? (
        path.isAbsolute(server.transport.cwd)
          ? server.transport.cwd
          : resolvePluginLocalPath(server.name, pluginRootDir, server.transport.cwd, "cwd")
      )
    : undefined;

  return {
    ...server,
    transport: {
      type: "stdio",
      command,
      ...(args ? { args } : {}),
      ...(server.transport.env ? { env: server.transport.env } : {}),
      ...(cwd ? { cwd } : {}),
    },
  };
}

async function readPluginLayers(config: AgentConfig): Promise<{ layers: MCPConfigLayer[]; warnings: string[] }> {
  const catalog = await buildPluginCatalogSnapshot(config);
  const layers: MCPConfigLayer[] = [];
  const warnings = [...catalog.warnings];

  for (const plugin of [...catalog.plugins].sort(comparePluginCatalogEntries)) {
    if (!plugin.mcpPath) continue;
    if (!plugin.enabled) continue;
    const filePath = path.resolve(plugin.mcpPath);
    let servers: MCPServerConfig[] = [];
    let parseError: string | undefined;
    try {
      servers = (await readPluginMcpServers(plugin.mcpPath))
        .map((server) => rebasePluginLocalTransport(server, plugin.rootDir));
    } catch (error) {
      parseError = String(error);
      warnings.push(`[MCP] Ignoring malformed plugin MCP config at ${filePath}: ${parseError}`);
    }

    layers.push({
      source: "plugin",
      file: {
        source: "plugin",
        path: filePath,
        exists: true,
        editable: false,
        legacy: false,
        ...(parseError ? { parseError } : {}),
        serverCount: servers.length,
        pluginId: plugin.id,
        pluginName: plugin.name,
        pluginDisplayName: plugin.displayName,
        pluginScope: plugin.scope,
      },
      servers,
    });
  }

  return { layers, warnings };
}

function mergePluginLayers(baseServers: MCPRegistryServer[], pluginLayers: MCPConfigLayer[]): {
  servers: MCPRegistryServer[];
  warnings: string[];
} {
  const mergedByName = new Map(baseServers.map((server) => [server.name, server]));
  const warnings: string[] = [];

  for (const layer of pluginLayers) {
    for (const server of layer.servers) {
      if (mergedByName.has(server.name)) {
        warnings.push(
          `[MCP] Ignoring plugin server "${server.name}" from ${layer.file.path} because a configured server with the same name already exists.`,
        );
        continue;
      }
      mergedByName.set(server.name, {
        ...server,
        source: "plugin",
        inherited: layer.file.pluginScope !== "workspace",
        pluginId: layer.file.pluginId,
        pluginName: layer.file.pluginName,
        pluginDisplayName: layer.file.pluginDisplayName,
        pluginScope: layer.file.pluginScope,
      });
    }
  }

  return {
    servers: [...mergedByName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    warnings,
  };
}

export async function loadMCPConfigRegistry(config: AgentConfig): Promise<MCPConfigRegistrySnapshot> {
  const paths = resolveMcpConfigPaths(config);

  const [layers, pluginData] = await Promise.all([
    Promise.all([
      readLayer({ source: "workspace", filePath: paths.workspaceConfigFile, editable: true, legacy: false }),
      readLayer({ source: "user", filePath: paths.userConfigFile, editable: false, legacy: false }),
      readLayer({ source: "system", filePath: paths.systemConfigFile, editable: false, legacy: false }),
      readLayer({ source: "workspace_legacy", filePath: paths.workspaceLegacyFile, editable: false, legacy: true }),
      readLayer({ source: "user_legacy", filePath: paths.userLegacyFile, editable: false, legacy: true }),
    ]),
    readPluginLayers(config),
  ]);

  const warnings = layers
    .filter((layer) => Boolean(layer.file.parseError))
    .map((layer) => `[MCP] Ignoring malformed ${layer.source} config at ${layer.file.path}: ${layer.file.parseError}`);
  warnings.push(...pluginData.warnings);

  const merged = mergePluginLayers(mergeLayers(layers), pluginData.layers);
  warnings.push(...merged.warnings);

  const fileForSource = (source: MCPServerSource) => layers.find((layer) => layer.source === source)!.file;

  return {
    servers: merged.servers,
    files: [
      fileForSource("workspace"),
      fileForSource("user"),
      fileForSource("system"),
      fileForSource("workspace_legacy"),
      fileForSource("user_legacy"),
      ...pluginData.layers.map((layer) => layer.file),
    ],
    legacy: {
      workspace: {
        path: paths.workspaceLegacyFile,
        exists: fileForSource("workspace_legacy").exists,
      },
      user: {
        path: paths.userLegacyFile,
        exists: fileForSource("user_legacy").exists,
      },
    },
    warnings,
  };
}
