import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentConfig, MCPServerAuthConfig, MCPServerConfig } from "../types";

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

function parseAuth(value: unknown, index: number): MCPServerAuthConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`mcp-servers.json: servers[${index}].auth must be an object`);
  }

  const authType = asNonEmptyString(value.type);
  if (!authType) {
    throw new Error(`mcp-servers.json: servers[${index}].auth.type is required`);
  }

  if (authType === "none") {
    return { type: "none" };
  }

  if (authType === "api_key") {
    const headerName = asNonEmptyString(value.headerName) ?? undefined;
    const prefix = asNonEmptyString(value.prefix) ?? undefined;
    const keyId = asNonEmptyString(value.keyId) ?? undefined;
    return {
      type: "api_key",
      ...(headerName ? { headerName } : {}),
      ...(prefix ? { prefix } : {}),
      ...(keyId ? { keyId } : {}),
    };
  }

  if (authType === "oauth") {
    const oauthMode = asNonEmptyString(value.oauthMode);
    if (oauthMode && oauthMode !== "auto" && oauthMode !== "code") {
      throw new Error(`mcp-servers.json: servers[${index}].auth.oauthMode must be auto or code`);
    }
    const scope = asNonEmptyString(value.scope) ?? undefined;
    const resource = asNonEmptyString(value.resource) ?? undefined;
    return {
      type: "oauth",
      ...(scope ? { scope } : {}),
      ...(resource ? { resource } : {}),
      ...(oauthMode ? { oauthMode } : {}),
    };
  }

  throw new Error(`mcp-servers.json: servers[${index}].auth.type \"${authType}\" is not supported`);
}

function parseTransport(value: unknown, index: number): MCPServerConfig["transport"] {
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
  throw new Error(`mcp-servers.json: servers[${index}].transport.type \"${type}\" is not supported`);
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
    const auth = parseAuth(item.auth, i);

    servers.push({
      name,
      transport,
      ...(item.required !== undefined ? { required: item.required } : {}),
      ...(item.retries !== undefined ? { retries: item.retries } : {}),
      ...(auth ? { auth } : {}),
    });
  }

  return { servers };
}

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

  let servers: MCPServerConfig[] = [];
  let parseError: string | undefined;
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
  // Merge in low->high precedence so later layers overwrite earlier names.
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
        inherited: source !== "workspace",
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
    .filter((layer) => typeof layer.file.parseError === "string")
    .map((layer) => `${layer.source}: ${layer.file.parseError}`);

  const files = [
    layers.find((layer) => layer.source === "workspace")?.file,
    layers.find((layer) => layer.source === "user")?.file,
    layers.find((layer) => layer.source === "system")?.file,
    layers.find((layer) => layer.source === "workspace_legacy")?.file,
    layers.find((layer) => layer.source === "user_legacy")?.file,
  ].filter((file): file is MCPRegistryFileState => Boolean(file));

  return {
    servers: mergeLayers(layers),
    files,
    legacy: {
      workspace: {
        path: paths.workspaceLegacyFile,
        exists: layers.find((layer) => layer.source === "workspace_legacy")?.file.exists ?? false,
      },
      user: {
        path: paths.userLegacyFile,
        exists: layers.find((layer) => layer.source === "user_legacy")?.file.exists ?? false,
      },
    },
    warnings,
  };
}

export async function readWorkspaceMCPServersDocument(config: AgentConfig): Promise<{
  path: string;
  rawJson: string;
  workspaceServers: MCPServerConfig[];
  parseError?: string;
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

  let workspaceServers: MCPServerConfig[] = [];
  let parseError: string | undefined;
  try {
    workspaceServers = parseMCPServersDocument(rawJson).servers;
  } catch (error) {
    parseError = String(error);
  }

  return {
    path: paths.workspaceConfigFile,
    rawJson,
    workspaceServers,
    ...(parseError ? { parseError } : {}),
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

async function readServersFromFile(filePath: string): Promise<MCPServerConfig[]> {
  const rawJson = await fs.readFile(filePath, "utf-8");
  return parseMCPServersDocument(rawJson).servers;
}

async function readServersOrEmpty(filePath: string): Promise<MCPServerConfig[]> {
  try {
    return await readServersFromFile(filePath);
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
