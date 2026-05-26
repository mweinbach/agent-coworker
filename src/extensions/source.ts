import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildGitHubApiUrl,
  downloadGitHubDirectory,
  type FetchLike,
  fetchGitHubContent,
  fetchGitHubFile,
  githubHeaders,
  type ParsedGitHubSource,
  parseGitHubShorthand,
  parseGitHubUrl,
} from "../skills/github";

export type { FetchLike };

export const BUILT_IN_MARKETPLACE_REPO = "mweinbach/cowork-skills-plugins";
export const BUILT_IN_MARKETPLACE_REF = "main";
export const BUILT_IN_MARKETPLACE_PATH = ".agents/plugins/marketplace.json";
export const BUILT_IN_MARKETPLACE_URL = `https://github.com/${BUILT_IN_MARKETPLACE_REPO}/tree/${BUILT_IN_MARKETPLACE_REF}`;
export const DEFAULT_MARKETPLACE_PLUGIN_IDS = ["workspace-tools"] as const;

export type ExtensionSourceInputKind =
  | "github_repo"
  | "github_tree"
  | "github_blob"
  | "github_raw"
  | "github_shorthand"
  | "local_path";

export interface ExtensionSourceDescriptor {
  kind: ExtensionSourceInputKind;
  raw: string;
  displaySource: string;
  url?: string;
  repo?: string;
  ref?: string;
  subdir?: string;
  refPath?: string;
  localPath?: string;
}

export type MaterializedExtensionSource<TDescriptor, TCandidate> = {
  descriptor: TDescriptor;
  candidates: TCandidate[];
  cleanup: () => Promise<void>;
};

type GitHubMaterializationAttempt<TDescriptor> = {
  ref: string;
  githubPath: string;
  descriptor: TDescriptor;
};

export function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

export function expandHomeDir(input: string): string {
  if (!input.startsWith("~")) {
    return input;
  }
  const remainder = input.slice(1).replace(/^[/\\]+/, "");
  return path.join(os.homedir(), remainder);
}

export function buildDescriptorFromGitHubSource<TDescriptor extends ExtensionSourceDescriptor>(
  raw: string,
  parsed: ParsedGitHubSource,
  extra?: Partial<TDescriptor>,
): TDescriptor {
  const kindBySource: Record<ParsedGitHubSource["kind"], ExtensionSourceDescriptor["kind"]> = {
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
    ...(extra ?? {}),
  } as TDescriptor;
}

export function resolveGitHubOrLocalSource<TDescriptor extends ExtensionSourceDescriptor>(
  input: string,
  cwd = process.cwd(),
): TDescriptor {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Extension source is required");
  }

  const githubUrl = parseGitHubUrl(trimmed);
  if (githubUrl) {
    return buildDescriptorFromGitHubSource<TDescriptor>(trimmed, githubUrl);
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
      } as TDescriptor;
    }
    return {
      kind: "github_shorthand",
      raw: trimmed,
      displaySource: githubShorthand.url,
      url: githubShorthand.url,
      repo: githubShorthand.repo,
    } as TDescriptor;
  }

  const localPath = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, expandHomeDir(trimmed));
  return {
    kind: "local_path",
    raw: trimmed,
    displaySource: localPath,
    localPath,
  } as TDescriptor;
}

export function buildResolvedGitHubDescriptor<TDescriptor extends ExtensionSourceDescriptor>(
  descriptor: TDescriptor,
  ref: string | undefined,
  githubPath: string,
  extra?: Partial<TDescriptor>,
): TDescriptor {
  return {
    kind: descriptor.kind,
    raw: descriptor.raw,
    displaySource: descriptor.displaySource,
    ...(descriptor.url ? { url: descriptor.url } : {}),
    ...(descriptor.repo ? { repo: descriptor.repo } : {}),
    ...(ref ? { ref } : {}),
    ...(githubPath ? { subdir: githubPath } : {}),
    ...(descriptor.localPath ? { localPath: descriptor.localPath } : {}),
    ...(extra ?? {}),
  } as TDescriptor;
}

export function buildGitHubMaterializationAttempts<TDescriptor extends ExtensionSourceDescriptor>(
  descriptor: TDescriptor,
  opts: {
    normalizeTreePath: (directoryPath: string) => string;
    normalizeFileDirectoryPath: (filePath: string) => string;
    extra?: (descriptor: TDescriptor) => Partial<TDescriptor>;
  },
): Array<GitHubMaterializationAttempt<TDescriptor>> {
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
  const attempts: Array<GitHubMaterializationAttempt<TDescriptor>> = [];
  for (let splitAt = refPathSegments.length - minimumTrailingSegments; splitAt >= 1; splitAt -= 1) {
    const ref = refPathSegments.slice(0, splitAt).join("/");
    const trailingPath = refPathSegments.slice(splitAt).join("/");
    const githubPath =
      descriptor.kind === "github_tree"
        ? opts.normalizeTreePath(trailingPath)
        : trailingPath
          ? opts.normalizeFileDirectoryPath(trailingPath)
          : "";
    const normalizedPath = githubPath === "." ? "" : githubPath;

    attempts.push({
      ref,
      githubPath: normalizedPath,
      descriptor: buildResolvedGitHubDescriptor(
        descriptor,
        ref,
        normalizedPath,
        opts.extra?.(descriptor),
      ),
    });
  }

  return attempts;
}

