import fs from "node:fs/promises";
import path from "node:path";
import {
  expandHomeDir,
  type FetchLike,
  materializeGitHubDirectorySource,
  resolveGitHubOrLocalSource,
  trimSlashes,
} from "../extensions/source";
import type {
  PluginCatalogSnapshot,
  PluginInstallPreview,
  PluginInstallPreviewCandidate,
  PluginInstallTargetScope,
  PluginSourceDescriptor,
  SkillInstallationDiagnostic,
} from "../types";
import {
  isPluginManifestDirName,
  pluginManifestPathsForPluginRoot,
  readPluginManifest,
  validatePluginBundledSkills,
} from "./manifest";
import { readPluginMcpServers } from "./mcp";

export type MaterializedPluginCandidate = {
  rootDir: string;
  pluginId: string;
  displayName: string;
  description: string;
  diagnostics: SkillInstallationDiagnostic[];
  relativeRootPath: string;
};

export type MaterializedPluginSource = {
  descriptor: PluginSourceDescriptor;
  candidates: MaterializedPluginCandidate[];
  cleanup: () => Promise<void>;
};

function isPluginManifestGitHubInput(input: string): boolean {
  return /(?:^|\/)\.(?:cowork|codex)-plugin\/plugin\.json(?:$|[?#])/.test(input);
}

function normalizePluginGitHubDirectoryPath(filePath: string): string {
  const normalizedFilePath = trimSlashes(filePath);
  if (!normalizedFilePath) {
    return "";
  }

  const fileName = path.posix.basename(normalizedFilePath);
  const parentDir = path.posix.dirname(normalizedFilePath);
  if (fileName === "plugin.json" && isPluginManifestDirName(path.posix.basename(parentDir))) {
    const bundleRoot = path.posix.dirname(parentDir);
    return bundleRoot === "." ? "" : bundleRoot;
  }

  return parentDir === "." ? "" : parentDir;
}

function normalizePluginGitHubTreePath(directoryPath: string): string {
  const normalizedDirectoryPath = trimSlashes(directoryPath);
  if (!normalizedDirectoryPath) {
    return "";
  }

  if (!isPluginManifestDirName(path.posix.basename(normalizedDirectoryPath))) {
    return normalizedDirectoryPath;
  }

  const bundleRoot = path.posix.dirname(normalizedDirectoryPath);
  return bundleRoot === "." ? "" : bundleRoot;
}

function buildDiagnostic(
  code: string,
  severity: SkillInstallationDiagnostic["severity"],
  message: string,
): SkillInstallationDiagnostic {
  return { code, severity, message };
}

function normalizeLocalPluginSourceRoot(absolutePath: string, isFile: boolean): string {
  const candidateRoot = isFile ? path.dirname(absolutePath) : absolutePath;
  const baseName = path.basename(candidateRoot);
  const fileName = isFile ? path.basename(absolutePath) : "";

  if (isPluginManifestDirName(baseName)) {
    if (!isFile || fileName === "plugin.json") {
      return path.dirname(candidateRoot);
    }
  }

  return candidateRoot;
}

async function discoverPluginRoots(rootDir: string): Promise<string[]> {
  const found = new Set<string>();
  const visited = new Set<string>();

  async function visit(dir: string): Promise<void> {
    let canonicalDir: string;
    try {
      canonicalDir = await fs.realpath(dir);
    } catch {
      canonicalDir = path.resolve(dir);
    }
    if (visited.has(canonicalDir)) {
      return;
    }
    visited.add(canonicalDir);

    let dirents: Array<import("node:fs").Dirent>;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }

    for (const manifestPath of pluginManifestPathsForPluginRoot(dir)) {
      try {
        const stat = await fs.stat(manifestPath);
        if (stat.isFile()) {
          found.add(dir);
          break;
        }
      } catch {
        // continue searching supported manifest locations
      }
    }

    for (const dirent of dirents) {
      const childPath = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await visit(childPath);
        continue;
      }
      if (!dirent.isSymbolicLink()) {
        continue;
      }
      try {
        const stat = await fs.stat(childPath);
        if (!stat.isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }
      await visit(childPath);
    }
  }

  await visit(rootDir);
  return [...found].sort((left, right) => left.localeCompare(right));
}

async function loadMaterializedPluginCandidates(
  stageRoot: string,
): Promise<MaterializedPluginCandidate[]> {
  const pluginRoots = await discoverPluginRoots(stageRoot);
  const candidates: MaterializedPluginCandidate[] = [];
  for (const rootDir of pluginRoots) {
    try {
      const manifest = await readPluginManifest(rootDir);
      const diagnostics: SkillInstallationDiagnostic[] = [];
      const skillWarnings = await validatePluginBundledSkills(manifest);
      diagnostics.push(
        ...skillWarnings.map((warning) =>
          buildDiagnostic("invalid_plugin_skill", "error", warning),
        ),
      );
      if (manifest.mcpPath) {
        try {
          await readPluginMcpServers(manifest.mcpPath);
        } catch (error) {
          diagnostics.push(
            buildDiagnostic(
              "invalid_plugin_mcp",
              "error",
              `Invalid or unreadable bundled MCP config: ${String(error)}`,
            ),
          );
        }
      }
      candidates.push({
        rootDir,
        pluginId: manifest.name,
        displayName: manifest.interface?.displayName ?? manifest.name,
        description: manifest.description,
        diagnostics,
        relativeRootPath: path.relative(stageRoot, rootDir) || path.basename(rootDir),
      });
    } catch (error) {
      candidates.push({
        rootDir,
        pluginId: path.basename(rootDir),
        displayName: path.basename(rootDir),
        description: "Invalid plugin source",
        diagnostics: [
          buildDiagnostic(
            "invalid_plugin_manifest",
            "error",
            `Invalid or unreadable plugin manifest: ${String(error)}`,
          ),
        ],
        relativeRootPath: path.relative(stageRoot, rootDir) || path.basename(rootDir),
      });
    }
  }

  if (candidates.length === 0) {
    candidates.push({
      rootDir: stageRoot,
      pluginId: path.basename(stageRoot),
      displayName: path.basename(stageRoot),
      description: "No plugin bundle found",
      diagnostics: [
        buildDiagnostic(
          "no_plugin_found",
          "error",
          "No plugin roots containing .cowork-plugin/plugin.json or .codex-plugin/plugin.json were found",
        ),
      ],
      relativeRootPath: ".",
    });
  }

  return candidates.sort((left, right) =>
    left.relativeRootPath.localeCompare(right.relativeRootPath),
  );
}

async function materializeLocalPath(localPath: string): Promise<MaterializedPluginSource> {
  const absolutePath = path.resolve(expandHomeDir(localPath));
  const stat = await fs.stat(absolutePath);
  const candidateRoot = normalizeLocalPluginSourceRoot(absolutePath, stat.isFile());
  const descriptor: PluginSourceDescriptor = {
    kind: "local_path",
    raw: localPath,
    displaySource: absolutePath,
    localPath: absolutePath,
  };
  const candidates = await loadMaterializedPluginCandidates(candidateRoot);
  return {
    descriptor,
    candidates,
    cleanup: async () => {},
  };
}

export function resolvePluginSource(input: string, cwd = process.cwd()): PluginSourceDescriptor {
  return resolveGitHubOrLocalSource<PluginSourceDescriptor>(input, cwd);
}

async function materializeGitHubSource(
  descriptor: PluginSourceDescriptor,
  fetchImpl: FetchLike,
): Promise<MaterializedPluginSource> {
  return await materializeGitHubDirectorySource({
    descriptor,
    fetchImpl,
    tmpPrefix: "cowork-plugin-source-",
    normalizeTreePath: normalizePluginGitHubTreePath,
    normalizeFileDirectoryPath: normalizePluginGitHubDirectoryPath,
    shouldSkipPreferredAttempt: (source) =>
      source.refPath !== undefined &&
      (source.kind === "github_blob" || source.kind === "github_raw") &&
      isPluginManifestGitHubInput(source.raw),
    includeRemoteDefaultBranch: true,
    loadCandidates: async (stageRoot) => await loadMaterializedPluginCandidates(stageRoot),
  });
}

export async function materializePluginSource(opts: {
  input: string;
  cwd?: string;
  fetchImpl?: FetchLike;
}): Promise<MaterializedPluginSource> {
  const descriptor = resolvePluginSource(opts.input, opts.cwd);
  if (descriptor.kind === "local_path") {
    return await materializeLocalPath(descriptor.localPath ?? descriptor.displaySource);
  }
  return await materializeGitHubSource(descriptor, opts.fetchImpl ?? fetch);
}

function wouldCandidateBePrimary(
  candidatePluginId: string,
  targetScope: PluginInstallTargetScope,
  catalog: PluginCatalogSnapshot,
): boolean {
  const activePlugins = catalog.plugins.filter(
    (plugin) => plugin.id === candidatePluginId && plugin.enabled && plugin.installed !== false,
  );
  if (activePlugins.length === 0) {
    return true;
  }
  if (activePlugins.some((plugin) => plugin.scope === targetScope)) {
    return true;
  }
  return targetScope === "workspace";
}

function buildPreviewCandidate(
  candidate: MaterializedPluginCandidate,
  targetScope: PluginInstallTargetScope,
  catalog: PluginCatalogSnapshot,
): PluginInstallPreviewCandidate {
  const sameIdPlugins = catalog.plugins.filter(
    (plugin) => plugin.id === candidate.pluginId && plugin.installed !== false,
  );
  const targetScopeConflict = sameIdPlugins.find((plugin) => plugin.scope === targetScope);

  return {
    pluginId: candidate.pluginId,
    displayName: candidate.displayName,
    description: candidate.description,
    relativeRootPath: candidate.relativeRootPath,
    ...(targetScopeConflict
      ? {
          conflictsWithPluginId: targetScopeConflict.id,
          conflictsWithScope: targetScopeConflict.scope,
        }
      : {}),
    wouldBePrimary: wouldCandidateBePrimary(candidate.pluginId, targetScope, catalog),
    shadowedPluginIds: sameIdPlugins.map((plugin) => plugin.id),
    diagnostics: candidate.diagnostics,
  };
}

export async function buildPluginInstallPreview(opts: {
  input: string;
  targetScope: PluginInstallTargetScope;
  catalog: PluginCatalogSnapshot;
  cwd?: string;
  fetchImpl?: FetchLike;
  materialized?: MaterializedPluginSource;
}): Promise<PluginInstallPreview> {
  const materialized =
    opts.materialized ??
    (await materializePluginSource({
      input: opts.input,
      cwd: opts.cwd,
      fetchImpl: opts.fetchImpl,
    }));
  const shouldCleanup = !opts.materialized;

  try {
    const candidates = materialized.candidates.map((candidate) =>
      buildPreviewCandidate(candidate, opts.targetScope, opts.catalog),
    );
    const warnings: string[] = [];
    if (candidates.every((candidate) => candidate.diagnostics.length > 0)) {
      warnings.push("No valid plugin bundles were found in the provided source.");
    }

    return {
      source: materialized.descriptor,
      targetScope: opts.targetScope,
      candidates,
      warnings,
    };
  } finally {
    if (shouldCleanup) {
      await materialized.cleanup();
    }
  }
}
