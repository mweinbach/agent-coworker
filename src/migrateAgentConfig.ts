import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseMCPServersDocument } from "./mcp/configRegistry";
import type { MCPServerConfig } from "./types";
import { writeTextFileAtomic } from "./utils/atomicFile";

type MigrationScope = "workspace" | "user";

type AgentConfigMigrationScopeResult = {
  scope: MigrationScope;
  sourceDir: string;
  targetDir: string;
  archivedPath: string | null;
  configImported: number;
  configSkippedConflicts: number;
  mcpImported: number;
  mcpSkippedConflicts: number;
  entriesImported: number;
  entriesSkippedConflicts: number;
  warnings: string[];
};

export type AgentConfigMigrationResult = {
  scopes: AgentConfigMigrationScopeResult[];
};

type ScopePaths = {
  scope: MigrationScope;
  sourceDir: string;
  targetDir: string;
  sourceConfigFile: string;
  targetConfigFile: string;
  sourceMcpFile: string;
  targetMcpFile: string;
};

type JsonObject = Record<string, unknown>;

type JsonMergeResult = {
  value: JsonObject;
  imported: number;
  skippedConflicts: number;
};

const errorWithCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (errorWithCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function readJsonObjectIfExists(filePath: string): Promise<JsonObject | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) {
      throw new Error(`JSON root must be an object`);
    }
    return parsed;
  } catch (error) {
    if (errorWithCode(error) === "ENOENT") return null;
    throw new Error(`${filePath}: ${String(error)}`);
  }
}

function mergeJsonPreservingTarget(source: JsonObject, target: JsonObject): JsonMergeResult {
  const value: JsonObject = { ...target };
  let imported = 0;
  let skippedConflicts = 0;

  for (const [key, sourceValue] of Object.entries(source)) {
    if (!(key in target)) {
      value[key] = sourceValue;
      imported += 1;
      continue;
    }

    const targetValue = target[key];
    if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
      const nested = mergeJsonPreservingTarget(sourceValue, targetValue);
      value[key] = nested.value;
      imported += nested.imported;
      skippedConflicts += nested.skippedConflicts;
      continue;
    }

    skippedConflicts += 1;
  }

  return { value, imported, skippedConflicts };
}

async function writeJsonFile(filePath: string, value: unknown, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeTextFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    ...(mode ? { mode } : {}),
  });
}

async function migrateJsonConfig(
  sourceFile: string,
  targetFile: string,
): Promise<{ imported: number; skippedConflicts: number }> {
  const source = await readJsonObjectIfExists(sourceFile);
  if (!source) return { imported: 0, skippedConflicts: 0 };

  const target = (await readJsonObjectIfExists(targetFile)) ?? {};
  const merged = mergeJsonPreservingTarget(source, target);
  await writeJsonFile(targetFile, merged.value);
  return {
    imported: merged.imported,
    skippedConflicts: merged.skippedConflicts,
  };
}

async function readMcpServersIfExists(filePath: string): Promise<MCPServerConfig[] | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return parseMCPServersDocument(raw).servers;
  } catch (error) {
    if (errorWithCode(error) === "ENOENT") return null;
    throw new Error(`${filePath}: ${String(error)}`);
  }
}

function sortServersByName(servers: MCPServerConfig[]): MCPServerConfig[] {
  return [...servers].sort((left, right) => left.name.localeCompare(right.name));
}

async function migrateMcpServers(
  sourceFile: string,
  targetFile: string,
): Promise<{ imported: number; skippedConflicts: number }> {
  const sourceServers = await readMcpServersIfExists(sourceFile);
  if (!sourceServers) return { imported: 0, skippedConflicts: 0 };

  const targetServers = (await readMcpServersIfExists(targetFile)) ?? [];
  const existingNames = new Set(targetServers.map((server) => server.name));
  const merged = [...targetServers];
  let imported = 0;
  let skippedConflicts = 0;

  for (const server of sourceServers) {
    if (existingNames.has(server.name)) {
      skippedConflicts += 1;
      continue;
    }
    existingNames.add(server.name);
    merged.push(server);
    imported += 1;
  }

  await writeJsonFile(targetFile, { servers: sortServersByName(merged) }, 0o600);
  return { imported, skippedConflicts };
}

async function movePath(sourcePath: string, targetPath: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await fs.rename(sourcePath, targetPath);
  } catch (error) {
    if (errorWithCode(error) !== "EXDEV") throw error;
    await fs.cp(sourcePath, targetPath, { recursive: true, errorOnExist: true });
    await fs.rm(sourcePath, { recursive: true, force: true });
  }
}

async function moveFileIfTargetMissing(
  sourceFile: string,
  targetFile: string,
): Promise<"imported" | "skipped" | "missing"> {
  if (!(await pathExists(sourceFile))) return "missing";
  if (await pathExists(targetFile)) return "skipped";
  await movePath(sourceFile, targetFile);
  return "imported";
}

async function mergeDirectoryEntries(
  sourceDir: string,
  targetDir: string,
): Promise<{ imported: number; skippedConflicts: number }> {
  if (!(await pathExists(sourceDir))) {
    return { imported: 0, skippedConflicts: 0 };
  }

  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir);
  let imported = 0;
  let skippedConflicts = 0;

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry);
    const targetPath = path.join(targetDir, entry);
    if (await pathExists(targetPath)) {
      skippedConflicts += 1;
      continue;
    }
    await movePath(sourcePath, targetPath);
    imported += 1;
  }

  return { imported, skippedConflicts };
}

