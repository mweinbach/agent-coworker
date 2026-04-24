import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildGitHubApiUrl,
  downloadGitHubDirectory,
  type FetchLike,
  githubHeaders,
  type ParsedGitHubSource,
  parseGitHubShorthand,
  parseGitHubUrl,
} from "../skills/github";
import type {
  PluginCatalogSnapshot,
  PluginInstallPreview,
  PluginInstallPreviewCandidate,
  PluginInstallTargetScope,
  PluginScope,
  PluginSourceDescriptor,
  SkillInstallationDiagnostic,
} from "../types";
import { readPluginManifest, validatePluginBundledSkills } from "./manifest";
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

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function isPluginManifestGitHubInput(input: string): boolean {
  return /(?:^|\/)\.codex-plugin\/plugin\.json(?:$|[?#])/.test(input);
}

function normalizePluginGitHubDirectoryPath(filePath: string): string {
  const normalizedFilePath = trimSlashes(filePath);
  if (!normalizedFilePath) {
    return "";
  }

  const fileName = path.posix.basename(normalizedFilePath);
  const parentDir = path.posix.dirname(normalizedFilePath);
  if (fileName === "plugin.json" && path.posix.basename(parentDir) === ".codex-plugin") {
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

  if (path.posix.basename(normalizedDirectoryPath) !== ".codex-plugin") {
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

function expandHomeDir(input: string): string {
  if (!input.startsWith("~")) {
    return input;
  }
  return path.join(os.homedir(), input.slice(1));
}

function normalizeLocalPluginSourceRoot(absolutePath: string, isFile: boolean): string {
  const candidateRoot = isFile ? path.dirname(absolutePath) : absolutePath;
  const baseName = path.basename(candidateRoot);
  const fileName = isFile ? path.basename(absolutePath) : "";

  if (baseName === ".codex-plugin") {
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

    const manifestPath = path.join(dir, ".codex-plugin", "plugin.json");
    try {
      const stat = await fs.stat(manifestPath);
      if (stat.isFile()) {
        found.add(dir);
      }
    } catch {
      // continue searching descendants
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
            `Invalid or unreadable .codex-plugin/plugin.json: ${String(error)}`,
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
          "No Codex plugin roots containing .codex-plugin/plugin.json were found",
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

function buildDescriptorFromGitHubSource(
  raw: string,
  parsed: ParsedGitHubSource,
): PluginSourceDescriptor {
  const kindBySource: Record<ParsedGitHubSource["kind"], PluginSourceDescriptor["kind"]> = {
    repo: "github_repo",
    tree: "github_tree",
    blob: "github_blob",
    raw: "github_raw",
  };

  return {
    kind: kindBySource[parsed.kind],
    raw,
    displaySource: parsed.url,
    url: parsed.url,
    repo: parsed.repo,
    ...(parsed.ref ? { ref: parsed.ref } : {}),
    ...(parsed.subdir ? { subdir: parsed.subdir } : {}),
    ...(parsed.refPath ? { refPath: parsed.refPath } : {}),
  };
}

type GitHubMaterializationAttempt = {
  ref: string;
  githubPath: string;
  descriptor: PluginSourceDescriptor;
};

function buildResolvedGitHubDescriptor(
  descriptor: PluginSourceDescriptor,
  ref: string | undefined,
  githubPath: string,
): PluginSourceDescriptor {
  return {
    kind: descriptor.kind,
    raw: descriptor.raw,
    displaySource: descriptor.displaySource,
    ...(descriptor.url ? { url: descriptor.url } : {}),
    ...(descriptor.repo ? { repo: descriptor.repo } : {}),
    ...(ref ? { ref } : {}),
    ...(githubPath ? { subdir: githubPath } : {}),
    ...(descriptor.localPath ? { localPath: descriptor.localPath } : {}),
  };
}

function buildGitHubMaterializationAttempts(
  descriptor: PluginSourceDescriptor,
): GitHubMaterializationAttempt[] {
  const refPathSegments = descriptor.refPath?.split("/").filter(Boolean) ?? [];
  if (
    refPathSegments.length === 0 ||
    (descriptor.kind !== "github_tree" &&
      descriptor.kind !== "github_blob" &&
      descriptor.kind !== "github_raw")
  ) {
    return [];
  }

  const minimumTrailingSegments = descriptor.kind === "github_tree" ? 0 : 1;
  const attempts: GitHubMaterializationAttempt[] = [];
  for (let splitAt = refPathSegments.length - minimumTrailingSegments; splitAt >= 1; splitAt -= 1) {
    const ref = refPathSegments.slice(0, splitAt).join("/");
    const trailingPath = refPathSegments.slice(splitAt).join("/");
    const githubPath =
      descriptor.kind === "github_tree"
        ? normalizePluginGitHubTreePath(trailingPath)
        : trailingPath
          ? normalizePluginGitHubDirectoryPath(trailingPath)
          : "";
    const normalizedPath = githubPath === "." ? "" : githubPath;

    attempts.push({
      ref,
      githubPath: normalizedPath,
      descriptor: buildResolvedGitHubDescriptor(descriptor, ref, normalizedPath),
    });
  }

  return attempts;
}

function dedupeGitHubMaterializationAttempts(
  attempts: GitHubMaterializationAttempt[],
): GitHubMaterializationAttempt[] {
  return attempts.filter(
    (attempt, index, allAttempts) =>
      allAttempts.findIndex(
        (candidate) => candidate.ref === attempt.ref && candidate.githubPath === attempt.githubPath,
      ) === index,
  );
}

export function resolvePluginSource(input: string, cwd = process.cwd()): PluginSourceDescriptor {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Plugin source is required");
  }

  const githubUrl = parseGitHubUrl(trimmed);
  if (githubUrl) {
    return buildDescriptorFromGitHubSource(trimmed, githubUrl);
  }

  const githubShorthand = parseGitHubShorthand(trimmed);
  if (githubShorthand) {
    const candidateLocalPath = path.isAbsolute(trimmed)
      ? path.resolve(expandHomeDir(trimmed))
      : path.resolve(cwd, expandHomeDir(trimmed));
    if (existsSync(candidateLocalPath)) {
      return {
        kind: "local_path",
        raw: trimmed,
        displaySource: candidateLocalPath,
        localPath: candidateLocalPath,
      };
    }
    return {
      kind: "github_shorthand",
      raw: trimmed,
      displaySource: githubShorthand.url,
      url: githubShorthand.url,
      repo: githubShorthand.repo,
    };
  }

  const localPath = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, expandHomeDir(trimmed));
  return {
    kind: "local_path",
    raw: trimmed,
    displaySource: localPath,
    localPath,
  };
}

async function materializeGitHubSource(
  descriptor: PluginSourceDescriptor,
  fetchImpl: FetchLike,
): Promise<MaterializedPluginSource> {
  if (!descriptor.repo) {
    throw new Error("GitHub source is missing repo information");
  }

  const shouldSkipPreferredAttempt =
    descriptor.refPath !== undefined &&
    (descriptor.kind === "github_blob" || descriptor.kind === "github_raw") &&
    isPluginManifestGitHubInput(descriptor.raw);
  const preferredGitHubPath =
    descriptor.kind === "github_tree"
      ? normalizePluginGitHubTreePath(descriptor.subdir ?? "")
      : (descriptor.subdir ?? "");
  const preferredAttempt =
    descriptor.ref && !shouldSkipPreferredAttempt
      ? [
          {
            ref: descriptor.ref,
            githubPath: preferredGitHubPath,
            descriptor: buildResolvedGitHubDescriptor(
              descriptor,
              descriptor.ref,
              preferredGitHubPath,
            ),
          },
        ]
      : [];
  const attempts = buildGitHubMaterializationAttempts(descriptor);
  const fallbackRefs = descriptor.ref
    ? [descriptor.ref]
    : await resolveGitHubFallbackRefs(descriptor.repo, fetchImpl);
  const fallbackAttempts = fallbackRefs.map((ref) => {
    const githubPath =
      descriptor.kind === "github_tree"
        ? normalizePluginGitHubTreePath(descriptor.subdir ?? "")
        : (descriptor.subdir ?? "");
    return {
      ref,
      githubPath,
      descriptor: buildResolvedGitHubDescriptor(descriptor, ref, githubPath),
    };
  });
  const materializationAttempts = dedupeGitHubMaterializationAttempts(
    attempts.length > 0
      ? await resolveAmbiguousGitHubMaterializationAttempts(descriptor.repo, attempts, fetchImpl)
      : [...preferredAttempt, ...fallbackAttempts],
  );
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-plugin-source-"));
  let resolvedDescriptor: PluginSourceDescriptor | null = null;
  let resolvedCandidates: MaterializedPluginCandidate[] | null = null;
  let lastError: unknown = null;

  try {
    for (const attempt of materializationAttempts) {
      const repoRoot = path.join(tmpRoot, descriptor.repo.split("/").at(-1) ?? "repo");
      try {
        await fs.rm(repoRoot, { recursive: true, force: true });
        let stageRoot: string;
        if (attempt.githubPath) {
          const destination = path.join(repoRoot, path.basename(attempt.githubPath));
          await downloadGitHubDirectory({
            fetchImpl,
            repo: descriptor.repo,
            ref: attempt.ref,
            githubPath: attempt.githubPath,
            destDir: destination,
          });
          stageRoot = destination;
        } else {
          await downloadGitHubDirectory({
            fetchImpl,
            repo: descriptor.repo,
            ref: attempt.ref,
            githubPath: "",
            destDir: repoRoot,
          });
          stageRoot = repoRoot;
        }
        resolvedCandidates = await loadMaterializedPluginCandidates(stageRoot);
        resolvedDescriptor = attempt.descriptor;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!resolvedDescriptor || !resolvedCandidates) {
      throw lastError instanceof Error
        ? lastError
        : new Error(String(lastError ?? "Unable to fetch GitHub source"));
    }

    return {
      descriptor: resolvedDescriptor,
      candidates: resolvedCandidates,
      cleanup: async () => {
        await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch (error) {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function readResponseError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.trim() || `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

async function doesGitHubRefExist(
  fetchImpl: FetchLike,
  repo: string,
  ref: string,
): Promise<boolean> {
  const response = await fetchImpl(buildGitHubApiUrl(repo, ref, ""), {
    headers: githubHeaders(),
  });
  if (response.ok) {
    return true;
  }
  if (response.status === 404) {
    return false;
  }
  throw new Error(
    `Failed to verify GitHub ref ${repo}@${ref}: ${await readResponseError(response)}`,
  );
}

async function resolveAmbiguousGitHubMaterializationAttempts(
  repo: string,
  attempts: GitHubMaterializationAttempt[],
  fetchImpl: FetchLike,
): Promise<GitHubMaterializationAttempt[]> {
  const uniqueAttempts = dedupeGitHubMaterializationAttempts(attempts);
  const checkedRefs = new Map<string, boolean>();
  const existingAttempts: GitHubMaterializationAttempt[] = [];

  for (const attempt of uniqueAttempts) {
    let refExists = checkedRefs.get(attempt.ref);
    if (refExists === undefined) {
      refExists = await doesGitHubRefExist(fetchImpl, repo, attempt.ref);
      checkedRefs.set(attempt.ref, refExists);
    }
    if (refExists) {
      existingAttempts.push(attempt);
    }
  }

  return existingAttempts.length > 0 ? existingAttempts : uniqueAttempts;
}

async function fetchGitHubDefaultBranch(
  fetchImpl: FetchLike,
  repo: string,
): Promise<string | null> {
  const response = await fetchImpl(`https://api.github.com/repos/${repo}`, {
    headers: githubHeaders(),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch GitHub repo metadata for ${repo}: ${await readResponseError(response)}`,
    );
  }

  const parsed = (await response.json()) as Record<string, unknown>;
  return typeof parsed.default_branch === "string" && parsed.default_branch.trim().length > 0
    ? parsed.default_branch.trim()
    : null;
}

async function resolveGitHubFallbackRefs(
  repo: string | undefined,
  fetchImpl: FetchLike,
): Promise<string[]> {
  const fallbackRefs = new Set<string>();
  if (repo) {
    try {
      const defaultBranch = await fetchGitHubDefaultBranch(fetchImpl, repo);
      if (defaultBranch) {
        fallbackRefs.add(defaultBranch);
      }
    } catch {
      // Fall back to conventional default branches when repo metadata is unavailable.
    }
  }
  fallbackRefs.add("main");
  fallbackRefs.add("master");
  return [...fallbackRefs];
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
    (plugin) => plugin.id === candidatePluginId && plugin.enabled,
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
  const sameIdPlugins = catalog.plugins.filter((plugin) => plugin.id === candidate.pluginId);
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
