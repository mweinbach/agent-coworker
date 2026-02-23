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
  const precedence: MCPServerSource[] = ["system", "user", "workspace"];
  const bySource = new Map(layers.map((layer) => [layer.source, layer]));
  const mergedByName = new Map<string, MCPRegistryServer>();

  for (const source of precedence) {
    const layer = bySource.get(source);
    if (!layer) continue;
    for (const server of layer.servers) {
      mergedByName.set(server.name, {
        ...server,
        source,
        inherited: source !== "workspace",
      });
    }
  }

  return [...mergedByName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    const parsedCode = errorWithCodeSchema.safeParse(error);
    const code = parsedCode.success ? parsedCode.data.code : undefined;
    if (code === "ENOENT") return false;
    throw error;
  }
}

export async function loadMCPConfigRegistry(config: AgentConfig): Promise<MCPConfigRegistrySnapshot> {
  const paths = resolveMcpConfigPaths(config);

  const layers = await Promise.all([
    readLayer({ source: "workspace", filePath: paths.workspaceConfigFile, editable: true, legacy: false }),
    readLayer({ source: "user", filePath: paths.userConfigFile, editable: false, legacy: false }),
    readLayer({ source: "system", filePath: paths.systemConfigFile, editable: false, legacy: false }),
  ]);
  const [workspaceLegacyExists, userLegacyExists] = await Promise.all([
    fileExists(paths.workspaceLegacyFile),
    fileExists(paths.userLegacyFile),
  ]);

  const warnings = layers
    .filter((layer) => Boolean(layer.file.parseError))
    .map((layer) => `[MCP] Ignoring malformed ${layer.source} config at ${layer.file.path}: ${layer.file.parseError}`);

  const files = [
    layers.find((layer) => layer.source === "workspace")?.file,
    layers.find((layer) => layer.source === "user")?.file,
    layers.find((layer) => layer.source === "system")?.file,
    {
      source: "workspace_legacy" as const,
      path: paths.workspaceLegacyFile,
      exists: workspaceLegacyExists,
      editable: false,
      legacy: true,
      serverCount: 0,
    },
    {
      source: "user_legacy" as const,
      path: paths.userLegacyFile,
      exists: userLegacyExists,
      editable: false,
      legacy: true,
      serverCount: 0,
    },
  ].filter((file): file is MCPRegistryFileState => Boolean(file));

  return {
    servers: mergeLayers(layers),
    files,
    legacy: {
      workspace: {
        path: paths.workspaceLegacyFile,
        exists: workspaceLegacyExists,
      },
      user: {
        path: paths.userLegacyFile,
        exists: userLegacyExists,
      },
    },
    warnings,
  };
}
