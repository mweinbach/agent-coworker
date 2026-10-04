import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { AgentConfig, PluginScope } from "../../types";
import { writeTextFileAtomic } from "../../utils/atomicFile";
import { fileLockRootForCoworkHome, withFileLock } from "../../utils/fileLock";
import { nowIso } from "../../utils/typeGuards";
import { resolveMcpConfigPaths } from "../configPaths";
import type { MCPRegistryServer, MCPServerSource } from "../configRegistry/types";
import { DEFAULT_MCP_CREDENTIALS_DOCUMENT, normalizeCredentialsDoc } from "./parser";
import type {
  MCPAuthFileState,
  MCPAuthScope,
  MCPServerCredentialRecord,
  MCPServerCredentialsDocument,
} from "./types";

const errorWithCodeSchema = z.object({ code: z.string() }).passthrough();

async function ensureScopeDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  const parent = path.dirname(dir);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  for (const candidate of [parent, dir]) {
    try {
      await fs.chmod(candidate, 0o700);
    } catch {
      // best effort
    }
  }
}

async function readDoc(filePath: string): Promise<MCPServerCredentialsDocument> {
  const emptyDoc = (): MCPServerCredentialsDocument => ({
    ...DEFAULT_MCP_CREDENTIALS_DOCUMENT,
    updatedAt: nowIso(),
    servers: {},
  });

  let raw: string;
  try {
    raw = await Bun.file(filePath).text();
  } catch (error) {
    const parsedCode = errorWithCodeSchema.safeParse(error);
    if (parsedCode.success && parsedCode.data.code === "ENOENT") return emptyDoc();
    throw new Error(`Failed to read MCP credential store at ${filePath}: ${String(error)}`);
  }

  try {
    return normalizeCredentialsDoc(JSON.parse(raw));
  } catch {
    return emptyDoc();
  }
}

async function writeDoc(filePath: string, doc: MCPServerCredentialsDocument): Promise<void> {
  const payload = `${JSON.stringify(doc, null, 2)}\n`;
  await ensureScopeDir(filePath);
  await writeTextFileAtomic(filePath, payload, { mode: 0o600 });
}

export function resolvePrimaryScope(
  source: MCPServerSource | { source: MCPServerSource; pluginScope?: PluginScope },
): MCPAuthScope {
  if (typeof source === "string") {
    return source === "workspace" ? "workspace" : "user";
  }
  if (source.source === "plugin") {
    return source.pluginScope === "workspace" ? "workspace" : "user";
  }
  return resolvePrimaryScope(source.source);
}

export function resolveScopeReadOrder(
  source: MCPServerSource | { source: MCPServerSource; pluginScope?: PluginScope },
): MCPAuthScope[] {
  // Keep credential resolution scoped to the originating config layer.
  // Workspace-defined servers must never fall back to user credentials.
  return [resolvePrimaryScope(source)];
}

export async function readMCPAuthFiles(
  config: AgentConfig,
): Promise<{ workspace: MCPAuthFileState; user: MCPAuthFileState }> {
  const paths = resolveMcpConfigPaths(config);
  const [workspaceDoc, userDoc] = await Promise.all([
    readDoc(paths.workspaceAuthFile),
    readDoc(paths.userAuthFile),
  ]);
  return {
    workspace: {
      scope: "workspace",
      filePath: paths.workspaceAuthFile,
      doc: workspaceDoc,
    },
    user: {
      scope: "user",
      filePath: paths.userAuthFile,
      doc: userDoc,
    },
  };
}

export async function mutateScopeDoc(
  config: AgentConfig,
  scope: MCPAuthScope,
  mutate: (doc: MCPServerCredentialsDocument, filePath: string) => void,
): Promise<string> {
  const paths = resolveMcpConfigPaths(config);
  const filePath = scope === "workspace" ? paths.workspaceAuthFile : paths.userAuthFile;
  return await withFileLock(
    filePath,
    async () => {
      const currentDoc = await readDoc(filePath);
      const next: MCPServerCredentialsDocument = {
        ...currentDoc,
        updatedAt: nowIso(),
        servers: { ...currentDoc.servers },
      };
      mutate(next, filePath);
      await writeDoc(filePath, next);
      return filePath;
    },
    { lockRoot: fileLockRootForCoworkHome(config.userCoworkDir) },
  );
}

export function selectCredentialRecord(opts: {
  byScope: { workspace: MCPAuthFileState; user: MCPAuthFileState };
  source: MCPRegistryServer | MCPServerSource;
  serverName: string;
}): { scope: MCPAuthScope; record: MCPServerCredentialRecord | undefined } {
  const readOrder = resolveScopeReadOrder(opts.source);
  for (const scope of readOrder) {
    const record = opts.byScope[scope].doc.servers[opts.serverName];
    if (record) {
      return { scope, record };
    }
  }

  return {
    scope: resolvePrimaryScope(opts.source),
    record: undefined,
  };
}