export function dedupeGitHubMaterializationAttempts<TDescriptor>(
  attempts: Array<GitHubMaterializationAttempt<TDescriptor>>,
): Array<GitHubMaterializationAttempt<TDescriptor>> {
  return attempts.filter(
    (attempt, index, allAttempts) =>
      allAttempts.findIndex(
        (candidate) => candidate.ref === attempt.ref && candidate.githubPath === attempt.githubPath,
      ) === index,
  );
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

export async function resolveAmbiguousGitHubMaterializationAttempts<TDescriptor>(
  repo: string,
  attempts: Array<GitHubMaterializationAttempt<TDescriptor>>,
  fetchImpl: FetchLike,
): Promise<Array<GitHubMaterializationAttempt<TDescriptor>>> {
  const uniqueAttempts = dedupeGitHubMaterializationAttempts(attempts);
  const checkedRefs = new Map<string, boolean>();
  const existingAttempts: Array<GitHubMaterializationAttempt<TDescriptor>> = [];

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

export async function resolveGitHubFallbackRefs(opts: {
  repo?: string;
  fetchImpl: FetchLike;
  includeRemoteDefaultBranch?: boolean;
}): Promise<string[]> {
  const fallbackRefs = new Set<string>();
  if (opts.repo && opts.includeRemoteDefaultBranch) {
    try {
      const defaultBranch = await fetchGitHubDefaultBranch(opts.fetchImpl, opts.repo);
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

export async function materializeGitHubDirectorySource<
  TDescriptor extends ExtensionSourceDescriptor,
  TCandidate,
>(opts: {
  descriptor: TDescriptor;
  fetchImpl: FetchLike;
  tmpPrefix: string;
  normalizeTreePath: (directoryPath: string) => string;
  normalizeFileDirectoryPath: (filePath: string) => string;
  shouldSkipPreferredAttempt?: (descriptor: TDescriptor) => boolean;
  includeRemoteDefaultBranch?: boolean;
  extra?: (descriptor: TDescriptor) => Partial<TDescriptor>;
  loadCandidates: (stageRoot: string, descriptor: TDescriptor) => Promise<TCandidate[]>;
}): Promise<MaterializedExtensionSource<TDescriptor, TCandidate>> {
  const descriptor = opts.descriptor;
  if (!descriptor.repo) {
    throw new Error("GitHub source is missing repo information");
  }

  const shouldSkipPreferredAttempt = opts.shouldSkipPreferredAttempt?.(descriptor) ?? false;
  const preferredGitHubPath =
    descriptor.kind === "github_tree"
      ? opts.normalizeTreePath(descriptor.subdir ?? "")
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
              opts.extra?.(descriptor),
            ),
          },
        ]
      : [];
  const attempts = buildGitHubMaterializationAttempts(descriptor, {
    normalizeTreePath: opts.normalizeTreePath,
    normalizeFileDirectoryPath: opts.normalizeFileDirectoryPath,
    extra: opts.extra,
  });
  const fallbackRefs = descriptor.ref
    ? [descriptor.ref]
    : await resolveGitHubFallbackRefs({
        repo: descriptor.repo,
        fetchImpl: opts.fetchImpl,
        includeRemoteDefaultBranch: opts.includeRemoteDefaultBranch,
      });
  const fallbackAttempts = fallbackRefs.map((ref) => {
    const githubPath =
      descriptor.kind === "github_tree"
        ? opts.normalizeTreePath(descriptor.subdir ?? "")
        : (descriptor.subdir ?? "");
    return {
      ref,
      githubPath,
      descriptor: buildResolvedGitHubDescriptor(
        descriptor,
        ref,
        githubPath,
        opts.extra?.(descriptor),
      ),
    };
  });
  const materializationAttempts = dedupeGitHubMaterializationAttempts(
    attempts.length > 0
      ? opts.includeRemoteDefaultBranch
        ? await resolveAmbiguousGitHubMaterializationAttempts(
            descriptor.repo,
            attempts,
            opts.fetchImpl,
          )
        : [...preferredAttempt, ...attempts]
      : [...preferredAttempt, ...fallbackAttempts],
  );
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), opts.tmpPrefix));
  let resolvedDescriptor: TDescriptor | null = null;
  let resolvedCandidates: TCandidate[] | null = null;
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
            fetchImpl: opts.fetchImpl,
            repo: descriptor.repo,
            ref: attempt.ref,
            githubPath: attempt.githubPath,
            destDir: destination,
          });
          stageRoot = destination;
        } else {
          await downloadGitHubDirectory({
            fetchImpl: opts.fetchImpl,
            repo: descriptor.repo,
            ref: attempt.ref,
            githubPath: "",
            destDir: repoRoot,
          });
          stageRoot = repoRoot;
        }
        resolvedCandidates = await opts.loadCandidates(stageRoot, attempt.descriptor);
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

export async function fetchGitHubTextFile(opts: {
  fetchImpl: FetchLike;
  repo: string;
  ref: string;
  githubPath: string;
}): Promise<string> {
  const content = await fetchGitHubContent(opts.fetchImpl, opts.repo, opts.ref, opts.githubPath);
  if (Array.isArray(content) || content.type !== "file" || !content.download_url) {
    throw new Error(
      `GitHub API returned a non-file payload for ${opts.repo}/${opts.githubPath}@${opts.ref}`,
    );
  }
  return (await fetchGitHubFile(opts.fetchImpl, content.download_url)).toString("utf-8");
}

export function marketplacePluginSourceInput(opts: {
  repo: string;
  ref: string;
  sourcePath: string;
}): string {
  return `https://github.com/${opts.repo}/tree/${opts.ref}/${trimSlashes(opts.sourcePath)}`;
}
