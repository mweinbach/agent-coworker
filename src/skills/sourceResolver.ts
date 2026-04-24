import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import type {
  SkillCatalogSnapshot,
  SkillInstallationDiagnostic,
  SkillInstallPreview,
  SkillInstallPreviewCandidate,
  SkillMutationTargetScope,
  SkillSourceDescriptor,
} from "../types";
import {
  downloadGitHubDirectory,
  type FetchLike,
  type ParsedGitHubSource,
  parseGitHubShorthand,
  parseGitHubUrl,
} from "./github";

type MaterializedSkillCandidate = {
  rootDir: string;
  name: string;
  description: string;
  diagnostics: SkillInstallationDiagnostic[];
  relativeRootPath: string;
};

export type MaterializedSkillSource = {
  descriptor: SkillSourceDescriptor;
  candidates: MaterializedSkillCandidate[];
  cleanup: () => Promise<void>;
};

const unknownRecordSchema = z.record(z.string(), z.unknown());
const skillFrontMatterSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().trim().min(1).max(1024),
  })
  .passthrough();

const precedenceByScope = new Map([
  ["project", 0],
  ["global", 1],
  ["user", 2],
  ["built-in", 3],
]);

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function buildDiagnostic(
  code: string,
  severity: SkillInstallationDiagnostic["severity"],
  message: string,
): SkillInstallationDiagnostic {
  return { code, severity, message };
}

function splitFrontMatter(raw: string): { frontMatterRaw: string | null; body: string } {
  const re = /^\ufeff?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
  const match = raw.match(re);
  if (!match) {
    return { frontMatterRaw: null, body: raw };
  }
  return {
    frontMatterRaw: match[1] ?? "",
    body: raw.slice(match[0].length),
  };
}

function parseSkillMetadata(
  raw: string,
  expectedDirName: string,
): { name: string; description: string } | null {
  const { frontMatterRaw } = splitFrontMatter(raw);
  if (!frontMatterRaw) {
    return null;
  }

  try {
    const parsed = Bun.YAML.parse(frontMatterRaw);
    const validatedObject = unknownRecordSchema.safeParse(parsed);
    if (!validatedObject.success) {
      return null;
    }

    const validated = skillFrontMatterSchema.safeParse(validatedObject.data);
    if (!validated.success || validated.data.name !== expectedDirName) {
      return null;
    }

    return {
      name: validated.data.name,
      description: validated.data.description,
    };
  } catch {
    return null;
  }
}

function expandHomeDir(input: string): string {
  if (!input.startsWith("~")) {
    return input;
  }
  return path.join(os.homedir(), input.slice(1));
}

async function discoverSkillRoots(rootDir: string): Promise<string[]> {
  const found = new Set<string>();

  async function visit(dir: string): Promise<void> {
    let dirents: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }

    if (dirents.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      found.add(dir);
      return;
    }

    for (const dirent of dirents) {
      if (!dirent.isDirectory()) {
        continue;
      }
      await visit(path.join(dir, dirent.name));
    }
  }

  await visit(rootDir);
  return [...found].sort((left, right) => left.localeCompare(right));
}

async function materializeLocalPath(localPath: string): Promise<MaterializedSkillSource> {
  const absolutePath = path.resolve(expandHomeDir(localPath));
  const stat = await fs.stat(absolutePath);
  const candidateRoot = stat.isFile() ? path.dirname(absolutePath) : absolutePath;
  const descriptor: SkillSourceDescriptor = {
    kind: "local_path",
    raw: localPath,
    displaySource: absolutePath,
    localPath: absolutePath,
  };
  const candidates = await loadMaterializedSkillCandidates(candidateRoot, descriptor);
  return {
    descriptor,
    candidates,
    cleanup: async () => {},
  };
}

function parseSkillsDotSh(raw: string): SkillSourceDescriptor | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.hostname !== "skills.sh" && parsed.hostname !== "www.skills.sh") {
    return null;
  }

  const segments = trimSlashes(parsed.pathname).split("/").filter(Boolean);
  if (segments.length < 2) {
    return null;
  }

  const [owner, repo, requestedSkillName] = segments;
  return {
    kind: "skills.sh",
    raw,
    displaySource: raw,
    url: raw,
    repo: `${owner}/${repo}`,
    ...(requestedSkillName ? { requestedSkillName } : {}),
  };
}

