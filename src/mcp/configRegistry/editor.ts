import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { AgentConfig, MCPServerConfig } from "../../types";
import { resolveMcpConfigPaths } from "../configPaths";
import {
  DEFAULT_MCP_SERVERS_DOCUMENT,
  parseMCPServerConfig,
  parseMCPServersDocument,
} from "./parser";

const errorWithCodeSchema = z.object({ code: z.string() }).passthrough();

function sortServersByName(servers: MCPServerConfig[]): MCPServerConfig[] {
  return [...servers].sort((a, b) => a.name.localeCompare(b.name));
}

async function atomicWriteFile(filePath: string, payload: string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await fs.writeFile(tempPath, payload, { encoding: "utf-8", mode });
  await fs.rename(tempPath, filePath);
  try {
    await fs.chmod(filePath, mode);
  } catch {
    // best effort
  }
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

export async function writeWorkspaceMCPServersDocument(config: AgentConfig, rawJson: string): Promise<void> {
  parseMCPServersDocument(rawJson);
  const paths = resolveMcpConfigPaths(config);
  await fs.mkdir(paths.workspaceCoworkDir, { recursive: true });
  const payload = rawJson.endsWith("\n") ? rawJson : `${rawJson}\n`;
  await atomicWriteFile(paths.workspaceConfigFile, payload, 0o600);
}

async function readEditableWorkspaceServers(config: AgentConfig): Promise<MCPServerConfig[]> {
  const { rawJson } = await readWorkspaceMCPServersDocument(config);
  return parseMCPServersDocument(rawJson).servers;
}

async function writeWorkspaceServers(config: AgentConfig, servers: MCPServerConfig[]): Promise<void> {
  const payload = `${JSON.stringify({ servers: sortServersByName(servers) }, null, 2)}\n`;
  const paths = resolveMcpConfigPaths(config);
  await fs.mkdir(paths.workspaceCoworkDir, { recursive: true });
  await atomicWriteFile(paths.workspaceConfigFile, payload, 0o600);
}

export async function upsertWorkspaceMCPServer(
  config: AgentConfig,
  server: MCPServerConfig,
  previousName?: string,
): Promise<void> {
  const validated = parseMCPServerConfig(server);
  const workspaceServers = await readEditableWorkspaceServers(config);

  const trimmedPrevious = previousName?.trim();
  const isRename = trimmedPrevious && trimmedPrevious.length > 0 && trimmedPrevious !== validated.name;

  if (isRename && workspaceServers.some((entry) => entry.name === validated.name)) {
    throw new Error(
      `mcp-servers.json: cannot rename "${trimmedPrevious}" to "${validated.name}" because "${validated.name}" already exists`,
    );
  }

  const nextServers = workspaceServers.filter((entry) => {
    if (trimmedPrevious && trimmedPrevious.length > 0) {
      return entry.name !== trimmedPrevious;
    }
    return entry.name !== validated.name;
  });
  nextServers.push(validated);
  await writeWorkspaceServers(config, nextServers);

  if (trimmedPrevious && trimmedPrevious.length > 0 && trimmedPrevious !== validated.name) {
    const { renameMCPServerCredentials } = await import("../authStore");
    await renameMCPServerCredentials({
      config,
      source: "workspace",
      previousName: trimmedPrevious,
      nextName: validated.name,
    });
  }
}

export async function deleteWorkspaceMCPServer(config: AgentConfig, nameRaw: string): Promise<void> {
  const name = nameRaw.trim();
  if (!name) {
    throw new Error("mcp-servers.json: server name is required");
  }

  const workspaceServers = await readEditableWorkspaceServers(config);
  const nextServers = workspaceServers.filter((entry) => entry.name !== name);
  await writeWorkspaceServers(config, nextServers);
}