function archivePathFor(sourceDir: string, suffix = ""): string {
  const parent = path.dirname(sourceDir);
  const base = path.basename(sourceDir);
  return path.join(parent, `${base}.legacy-migrated.${Date.now()}${suffix}`);
}

async function archiveSourceDir(sourceDir: string): Promise<string | null> {
  if (!(await pathExists(sourceDir))) return null;
  let archivePath = archivePathFor(sourceDir);
  let attempt = 1;
  while (await pathExists(archivePath)) {
    archivePath = archivePathFor(sourceDir, `.${attempt}`);
    attempt += 1;
  }
  await fs.rename(sourceDir, archivePath);
  return archivePath;
}

function resolveScopePaths(cwd: string, homedir: string, scope: MigrationScope): ScopePaths {
  if (scope === "workspace") {
    const sourceDir = path.join(cwd, ".agent");
    const targetDir = path.join(cwd, ".cowork");
    return {
      scope,
      sourceDir,
      targetDir,
      sourceConfigFile: path.join(sourceDir, "config.json"),
      targetConfigFile: path.join(targetDir, "config.json"),
      sourceMcpFile: path.join(sourceDir, "mcp-servers.json"),
      targetMcpFile: path.join(targetDir, "mcp-servers.json"),
    };
  }

  const sourceDir = path.join(homedir, ".agent");
  const targetDir = path.join(homedir, ".cowork");
  return {
    scope,
    sourceDir,
    targetDir,
    sourceConfigFile: path.join(sourceDir, "config.json"),
    targetConfigFile: path.join(targetDir, "config", "config.json"),
    sourceMcpFile: path.join(sourceDir, "mcp-servers.json"),
    targetMcpFile: path.join(targetDir, "config", "mcp-servers.json"),
  };
}

async function migrateScope(paths: ScopePaths): Promise<AgentConfigMigrationScopeResult> {
  const result: AgentConfigMigrationScopeResult = {
    scope: paths.scope,
    sourceDir: paths.sourceDir,
    targetDir: paths.targetDir,
    archivedPath: null,
    configImported: 0,
    configSkippedConflicts: 0,
    mcpImported: 0,
    mcpSkippedConflicts: 0,
    entriesImported: 0,
    entriesSkippedConflicts: 0,
    warnings: [],
  };

  if (!(await pathExists(paths.sourceDir))) {
    return result;
  }

  try {
    const config = await migrateJsonConfig(paths.sourceConfigFile, paths.targetConfigFile);
    result.configImported = config.imported;
    result.configSkippedConflicts = config.skippedConflicts;
  } catch (error) {
    result.warnings.push(`Skipped config migration: ${String(error)}`);
  }

  try {
    const mcp = await migrateMcpServers(paths.sourceMcpFile, paths.targetMcpFile);
    result.mcpImported = mcp.imported;
    result.mcpSkippedConflicts = mcp.skippedConflicts;
  } catch (error) {
    result.warnings.push(`Skipped MCP migration: ${String(error)}`);
  }

  for (const dirName of ["skills", "disabled-skills", "memory"]) {
    const dirResult = await mergeDirectoryEntries(
      path.join(paths.sourceDir, dirName),
      path.join(paths.targetDir, dirName),
    );
    result.entriesImported += dirResult.imported;
    result.entriesSkippedConflicts += dirResult.skippedConflicts;
  }

  for (const fileName of ["AGENT.md", "memory.sqlite"]) {
    const moveResult = await moveFileIfTargetMissing(
      path.join(paths.sourceDir, fileName),
      path.join(paths.targetDir, fileName),
    );
    if (moveResult === "imported") result.entriesImported += 1;
    if (moveResult === "skipped") result.entriesSkippedConflicts += 1;
  }

  if (result.warnings.length === 0) {
    result.archivedPath = await archiveSourceDir(paths.sourceDir);
  }

  return result;
}

export async function migrateAgentConfig(
  opts: { cwd?: string; homedir?: string } = {},
): Promise<AgentConfigMigrationResult> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const homedir = path.resolve(opts.homedir ?? os.homedir());
  const scopes = await Promise.all([
    migrateScope(resolveScopePaths(cwd, homedir, "workspace")),
    migrateScope(resolveScopePaths(cwd, homedir, "user")),
  ]);
  return { scopes };
}

export function formatAgentConfigMigrationReport(result: AgentConfigMigrationResult): string {
  const lines = ["Cowork migration complete."];
  let foundLegacy = false;

  for (const scope of result.scopes) {
    const scopeHadLegacy =
      scope.archivedPath !== null ||
      scope.configImported > 0 ||
      scope.mcpImported > 0 ||
      scope.entriesImported > 0 ||
      scope.configSkippedConflicts > 0 ||
      scope.mcpSkippedConflicts > 0 ||
      scope.entriesSkippedConflicts > 0 ||
      scope.warnings.length > 0;
    foundLegacy ||= scopeHadLegacy;
    lines.push(
      `${scope.scope}: imported config keys=${scope.configImported}, MCP servers=${scope.mcpImported}, entries=${scope.entriesImported}; skipped conflicts config=${scope.configSkippedConflicts}, MCP=${scope.mcpSkippedConflicts}, entries=${scope.entriesSkippedConflicts}.`,
    );
    if (scope.archivedPath) {
      lines.push(`${scope.scope}: archived ${scope.sourceDir} to ${scope.archivedPath}.`);
    }
    for (const warning of scope.warnings) {
      lines.push(`${scope.scope}: warning: ${warning}`);
    }
  }

  if (!foundLegacy) {
    lines.push("No legacy .agent config found.");
  }

  return lines.join("\n");
}
