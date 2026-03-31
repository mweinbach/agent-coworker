import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AgentConfig,
  PluginCatalogSnapshot,
  PluginInstallPreview,
  PluginInstallTargetScope,
} from "../types";
import { workspacePathOverlaps } from "../utils/workspacePath";
import { buildPluginCatalogSnapshot } from "./catalog";
import {
  buildPluginInstallPreview,
  materializePluginSource,
  type MaterializedPluginCandidate,
  type MaterializedPluginSource,
  resolvePluginSource,
} from "./sourceResolver";

type WritablePluginScopePaths = {
  scope: PluginInstallTargetScope;
  pluginsDir: string;
};

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

function conflictingTargetRoots(paths: WritablePluginScopePaths, pluginId: string): string[] {
  return [path.join(paths.pluginsDir, pluginId)];
}

async function removeConflictingTargets(paths: WritablePluginScopePaths, pluginId: string): Promise<void> {
  for (const targetRoot of conflictingTargetRoots(paths, pluginId)) {
    await fs.rm(targetRoot, { recursive: true, force: true });
  }
}

async function copyPluginRoot(sourceRoot: string, destinationRoot: string): Promise<void> {
  await fs.mkdir(path.dirname(destinationRoot), { recursive: true });
  await fs.cp(sourceRoot, destinationRoot, {
    recursive: true,
    force: true,
    errorOnExist: false,
  });
}

async function stageCopySourceIfNeeded(
  sourceRoot: string,
  conflictingTargets: string[],
): Promise<{ sourceRoot: string; cleanup: () => Promise<void> }> {
  const overlapsConflict = conflictingTargets.some((targetRoot) => workspacePathOverlaps(sourceRoot, targetRoot));
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

async function refreshCatalog(config: AgentConfig): Promise<PluginCatalogSnapshot> {
  return await buildPluginCatalogSnapshot(config);
}

function candidateScope(
  config: AgentConfig,
  candidate: MaterializedPluginCandidate,
  targetScope: PluginInstallTargetScope,
): "workspace" | "user" {
  if (targetScope === "workspace") {
    return "workspace";
  }
  if (config.workspacePluginsDir && candidate.rootDir.startsWith(config.workspacePluginsDir)) {
    return "workspace";
  }
  return "user";
}

function validateInstallCandidates(
  config: AgentConfig,
  catalog: PluginCatalogSnapshot,
  validCandidates: MaterializedPluginCandidate[],
  targetScope: PluginInstallTargetScope,
): void {
  const seenIds = new Set<string>();
  for (const candidate of validCandidates) {
    if (seenIds.has(candidate.pluginId)) {
      throw new Error(
        `The install source contains more than one valid plugin named "${candidate.pluginId}". Split the source or remove duplicates so each plugin id is unique.`,
      );
    }
    seenIds.add(candidate.pluginId);
  }

  for (const candidate of validCandidates) {
    const nextScope = candidateScope(config, candidate, targetScope);
    const conflictingPlugin = catalog.plugins.find((plugin) => plugin.id === candidate.pluginId && plugin.scope !== nextScope);
    if (conflictingPlugin) {
      throw new Error(
        `Plugin "${candidate.pluginId}" already exists in the ${conflictingPlugin.scope} scope. Remove it first before installing the same plugin id into ${nextScope}.`,
      );
    }
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
}): Promise<{ preview: PluginInstallPreview; pluginIds: string[]; catalog: PluginCatalogSnapshot }> {
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
    const validCandidates = materialized.candidates.filter((candidate) => candidate.diagnostics.length === 0);
    if (validCandidates.length === 0) {
      throw new Error("No valid plugin bundles were found in the provided source");
    }

    validateInstallCandidates(opts.config, currentCatalog, validCandidates, opts.targetScope);

    const installedPluginIds: string[] = [];
    for (const candidate of validCandidates) {
      const destinationRoot = path.join(writableScope.pluginsDir, candidate.pluginId);
      const stagedSource = await stageCopySourceIfNeeded(
        candidate.rootDir,
        conflictingTargetRoots(writableScope, candidate.pluginId),
      );
      try {
        await removeConflictingTargets(writableScope, candidate.pluginId);
        await copyPluginRoot(stagedSource.sourceRoot, destinationRoot);
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
