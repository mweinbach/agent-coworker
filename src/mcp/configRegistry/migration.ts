import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { AgentConfig, MCPServerConfig } from "../../types";
import { resolveMcpConfigPaths } from "../configPaths";
import { parseMCPServersDocument } from "./parser";
import type { MCPMigrationResult } from "./types";

const LEGACY_ARCHIVE_FILE_NAME = "mcp-servers.legacy-migrated.json";
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

async function readServersOrEmpty(filePath: string): Promise<MCPServerConfig[]> {
  try {
    const rawJson = await fs.readFile(filePath, "utf-8");
    return parseMCPServersDocument(rawJson).servers;
  } catch (error) {
    const parsedCode = errorWithCodeSchema.safeParse(error);
    if (parsedCode.success && parsedCode.data.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function archiveLegacyFile(legacyPath: string): Promise<string | null> {
  try {
    await fs.access(legacyPath);
  } catch (error) {
    const parsedCode = errorWithCodeSchema.safeParse(error);
    if (parsedCode.success && parsedCode.data.code === "ENOENT") {
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
