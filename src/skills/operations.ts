import fs from "node:fs/promises";
import path from "node:path";

import type {
  AgentConfig,
  SkillCatalogSnapshot,
  SkillInstallOrigin,
  SkillInstallPreview,
  SkillInstallationEntry,
  SkillMutationTargetScope,
  SkillUpdateCheckResult,
} from "../types";
import { getInstallationById, getSkillScopeDescriptors, scanSkillCatalog } from "./catalog";
import { createManagedInstallationId, adoptSkillInstallManifest, writeSkillInstallManifest } from "./manifest";
import { buildSkillInstallPreview, materializeSkillSource, resolveSkillSource } from "./sourceResolver";

type WritableScopePaths = {
  scope: SkillMutationTargetScope;
  skillsDir: string;
  disabledSkillsDir: string;
};

function requireWritableScope(config: AgentConfig, scope: SkillMutationTargetScope): WritableScopePaths {
  const descriptor = getSkillScopeDescriptors(config.skillsDirs).find((entry) => entry.scope === scope);
  if (!descriptor || !descriptor.disabledSkillsDir || !descriptor.writable) {
    throw new Error(`Writable scope "${scope}" is not configured`);
  }

  return {
    scope,
    skillsDir: descriptor.skillsDir,
    disabledSkillsDir: descriptor.disabledSkillsDir,
  };
}

function originFromDescriptor(descriptor: SkillInstallPreview["source"]): SkillInstallOrigin {
  switch (descriptor.kind) {
    case "skills.sh":
      return {
        kind: "skills.sh",
        ...(descriptor.url ? { url: descriptor.url } : {}),
        ...(descriptor.repo ? { repo: descriptor.repo } : {}),
        ...(descriptor.ref ? { ref: descriptor.ref } : {}),
        ...(descriptor.subdir ? { subdir: descriptor.subdir } : {}),
      };
    case "github_repo":
    case "github_tree":
    case "github_blob":
    case "github_raw":
    case "github_shorthand":
      return {
        kind: "github",
        ...(descriptor.url ? { url: descriptor.url } : {}),
        ...(descriptor.repo ? { repo: descriptor.repo } : {}),
        ...(descriptor.ref ? { ref: descriptor.ref } : {}),
        ...(descriptor.subdir ? { subdir: descriptor.subdir } : {}),
      };
    case "local_path":
      return {
        kind: "local",
        ...(descriptor.localPath ? { sourcePath: descriptor.localPath } : {}),
      };
  }
}

async function removeConflictingTargets(paths: WritableScopePaths, skillName: string): Promise<void> {
  await fs.rm(path.join(paths.skillsDir, skillName), { recursive: true, force: true });
  await fs.rm(path.join(paths.disabledSkillsDir, skillName), { recursive: true, force: true });
}

async function copySkillRoot(sourceRoot: string, destinationRoot: string): Promise<void> {
  await fs.mkdir(path.dirname(destinationRoot), { recursive: true });
  await fs.cp(sourceRoot, destinationRoot, {
    recursive: true,
    force: true,
    errorOnExist: false,
  });
}

function installSourceFromOrigin(installation: SkillInstallationEntry): string | null {
  const origin = installation.origin;
  if (!origin) {
    return null;
  }

  if ((origin.kind === "skills.sh" || origin.kind === "github" || origin.kind === "bootstrap") && origin.url) {
    return origin.url;
  }

  if ((origin.kind === "github" || origin.kind === "bootstrap") && origin.repo) {
    if (origin.subdir && origin.ref) {
      return `https://github.com/${origin.repo}/tree/${origin.ref}/${origin.subdir}`;
    }
    if (origin.ref) {
      return `https://github.com/${origin.repo}/tree/${origin.ref}`;
    }
    return `https://github.com/${origin.repo}`;
  }

  if (origin.kind === "local" && origin.sourcePath) {
    return origin.sourcePath;
  }

  return null;
}

async function refreshCatalog(config: AgentConfig): Promise<SkillCatalogSnapshot> {
  return await scanSkillCatalog(config.skillsDirs, { includeDisabled: true });
}

type NamedUpdateCandidate = {
  name: string;
  diagnostics: Array<{ message: string }>;
};

function resolveRecordedUpdateCandidate<T extends NamedUpdateCandidate>(
  candidates: T[],
  installationName: string,
): { candidate: T | null; reason: string | null } {
  const matchingCandidates = candidates.filter((candidate) => candidate.name === installationName);
  const validCandidate = matchingCandidates.find((candidate) => candidate.diagnostics.length === 0) ?? null;
  if (validCandidate) {
    return { candidate: validCandidate, reason: null };
  }

  if (matchingCandidates.length === 0) {
    return {
      candidate: null,
      reason: `Recorded skill "${installationName}" was not found in the update source.`,
    };
  }

  const diagnosticMessages = [...new Set(
    matchingCandidates.flatMap((candidate) =>
      candidate.diagnostics
        .map((diagnostic) => diagnostic.message.trim())
        .filter((message) => message.length > 0)
    )
  )];

  return {
    candidate: null,
    reason: diagnosticMessages.length > 0
      ? `Recorded skill "${installationName}" exists in the update source but is not a valid skill installation. ${diagnosticMessages.join(" ")}`
      : `Recorded skill "${installationName}" exists in the update source but is not a valid skill installation.`,
  };
}

