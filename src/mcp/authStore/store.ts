import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { AgentConfig, PluginScope } from "../../types";
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

function ensureScopeDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  const parent = path.dirname(dir);
  return (async () => {
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    for (const candidate of [parent, dir]) {
      try {
        await fs.chmod(candidate, 0o700);
      } catch {
        // best effort
      }
    }
  })();
}

async function atomicWrite(filePath: string, payload: string): Promise<void> {
  await ensureScopeDir(filePath);
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await fs.writeFile(tempPath, payload, { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tempPath, filePath);
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // best effort
  }
}

async function readDoc(filePath: string): Promise<MCPServerCredentialsDocument> {
  const emptyDoc = (): MCPServerCredentialsDocument => ({
    ...DEFAULT_MCP_CREDENTIALS_DOCUMENT,
    updatedAt: nowIso(),
    servers: {},
  });

  try {
    const raw = await fs.readFile(filePath, "utf-8");
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return emptyDoc();
    }

    try {
      return normalizeCredentialsDoc(parsedJson);
    } catch {
      return emptyDoc();
    }
  } catch (error) {
    const parsedCode = errorWithCodeSchema.safeParse(error);
    const code = parsedCode.success ? parsedCode.data.code : undefined;
    if (code === "ENOENT") return emptyDoc();
    throw new Error(`Failed to read MCP credential store at ${filePath}: ${String(error)}`);
  }
}

async function writeDoc(filePath: string, doc: MCPServerCredentialsDocument): Promise<void> {
  const payload = `${JSON.stringify(doc, null, 2)}\n`;
  await atomicWrite(filePath, payload);
}

function resolvePluginAuthScope(scope: PluginScope | undefined): MCPAuthScope {
  return scope === "workspace" ? "workspace" : "user";
}

export function resolvePrimaryScope(
  source: MCPServerSource | { source: MCPServerSource; pluginScope?: PluginScope },
): MCPAuthScope {
  if (typeof source === "string") {
    if (source === "workspace" || source === "workspace_legacy") return "workspace";
    return "user";
  }
  if (source.source === "plugin") {
    return resolvePluginAuthScope(source.pluginScope);
  }
  return resolvePrimaryScope(source.source);
}

export function resolveScopeReadOrder(
  source: MCPServerSource | { source: MCPServerSource; pluginScope?: PluginScope },
): MCPAuthScope[] {
  // Keep credential resolution scoped to the originating config layer.
  // Workspace-defined servers must never fall back to user credentials.
  if (typeof source === "string") {
    if (source === "workspace" || source === "workspace_legacy") {
      return ["workspace"];
    }
    return ["user"];
  }
  if (source.source === "plugin") {
    return resolvePluginAuthScope(source.pluginScope) === "workspace" ? ["workspace"] : ["user"];
  }
  if (source.source === "workspace" || source.source === "workspace_legacy") {
    return ["workspace"];
  }
  return ["user"];
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

async function readMCPAuthFileByScope(
  config: AgentConfig,
  scope: MCPAuthScope,
): Promise<MCPAuthFileState> {
  const paths = resolveMcpConfigPaths(config);
  const filePath = scope === "workspace" ? paths.workspaceAuthFile : paths.userAuthFile;
  const doc = await readDoc(filePath);
  return { scope, filePath, doc };
}

export async function mutateScopeDoc(
  config: AgentConfig,
  scope: MCPAuthScope,
  mutate: (doc: MCPServerCredentialsDocument, filePath: string) => void,
): Promise<string> {
  const current = await readMCPAuthFileByScope(config, scope);
  const next: MCPServerCredentialsDocument = {
    ...current.doc,
    updatedAt: nowIso(),
    servers: { ...current.doc.servers },
  };
  mutate(next, current.filePath);
  await writeDoc(current.filePath, next);
  return current.filePath;
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
