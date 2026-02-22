import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import type { AgentConfig, MCPServerConfig } from "../types";

export const MCP_SERVERS_FILE_NAME = "mcp-servers.json";
const LEGACY_ARCHIVE_FILE_NAME = "mcp-servers.legacy-migrated.json";
const DEFAULT_MCP_SERVERS = { servers: [] } as const;

export const DEFAULT_MCP_SERVERS_DOCUMENT = `${JSON.stringify(DEFAULT_MCP_SERVERS, null, 2)}\n`;

export type MCPServerSource = "workspace" | "user" | "system" | "workspace_legacy" | "user_legacy";

export interface MCPRegistryServer extends MCPServerConfig {
  source: MCPServerSource;
  inherited: boolean;
}

export interface MCPRegistryLegacyState {
  workspace: {
    path: string;
    exists: boolean;
  };
  user: {
    path: string;
    exists: boolean;
  };
}

export interface MCPRegistryFileState {
  source: MCPServerSource;
  path: string;
  exists: boolean;
  editable: boolean;
  legacy: boolean;
  parseError?: string;
  serverCount: number;
}

export interface MCPConfigRegistrySnapshot {
  servers: MCPRegistryServer[];
  files: MCPRegistryFileState[];
  legacy: MCPRegistryLegacyState;
  warnings: string[];
}

export interface MCPConfigPaths {
  workspaceRoot: string;
  workspaceCoworkDir: string;
  workspaceConfigFile: string;
  userCoworkDir: string;
  userConfigDir: string;
  userConfigFile: string;
  systemConfigFile: string;
  workspaceLegacyFile: string;
  userLegacyFile: string;
  workspaceAuthFile: string;
  userAuthFile: string;
}

export interface MCPMigrationResult {
  scope: "workspace" | "user";
  sourcePath: string;
  targetPath: string;
  archivedPath: string | null;
  imported: number;
  skippedConflicts: number;
}

type MCPConfigLayer = {
  source: MCPServerSource;
  file: MCPRegistryFileState;
  servers: MCPServerConfig[];
};

// ---------------------------------------------------------------------------
// Zod schemas for MCP server configuration parsing
// ---------------------------------------------------------------------------

const stringMap = z.record(z.string(), z.string());

const stdioTransport = z.object({
  type: z.literal("stdio"),
  command: z.string().trim().min(1),
  args: z.array(z.string()).optional(),
  env: stringMap.optional(),
  cwd: z.string().trim().min(1).optional(),
});

const httpTransport = z.object({
  type: z.enum(["http", "sse"]),
  url: z.string().trim().min(1),
  headers: stringMap.optional(),
});

const transportSchema = z.discriminatedUnion("type", [stdioTransport, httpTransport]);

const authSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("api_key"),
    headerName: z.string().trim().min(1).optional(),
    prefix: z.string().trim().min(1).optional(),
    keyId: z.string().trim().min(1).optional(),
  }),
  z.object({
    type: z.literal("oauth"),
    scope: z.string().trim().min(1).optional(),
    resource: z.string().trim().min(1).optional(),
    oauthMode: z.enum(["auto", "code"]).optional(),
  }),
]);

const mcpServerSchema = z.object({
  name: z.string().trim().min(1),
  transport: transportSchema,
  required: z.boolean().optional(),
  retries: z.number().finite().optional(),
  auth: authSchema.optional(),
});

const mcpServersDocumentSchema = z.object({
  servers: z.array(mcpServerSchema).default([]),
});

function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "validation failed";
  const path = issue.path.length > 0 ? issue.path.join(".") : "root";
  return `${path}: ${issue.message}`;
}