export async function installSkillsFromSource(opts: {
  config: AgentConfig;
  input: string;
  targetScope: SkillMutationTargetScope;
}): Promise<{ preview: SkillInstallPreview; installationIds: string[]; catalog: SkillCatalogSnapshot }> {
  const currentCatalog = await refreshCatalog(opts.config);
  const preview = await buildSkillInstallPreview({
    input: opts.input,
    targetScope: opts.targetScope,
    catalog: currentCatalog,
    cwd: opts.config.workingDirectory,
  });

  const writableScope = requireWritableScope(opts.config, opts.targetScope);
  const materialized = await materializeSkillSource({
    input: opts.input,
    cwd: opts.config.workingDirectory,
  });

  try {
    const validCandidates = materialized.candidates.filter((candidate) => candidate.diagnostics.length === 0);
    if (validCandidates.length === 0) {
      throw new Error("No valid skill installations were found in the provided source");
    }

    const origin = originFromDescriptor(materialized.descriptor);
    const installedIds: string[] = [];
    for (const candidate of validCandidates) {
      const destinationRoot = path.join(writableScope.skillsDir, candidate.name);
      await removeConflictingTargets(writableScope, candidate.name);
      await copySkillRoot(candidate.rootDir, destinationRoot);
      const manifest = await writeSkillInstallManifest({
        skillRoot: destinationRoot,
        installationId: createManagedInstallationId(),
        origin,
      });
      installedIds.push(manifest.installationId);
    }

    return {
      preview,
      installationIds: installedIds,
      catalog: await refreshCatalog(opts.config),
    };
  } finally {
    await materialized.cleanup();
  }
}

export async function copySkillInstallationToScope(opts: {
  config: AgentConfig;
  installation: SkillInstallationEntry;
  targetScope: SkillMutationTargetScope;
}): Promise<{ installationId: string; catalog: SkillCatalogSnapshot }> {
  const writableScope = requireWritableScope(opts.config, opts.targetScope);
  if (!opts.installation.skillPath) {
    throw new Error(`Installation "${opts.installation.installationId}" has no readable SKILL.md`);
  }

  const destinationRoot = path.join(writableScope.skillsDir, opts.installation.name);
  await removeConflictingTargets(writableScope, opts.installation.name);
  await copySkillRoot(opts.installation.rootDir, destinationRoot);
  const manifest = await writeSkillInstallManifest({
    skillRoot: destinationRoot,
    installationId: createManagedInstallationId(),
    origin: opts.installation.origin,
  });

  return {
    installationId: manifest.installationId,
    catalog: await refreshCatalog(opts.config),
  };
}

export async function disableSkillInstallation(opts: {
  config: AgentConfig;
  installation: SkillInstallationEntry;
}): Promise<SkillCatalogSnapshot> {
  if (!opts.installation.writable) {
    throw new Error("This installation is read-only and cannot be disabled directly");
  }
  if (!opts.installation.enabled) {
    return await refreshCatalog(opts.config);
  }

  const writableScope = requireWritableScope(opts.config, opts.installation.scope as SkillMutationTargetScope);
  const destinationRoot = path.join(writableScope.disabledSkillsDir, opts.installation.name);
  const manifest = await adoptSkillInstallManifest({
    skillRoot: opts.installation.rootDir,
    fallbackInstallationId: opts.installation.installationId,
    origin: opts.installation.origin,
  });

  await fs.mkdir(writableScope.disabledSkillsDir, { recursive: true });
  await fs.rm(destinationRoot, { recursive: true, force: true });
  await fs.rename(opts.installation.rootDir, destinationRoot);
  await writeSkillInstallManifest({
    skillRoot: destinationRoot,
    installationId: manifest.installationId,
    installedAt: manifest.installedAt,
    origin: manifest.origin,
  });

  return await refreshCatalog(opts.config);
}

export async function enableSkillInstallation(opts: {
  config: AgentConfig;
  installation: SkillInstallationEntry;
}): Promise<SkillCatalogSnapshot> {
  if (!opts.installation.writable) {
    throw new Error("This installation is read-only and cannot be enabled directly");
  }
  if (opts.installation.enabled) {
    return await refreshCatalog(opts.config);
  }

  const writableScope = requireWritableScope(opts.config, opts.installation.scope as SkillMutationTargetScope);
  const destinationRoot = path.join(writableScope.skillsDir, opts.installation.name);
  const manifest = await adoptSkillInstallManifest({
    skillRoot: opts.installation.rootDir,
    fallbackInstallationId: opts.installation.installationId,
    origin: opts.installation.origin,
  });

  await fs.mkdir(writableScope.skillsDir, { recursive: true });
  await fs.rm(destinationRoot, { recursive: true, force: true });
  await fs.rename(opts.installation.rootDir, destinationRoot);
  await writeSkillInstallManifest({
    skillRoot: destinationRoot,
    installationId: manifest.installationId,
    installedAt: manifest.installedAt,
    origin: manifest.origin,
  });

  return await refreshCatalog(opts.config);
}