function buildDescriptorFromGitHubSource(
  raw: string,
  parsed: ParsedGitHubSource,
): SkillSourceDescriptor {
  const kindBySource: Record<ParsedGitHubSource["kind"], SkillSourceDescriptor["kind"]> = {
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
  descriptor: SkillSourceDescriptor;
};

function buildResolvedGitHubDescriptor(
  descriptor: SkillSourceDescriptor,
  ref: string | undefined,
  githubPath: string,
): SkillSourceDescriptor {
  return {
    kind: descriptor.kind,
    raw: descriptor.raw,
    displaySource: descriptor.displaySource,
    ...(descriptor.url ? { url: descriptor.url } : {}),
    ...(descriptor.repo ? { repo: descriptor.repo } : {}),
    ...(ref ? { ref } : {}),
    ...(githubPath ? { subdir: githubPath } : {}),
    ...(descriptor.localPath ? { localPath: descriptor.localPath } : {}),
    ...(descriptor.requestedSkillName ? { requestedSkillName: descriptor.requestedSkillName } : {}),
  };
}

function buildGitHubMaterializationAttempts(
  descriptor: SkillSourceDescriptor,
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
        ? trailingPath
        : trailingPath
          ? path.posix.dirname(trailingPath)
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

export function resolveSkillSource(input: string, cwd = process.cwd()): SkillSourceDescriptor {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Skill source is required");
  }

  const skillsDotSh = parseSkillsDotSh(trimmed);
  if (skillsDotSh) {
    return skillsDotSh;
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
  descriptor: SkillSourceDescriptor,
  fetchImpl: FetchLike,
): Promise<MaterializedSkillSource> {
  if (!descriptor.repo) {
    throw new Error("GitHub source is missing repo information");
  }

  const preferredAttempt = descriptor.ref
    ? [
        {
          ref: descriptor.ref,
          githubPath: descriptor.subdir ?? "",
          descriptor: buildResolvedGitHubDescriptor(
            descriptor,
            descriptor.ref,
            descriptor.subdir ?? "",
          ),
        },
      ]
    : [];
  const attempts = buildGitHubMaterializationAttempts(descriptor);
  const fallbackRefs = descriptor.ref ? [descriptor.ref] : ["main", "master"];
  const fallbackAttempts = fallbackRefs.map((ref) => {
    const githubPath = descriptor.subdir ?? "";
    return {
      ref,
      githubPath,
      descriptor: buildResolvedGitHubDescriptor(descriptor, ref, githubPath),
    };
  });
  const materializationAttempts = (
    attempts.length > 0
      ? [...preferredAttempt, ...attempts]
      : [...preferredAttempt, ...fallbackAttempts]
  ).filter(
    (attempt, index, allAttempts) =>
      allAttempts.findIndex(
        (candidate) => candidate.ref === attempt.ref && candidate.githubPath === attempt.githubPath,
      ) === index,
  );
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-skill-source-"));
  let resolvedDescriptor: SkillSourceDescriptor | null = null;
  let stageRoot: string | null = null;
  let lastError: unknown = null;

  try {
    for (const attempt of materializationAttempts) {
      const repoRoot = path.join(tmpRoot, descriptor.repo.split("/").at(-1) ?? "repo");
      try {
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
        resolvedDescriptor = attempt.descriptor;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!stageRoot || !resolvedDescriptor) {
      throw lastError instanceof Error
        ? lastError
        : new Error(String(lastError ?? "Unable to fetch GitHub source"));
    }

    const candidates = await loadMaterializedSkillCandidates(stageRoot, resolvedDescriptor);
    const filteredCandidates = descriptor.requestedSkillName
      ? candidates.filter((candidate) => candidate.name === descriptor.requestedSkillName)
      : candidates;

    return {
      descriptor: resolvedDescriptor,
      candidates: filteredCandidates,
      cleanup: async () => {
        await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch (error) {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function loadMaterializedSkillCandidates(
  stageRoot: string,
  descriptor: SkillSourceDescriptor,
): Promise<MaterializedSkillCandidate[]> {
  const skillRoots = await discoverSkillRoots(stageRoot);
  const candidates: MaterializedSkillCandidate[] = [];
  for (const rootDir of skillRoots) {
    const skillPath = path.join(rootDir, "SKILL.md");
    try {
      const raw = await fs.readFile(skillPath, "utf-8");
      const parsed = parseSkillMetadata(raw, path.basename(rootDir));
      if (!parsed) {
        candidates.push({
          rootDir,
          name: path.basename(rootDir),
          description: "Invalid skill source",
          diagnostics: [
            buildDiagnostic("invalid_frontmatter", "error", "Invalid or missing skill frontmatter"),
          ],
          relativeRootPath: path.relative(stageRoot, rootDir) || path.basename(rootDir),
        });
        continue;
      }

      candidates.push({
        rootDir,
        name: parsed.name,
        description: parsed.description,
        diagnostics: [],
        relativeRootPath: path.relative(stageRoot, rootDir) || path.basename(rootDir),
      });
    } catch (error) {
      candidates.push({
        rootDir,
        name: path.basename(rootDir),
        description: "Unreadable skill source",
        diagnostics: [
          buildDiagnostic(
            "unreadable_skill_md",
            "error",
            `Unable to read SKILL.md: ${String(error)}`,
          ),
        ],
        relativeRootPath: path.relative(stageRoot, rootDir) || path.basename(rootDir),
      });
    }
  }

  if (candidates.length === 0) {
    candidates.push({
      rootDir: stageRoot,
      name: path.basename(stageRoot),
      description: descriptor.displaySource,
      diagnostics: [
        buildDiagnostic("no_skill_found", "error", "No skill roots containing SKILL.md were found"),
      ],
      relativeRootPath: ".",
    });
  }

  return candidates.sort((left, right) =>
    left.relativeRootPath.localeCompare(right.relativeRootPath),
  );
}

export async function materializeSkillSource(opts: {
  input: string;
  cwd?: string;
  fetchImpl?: FetchLike;
}): Promise<MaterializedSkillSource> {
  const descriptor = resolveSkillSource(opts.input, opts.cwd);
  if (descriptor.kind === "local_path") {
    return await materializeLocalPath(descriptor.localPath ?? descriptor.displaySource);
  }
  return await materializeGitHubSource(descriptor, opts.fetchImpl ?? fetch);
}

function wouldCandidateBeEffective(
  candidateName: string,
  targetScope: SkillMutationTargetScope,
  catalog: SkillCatalogSnapshot,
): boolean {
  const currentEffective = catalog.effectiveSkills.find(
    (installation) => installation.name === candidateName,
  );
  if (!currentEffective) {
    return true;
  }

  return (
    (precedenceByScope.get(targetScope) ?? Number.POSITIVE_INFINITY) <=
    (precedenceByScope.get(currentEffective.scope) ?? Number.POSITIVE_INFINITY)
  );
}

function buildPreviewCandidate(
  candidate: MaterializedSkillCandidate,
  targetScope: SkillMutationTargetScope,
  catalog: SkillCatalogSnapshot,
): SkillInstallPreviewCandidate {
  const sameNameInstallations = catalog.installations.filter(
    (installation) => installation.name === candidate.name,
  );
  const targetScopeConflict = sameNameInstallations.find(
    (installation) => installation.scope === targetScope,
  );

  return {
    name: candidate.name,
    description: candidate.description,
    relativeRootPath: candidate.relativeRootPath,
    ...(targetScopeConflict
      ? {
          conflictsWithInstallationId: targetScopeConflict.installationId,
          conflictsWithScope: targetScopeConflict.scope,
        }
      : {}),
    wouldBeEffective: wouldCandidateBeEffective(candidate.name, targetScope, catalog),
    shadowedInstallationIds: sameNameInstallations.map(
      (installation) => installation.installationId,
    ),
    diagnostics: candidate.diagnostics,
  };
}

export async function buildSkillInstallPreview(opts: {
  input: string;
  targetScope: SkillMutationTargetScope;
  catalog: SkillCatalogSnapshot;
  cwd?: string;
  fetchImpl?: FetchLike;
  materialized?: MaterializedSkillSource;
}): Promise<SkillInstallPreview> {
  const materialized =
    opts.materialized ??
    (await materializeSkillSource({
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
      warnings.push("No valid skill installations were found in the provided source.");
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
