import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renameMCPServerCredentials } from "../mcp/authStore";
import type {
  AgentConfig,
  MCPServerConfig,
  PluginCatalogSnapshot,
  PluginInstallPreview,
  PluginInstallTargetScope,
} from "../types";
import { workspacePathOverlaps } from "../utils/workspacePath";
import { buildPluginCatalogSnapshot } from "./catalog";
import { readPluginManifest } from "./manifest";
import { readPluginMcpServers } from "./mcp";
import {
  buildPluginInstallPreview,
  type MaterializedPluginCandidate,
  type MaterializedPluginSource,
  materializePluginSource,
  resolvePluginSource,
} from "./sourceResolver";

type WritablePluginScopePaths = {
  scope: PluginInstallTargetScope;
  pluginsDir: string;
};

type CopyPluginRootImpl = (sourceRoot: string, destinationRoot: string) => Promise<void>;

function requireWritablePluginScope(
  config: AgentConfig,
  scope: PluginInstallTargetScope,
): WritablePluginScopePaths {
  const pluginsDir = scope === "workspace" ? config.workspacePluginsDir : config.userPluginsDir;
  if (!pluginsDir) {
    throw new Error(`Writable plugin scope "${scope}" is not configured`);
  }
  return {
    scope,
    pluginsDir,
  };
}

function conflictingTargetRoots(
  catalog: PluginCatalogSnapshot,
  paths: WritablePluginScopePaths,
  pluginId: string,
): string[] {
  const roots = new Set<string>();
  for (const plugin of catalog.plugins) {
    if (plugin.scope === paths.scope && plugin.id === pluginId) {
      roots.add(plugin.rootDir);
    }
  }
  roots.add(path.join(paths.pluginsDir, pluginId));
  return [...roots];
}