export async function deleteSkillInstallation(opts: {
  config: AgentConfig;
  installation: SkillInstallationEntry;
}): Promise<SkillCatalogSnapshot> {
  if (!opts.installation.writable) {
    throw new Error("This installation is read-only and cannot be deleted directly");
  }

  await fs.rm(opts.installation.rootDir, { recursive: true, force: true });
  return await refreshCatalog(opts.config);
}

export async function checkSkillInstallationUpdate(opts: {
  config: AgentConfig;
  installation: SkillInstallationEntry;
}): Promise<SkillUpdateCheckResult> {
  if (!opts.installation.writable) {
    return {
      installationId: opts.installation.installationId,
      canUpdate: false,
      reason: "This installation is read-only.",
    };
  }

  const input = installSourceFromOrigin(opts.installation);
  if (!input) {
    return {
      installationId: opts.installation.installationId,
      canUpdate: false,
      reason: "No update source is recorded for this installation.",
    };
  }

  const preview = await buildSkillInstallPreview({
    input,
    targetScope: opts.installation.scope as SkillMutationTargetScope,
    catalog: await refreshCatalog(opts.config),
    cwd: opts.config.workingDirectory,
  });
  const resolvedCandidate = resolveRecordedUpdateCandidate(preview.candidates, opts.installation.name);
  if (!resolvedCandidate.candidate) {
    return {
      installationId: opts.installation.installationId,
      canUpdate: false,
      reason: resolvedCandidate.reason ?? `No valid update candidate was found for "${opts.installation.name}".`,
      preview,
    };
  }

  return {
    installationId: opts.installation.installationId,
    canUpdate: true,
    preview,
  };
}

export async function updateSkillInstallation(opts: {
  config: AgentConfig;
  installation: SkillInstallationEntry;
}): Promise<{ preview: SkillInstallPreview; catalog: SkillCatalogSnapshot }> {
  if (!opts.installation.writable) {
    throw new Error("This installation is read-only and cannot be updated directly");
  }

  const input = installSourceFromOrigin(opts.installation);
  if (!input) {
    throw new Error("No update source is recorded for this installation");
  }

  const writableScope = requireWritableScope(opts.config, opts.installation.scope as SkillMutationTargetScope);
  const materialized = await materializeSkillSource({
    input,
    cwd: opts.config.workingDirectory,
  });

  try {
    const preview = await buildSkillInstallPreview({
      input,
      targetScope: opts.installation.scope as SkillMutationTargetScope,
      catalog: await refreshCatalog(opts.config),
      cwd: opts.config.workingDirectory,
      materialized,
    });
    const resolvedCandidate = resolveRecordedUpdateCandidate(materialized.candidates, opts.installation.name);
    const selectedCandidate = resolvedCandidate.candidate;
    if (!selectedCandidate) {
      throw new Error(resolvedCandidate.reason ?? `No valid update candidate was found for "${opts.installation.name}"`);
    }

    const destinationBase = opts.installation.enabled ? writableScope.skillsDir : writableScope.disabledSkillsDir;
    const destinationRoot = path.join(destinationBase, opts.installation.name);
    await removeConflictingTargets(writableScope, opts.installation.name);
    await copySkillRoot(selectedCandidate.rootDir, destinationRoot);
    await writeSkillInstallManifest({
      skillRoot: destinationRoot,
      installationId: opts.installation.installationId,
      installedAt: opts.installation.installedAt,
      origin: originFromDescriptor(materialized.descriptor),
    });

    return {
      preview,
      catalog: await refreshCatalog(opts.config),
    };
  } finally {
    await materialized.cleanup();
  }
}

export async function getInstallationForMutation(opts: {
  config: AgentConfig;
  installationId: string;
}): Promise<SkillInstallationEntry> {
  const catalog = await refreshCatalog(opts.config);
  const installation = getInstallationById(catalog, opts.installationId);
  if (!installation) {
    throw new Error(`Skill installation "${opts.installationId}" was not found`);
  }
  return installation;
}

export function resolveRecordedInstallSource(installation: SkillInstallationEntry): string | null {
  return installSourceFromOrigin(installation);
}

export async function getSkillCatalog(config: AgentConfig): Promise<SkillCatalogSnapshot> {
  return await refreshCatalog(config);
}

export async function getSkillInstallationById(opts: {
  config: AgentConfig;
  installationId: string;
}): Promise<SkillInstallationEntry | null> {
  const catalog = await refreshCatalog(opts.config);
  return getInstallationById(catalog, opts.installationId);
}

export function resolveSourceDescriptorForInstallInput(input: string, cwd = process.cwd()) {
  return resolveSkillSource(input, cwd);
}