export function parseMCPServersDocument(rawJson: string): { servers: MCPServerConfig[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new Error(`mcp-servers.json: invalid JSON: ${String(error)}`);
  }

  const result = mcpServersDocumentSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`mcp-servers.json: ${formatZodError(result.error)}`);
  }

  return { servers: result.data.servers as MCPServerConfig[] };
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export function resolveMcpConfigPaths(config: AgentConfig): MCPConfigPaths {
  const workspaceRoot = path.dirname(config.projectAgentDir);
  const userHome = config.userAgentDir ? path.dirname(config.userAgentDir) : os.homedir();

  const workspaceCoworkDir = path.join(workspaceRoot, ".cowork");
  const userCoworkDir = path.join(userHome, ".cowork");

  return {
    workspaceRoot,
    workspaceCoworkDir,
    workspaceConfigFile: path.join(workspaceCoworkDir, MCP_SERVERS_FILE_NAME),
    userCoworkDir,
    userConfigDir: path.join(userCoworkDir, "config"),
    userConfigFile: path.join(userCoworkDir, "config", MCP_SERVERS_FILE_NAME),
    systemConfigFile: path.join(config.builtInConfigDir, MCP_SERVERS_FILE_NAME),
    workspaceLegacyFile: path.join(config.projectAgentDir, MCP_SERVERS_FILE_NAME),
    userLegacyFile: path.join(config.userAgentDir, MCP_SERVERS_FILE_NAME),
    workspaceAuthFile: path.join(workspaceCoworkDir, "auth", "mcp-credentials.json"),
    userAuthFile: path.join(userCoworkDir, "auth", "mcp-credentials.json"),
  };
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

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

async function readLayer(opts: {
  source: MCPServerSource;
  filePath: string;
  editable: boolean;
  legacy: boolean;
}): Promise<MCPConfigLayer> {
  let exists = false;
  let rawJson = "";
  try {
    rawJson = await fs.readFile(opts.filePath, "utf-8");
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      throw error;
    }
  }

  const servers = exists ? parseMCPServersDocument(rawJson).servers : [];

  return {
    source: opts.source,
    file: {
      source: opts.source,
      path: opts.filePath,
      exists,
      editable: opts.editable,
      legacy: opts.legacy,
      serverCount: servers.length,
    },
    servers,
  };
}

// ---------------------------------------------------------------------------
// Registry loading and layer merging
// ---------------------------------------------------------------------------

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
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
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

  const warnings: string[] = [];

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

// ---------------------------------------------------------------------------
// Workspace server CRUD
// ---------------------------------------------------------------------------

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
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
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
  const validated = parseMCPServersDocument(JSON.stringify({ servers: [server] })).servers[0];
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
    const { renameMCPServerCredentials } = await import("./authStore");
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

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

async function readServersOrEmpty(filePath: string): Promise<MCPServerConfig[]> {
  try {
    const rawJson = await fs.readFile(filePath, "utf-8");
    return parseMCPServersDocument(rawJson).servers;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function archiveLegacyFile(legacyPath: string): Promise<string | null> {
  try {
    await fs.access(legacyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const archiveBase = path.join(path.dirname(legacyPath), LEGACY_ARCHIVE_FILE_NAME);
  let archivePath = archiveBase;
  try {
    await fs.access(archivePath);
    archivePath = path.join(
      path.dirname(legacyPath),
      `mcp-servers.legacy-migrated.${Date.now()}.json`,
    );
  } catch {
    // archive path is available
  }

  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  await fs.rename(legacyPath, archivePath);
  return archivePath;
}

export async function migrateLegacyMCPServers(
  config: AgentConfig,
  scope: "workspace" | "user",
): Promise<MCPMigrationResult> {
  const paths = resolveMcpConfigPaths(config);
  const sourcePath = scope === "workspace" ? paths.workspaceLegacyFile : paths.userLegacyFile;
  const targetPath = scope === "workspace" ? paths.workspaceConfigFile : paths.userConfigFile;

  const legacyServers = await readServersOrEmpty(sourcePath);
  const targetServers = await readServersOrEmpty(targetPath);

  const existingNames = new Set(targetServers.map((server) => server.name));
  let imported = 0;
  let skippedConflicts = 0;

  const merged = [...targetServers];
  for (const server of legacyServers) {
    if (existingNames.has(server.name)) {
      skippedConflicts += 1;
      continue;
    }
    existingNames.add(server.name);
    merged.push(server);
    imported += 1;
  }

  const payload = `${JSON.stringify({ servers: sortServersByName(merged) }, null, 2)}\n`;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await atomicWriteFile(targetPath, payload, 0o600);

  const archivedPath = await archiveLegacyFile(sourcePath);

  return {
    scope,
    sourcePath,
    targetPath,
    archivedPath,
    imported,
    skippedConflicts,
  };
}