async function removeConflictingTargets(targetRoots: string[]): Promise<void> {
  for (const targetRoot of targetRoots) {
    await fs.rm(targetRoot, { recursive: true, force: true });
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function defaultCopyPluginRoot(sourceRoot: string, destinationRoot: string): Promise<void> {
  await fs.mkdir(path.dirname(destinationRoot), { recursive: true });
  await fs.cp(sourceRoot, destinationRoot, {
    recursive: true,
    force: true,
    errorOnExist: false,
  });
}

const pluginOperationInternals: {
  copyPluginRootImpl: CopyPluginRootImpl;
} = {
  copyPluginRootImpl: defaultCopyPluginRoot,
};

async function copyPluginRoot(sourceRoot: string, destinationRoot: string): Promise<void> {
  await pluginOperationInternals.copyPluginRootImpl(sourceRoot, destinationRoot);
}

async function stageCopySourceIfNeeded(
  sourceRoot: string,
  conflictingTargets: string[],
): Promise<{ sourceRoot: string; cleanup: () => Promise<void> }> {
  const overlapsConflict = conflictingTargets.some((targetRoot) =>
    workspacePathOverlaps(sourceRoot, targetRoot),
  );
  if (!overlapsConflict) {
    return {
      sourceRoot,
      cleanup: async () => {},
    };
  }

  const stageDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-coworker-plugin-stage-"));
  const stagedRoot = path.join(stageDir, path.basename(sourceRoot));
  await copyPluginRoot(sourceRoot, stagedRoot);
  return {
    sourceRoot: stagedRoot,
    cleanup: async () => {
      await fs.rm(stageDir, { recursive: true, force: true });
    },
  };
}

async function stagePluginInstallCopy(
  sourceRoot: string,
  destinationRoot: string,
): Promise<{ stagedRoot: string; cleanup: () => Promise<void> }> {
  const parentDir = path.dirname(destinationRoot);
  const destinationName = path.basename(destinationRoot);
  await fs.mkdir(parentDir, { recursive: true });
  const stageDir = await fs.mkdtemp(path.join(parentDir, `${destinationName}.incoming-`));
  const stagedRoot = path.join(stageDir, destinationName);
  try {
    await copyPluginRoot(sourceRoot, stagedRoot);
  } catch (error) {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return {
    stagedRoot,
    cleanup: async () => {
      await fs.rm(stageDir, { recursive: true, force: true });
    },
  };
}

async function replaceInstalledPlugin(opts: {
  sourceRoot: string;
  destinationRoot: string;
  conflictingRoots: string[];
  onInstalled: () => Promise<void>;
}): Promise<void> {
  const stagedInstall = await stagePluginInstallCopy(opts.sourceRoot, opts.destinationRoot);
  let backupRoot: string | null = null;
  let destinationActivated = false;

  try {
    if (await pathExists(opts.destinationRoot)) {
      backupRoot = `${opts.destinationRoot}.backup-${crypto.randomUUID()}`;
      await fs.rename(opts.destinationRoot, backupRoot);
    }

    await fs.rename(stagedInstall.stagedRoot, opts.destinationRoot);
    destinationActivated = true;

    await opts.onInstalled();
    await removeConflictingTargets(
      opts.conflictingRoots.filter((targetRoot) => targetRoot !== opts.destinationRoot),
    );

    if (backupRoot) {
      await fs.rm(backupRoot, { recursive: true, force: true });
      backupRoot = null;
    }
  } catch (error) {
    if (destinationActivated) {
      await fs.rm(opts.destinationRoot, { recursive: true, force: true }).catch(() => {});
    }
    if (backupRoot) {
      await fs.rename(backupRoot, opts.destinationRoot).catch(() => {});
    }
    throw error;
  } finally {
    await stagedInstall.cleanup().catch(() => {});
  }
}

async function refreshCatalog(config: AgentConfig): Promise<PluginCatalogSnapshot> {
  return await buildPluginCatalogSnapshot(config);
}

function validateInstallCandidates(validCandidates: MaterializedPluginCandidate[]): void {
  const seenIds = new Set<string>();
  for (const candidate of validCandidates) {
    if (seenIds.has(candidate.pluginId)) {
      throw new Error(
        `The install source contains more than one valid plugin named "${candidate.pluginId}". Split the source or remove duplicates so each plugin id is unique.`,
      );
    }
    seenIds.add(candidate.pluginId);
  }
}

async function readBundledPluginMcpServers(pluginRoot: string): Promise<MCPServerConfig[]> {
  try {
    const manifest = await readPluginManifest(pluginRoot);
    return await readPluginMcpServers(manifest.mcpPath);
  } catch {
    return [];
  }
}

async function findExistingInstallRoot(
  destinationRoot: string,
  targetRoots: string[],
): Promise<string | null> {
  const candidateRoots = [
    destinationRoot,
    ...targetRoots.filter((rootDir) => rootDir !== destinationRoot),
  ];
  for (const rootDir of candidateRoots) {
    try {
      await fs.stat(rootDir);
      return rootDir;
    } catch {}
  }
  return null;
}

function buildServerRenameSignature(server: MCPServerConfig): string {
  return JSON.stringify({
    transport: server.transport,
    ...(server.required !== undefined ? { required: server.required } : {}),
    ...(server.retries !== undefined ? { retries: server.retries } : {}),
    ...(server.auth ? { auth: server.auth } : {}),
  });
}

function inferBundledPluginMcpRenames(
  previousServers: MCPServerConfig[],
  nextServers: MCPServerConfig[],
): Array<{ previousName: string; nextName: string }> {
  const previousNames = new Set(previousServers.map((server) => server.name));
  const nextNames = new Set(nextServers.map((server) => server.name));
  const removedServers = previousServers.filter((server) => !nextNames.has(server.name));
  const addedServers = nextServers.filter((server) => !previousNames.has(server.name));

  const removedBySignature = new Map<string, MCPServerConfig[]>();
  for (const server of removedServers) {
    const signature = buildServerRenameSignature(server);
    removedBySignature.set(signature, [...(removedBySignature.get(signature) ?? []), server]);
  }

  const addedBySignature = new Map<string, MCPServerConfig[]>();
  for (const server of addedServers) {
    const signature = buildServerRenameSignature(server);
    addedBySignature.set(signature, [...(addedBySignature.get(signature) ?? []), server]);
  }

  const renames: Array<{ previousName: string; nextName: string }> = [];
  for (const [signature, previousMatches] of removedBySignature.entries()) {
    const nextMatches = addedBySignature.get(signature) ?? [];
    if (previousMatches.length !== 1 || nextMatches.length !== 1) {
      continue;
    }
    renames.push({
      previousName: previousMatches[0].name,
      nextName: nextMatches[0].name,
    });
  }

  return renames;
}

async function migrateBundledPluginMcpCredentials(opts: {
  config: AgentConfig;
  targetScope: PluginInstallTargetScope;
  previousServers: MCPServerConfig[];
  nextServers: MCPServerConfig[];
}): Promise<void> {
  const renames = inferBundledPluginMcpRenames(opts.previousServers, opts.nextServers);
  for (const rename of renames) {
    await renameMCPServerCredentials({
      config: opts.config,
      source: {
        source: "plugin",
        pluginScope: opts.targetScope,
      },
      previousName: rename.previousName,
      nextName: rename.nextName,
    });
  }
}

export async function previewPluginInstall(opts: {
  config: AgentConfig;
  input: string;
  targetScope: PluginInstallTargetScope;
}): Promise<PluginInstallPreview> {
  return await buildPluginInstallPreview({
    input: opts.input,
    targetScope: opts.targetScope,
    catalog: await refreshCatalog(opts.config),
    cwd: opts.config.workingDirectory,
  });
}

export async function installPluginsFromSource(opts: {
  config: AgentConfig;
  input: string;
  targetScope: PluginInstallTargetScope;
}): Promise<{
  preview: PluginInstallPreview;
  pluginIds: string[];
  catalog: PluginCatalogSnapshot;
}> {
  const currentCatalog = await refreshCatalog(opts.config);
  const preview = await buildPluginInstallPreview({
    input: opts.input,
    targetScope: opts.targetScope,
    catalog: currentCatalog,
    cwd: opts.config.workingDirectory,
  });

  const writableScope = requireWritablePluginScope(opts.config, opts.targetScope);
  const materialized = await materializePluginSource({
    input: opts.input,
    cwd: opts.config.workingDirectory,
  });

  try {
    const validCandidates = materialized.candidates.filter(
      (candidate) => candidate.diagnostics.length === 0,
    );
    if (validCandidates.length === 0) {
      throw new Error("No valid plugin bundles were found in the provided source");
    }

    validateInstallCandidates(validCandidates);

    const installedPluginIds: string[] = [];
    for (const candidate of validCandidates) {
      const destinationRoot = path.join(writableScope.pluginsDir, candidate.pluginId);
      const targetRoots = conflictingTargetRoots(currentCatalog, writableScope, candidate.pluginId);
      const existingInstallRoot = await findExistingInstallRoot(destinationRoot, targetRoots);
      const previousServers = existingInstallRoot
        ? await readBundledPluginMcpServers(existingInstallRoot)
        : [];
      const stagedSource = await stageCopySourceIfNeeded(candidate.rootDir, targetRoots);
      try {
        await replaceInstalledPlugin({
          sourceRoot: stagedSource.sourceRoot,
          destinationRoot,
          conflictingRoots: targetRoots,
          onInstalled: async () => {
            await migrateBundledPluginMcpCredentials({
              config: opts.config,
              targetScope: opts.targetScope,
              previousServers,
              nextServers: await readBundledPluginMcpServers(destinationRoot),
            });
          },
        });
      } finally {
        await stagedSource.cleanup();
      }
      installedPluginIds.push(candidate.pluginId);
    }

    return {
      preview,
      pluginIds: installedPluginIds,
      catalog: await refreshCatalog(opts.config),
    };
  } finally {
    await materialized.cleanup();
  }
}

export type { MaterializedPluginSource };

export function resolvePluginSourceDescriptorForInstallInput(input: string, cwd = process.cwd()) {
  return resolvePluginSource(input, cwd);
}

export const __internal = {
  setCopyPluginRootImplForTests(copyPluginRootImpl?: CopyPluginRootImpl) {
    pluginOperationInternals.copyPluginRootImpl = copyPluginRootImpl ?? defaultCopyPluginRoot;
  },
  resetForTests() {
    pluginOperationInternals.copyPluginRootImpl = defaultCopyPluginRoot;
  },
};
