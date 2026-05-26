import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseGitHubUrl } from "../extensions/github";
import {
  buildDescriptorFromGitHubSource,
  expandHomeDir,
  type FetchLike,
  materializeGitHubDirectorySource,
  resolveGitHubOrLocalSource,
  trimSlashes,
} from "../extensions/source";
import type {
  SkillCatalogSnapshot,
  SkillInstallationDiagnostic,
  SkillInstallPreview,
  SkillInstallPreviewCandidate,
  SkillMutationTargetScope,
  SkillSourceDescriptor,
  SkillSourceInputKind,
} from "../types";

type GitHubSkillSourceDescriptor = Omit<SkillSourceDescriptor, "kind"> & {
  kind: Exclude<SkillSourceInputKind, "skills.sh">;
};

type MaterializableGitHubSkillSourceDescriptor = Omit<SkillSourceDescriptor, "kind"> & {
  kind: Exclude<SkillSourceInputKind, "local_path">;
};

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
    return buildDescriptorFromGitHubSource<GitHubSkillSourceDescriptor>(trimmed, githubUrl);
  }

  return resolveGitHubOrLocalSource<GitHubSkillSourceDescriptor>(trimmed, cwd);
}

async function materializeGitHubSource(
  descriptor: MaterializableGitHubSkillSourceDescriptor,
  fetchImpl: FetchLike,
): Promise<MaterializedSkillSource> {
  const materialized = await materializeGitHubDirectorySource<
    MaterializableGitHubSkillSourceDescriptor,
    MaterializedSkillCandidate
  >({
    descriptor,
    fetchImpl,
    tmpPrefix: "cowork-skill-source-",
    normalizeTreePath: (directoryPath) => directoryPath,
    normalizeFileDirectoryPath: (filePath) => path.posix.dirname(filePath),
    extra: (source) =>
      source.requestedSkillName ? { requestedSkillName: source.requestedSkillName } : {},
    loadCandidates: async (stageRoot, source) =>
      await loadMaterializedSkillCandidates(stageRoot, source),
  });
  const filteredCandidates = descriptor.requestedSkillName
    ? materialized.candidates.filter(
        (candidate) => candidate.name === descriptor.requestedSkillName,
      )
    : materialized.candidates;
  return {
    ...materialized,
    candidates: filteredCandidates,
  };
}

function isMaterializableGitHubSkillSourceDescriptor(
  descriptor: SkillSourceDescriptor,
): descriptor is MaterializableGitHubSkillSourceDescriptor {
  return descriptor.kind !== "local_path";
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
  if (!isMaterializableGitHubSkillSourceDescriptor(descriptor)) {
    throw new Error(`Unsupported skill source kind: ${descriptor.kind}`);
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
