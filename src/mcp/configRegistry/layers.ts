import fs from "node:fs/promises";

import { z } from "zod";

import type { AgentConfig, MCPServerConfig } from "../../types";
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

export async function loadMCPConfigRegistry(config: AgentConfig): Promise<MCPConfigRegistrySnapshot> {
  const paths = resolveMcpConfigPaths(config);

  const layers = await Promise.all([
    readLayer({ source: "workspace", filePath: paths.workspaceConfigFile, editable: true, legacy: false }),
    readLayer({ source: "user", filePath: paths.userConfigFile, editable: false, legacy: false }),
    readLayer({ source: "system", filePath: paths.systemConfigFile, editable: false, legacy: false }),
    readLayer({ source: "workspace_legacy", filePath: paths.workspaceLegacyFile, editable: false, legacy: true }),
    readLayer({ source: "user_legacy", filePath: paths.userLegacyFile, editable: false, legacy: true }),
  ]);

  const warnings = layers
    .filter((layer) => Boolean(layer.file.parseError))
    .map((layer) => `[MCP] Ignoring malformed ${layer.source} config at ${layer.file.path}: ${layer.file.parseError}`);

  const fileForSource = (source: MCPServerSource) => layers.find((layer) => layer.source === source)!.file;

  return {
    servers: mergeLayers(layers),
    files: [
      fileForSource("workspace"),
      fileForSource("user"),
      fileForSource("system"),
      fileForSource("workspace_legacy"),
      fileForSource("user_legacy"),
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
