import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FetchLike } from "../extensions/source";
import { computeSourceRootHash } from "../extensions/sourceFingerprint";
import {
  buildPluginCatalogSnapshot,
  replacePluginInstallRoot,
  setPluginSkillEnabled,
} from "../plugins";
import { fetchConfiguredMarketplaces } from "../plugins/marketplaceRegistry";
import { buildRemoteMarketplaceSkillCatalogEntry } from "../plugins/remoteMarketplace";
import type {
  AgentConfig,
  MarketplaceSkillCatalogEntry,
  SkillCatalogSnapshot,
  SkillInstallationEntry,
  SkillInstallOrigin,
  SkillInstallPreview,
  SkillMutationTargetScope,
  SkillUpdateCheckResult,
} from "../types";
import { workspacePathOverlaps } from "../utils/workspacePath";
import {
  getInstallationById,
  getSkillScopeDescriptors,
  scanSkillCatalogFromSources,
} from "./catalog";
import { isSkillVisibleInCatalog } from "./featureGates";
import {
  adoptSkillInstallManifest,
  createManagedInstallationId,
  writeSkillInstallManifest,
} from "./manifest";
import { buildSkillInstallPreview, materializeSkillSource } from "./sourceResolver";

type WritableScopePaths = {
  scope: SkillMutationTargetScope;
  skillsDir: string;
  disabledSkillsDir: string;
};

function requireWritableScope(
  config: AgentConfig,
  scope: SkillMutationTargetScope,
): WritableScopePaths {
  const descriptor = getSkillScopeDescriptors(config.skillsDirs).find(
    (entry) => entry.scope === scope,
  );
  if (!descriptor?.disabledSkillsDir || !descriptor.writable) {
    throw new Error(`Writable scope "${scope}" is not configured`);
  }

  return {
    scope,
    skillsDir: descriptor.skillsDir,
    disabledSkillsDir: descriptor.disabledSkillsDir,
  };
}

function conflictingTargetRoots(paths: WritableScopePaths, skillName: string): string[] {
  return [path.join(paths.skillsDir, skillName), path.join(paths.disabledSkillsDir, skillName)];
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

async function copySkillRoot(sourceRoot: string, destinationRoot: string): Promise<void> {
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
): Promise<{
  sourceRoot: string;
  cleanup: () => Promise<void>;
}> {
  const overlapsConflict = conflictingTargets.some((targetRoot) =>
    workspacePathOverlaps(sourceRoot, targetRoot),
  );
  if (!overlapsConflict) {
    return {
      sourceRoot,
      cleanup: async () => {},
    };
  }

  const stageDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-coworker-skill-stage-"));
  const stagedRoot = path.join(stageDir, path.basename(sourceRoot));
  await copySkillRoot(sourceRoot, stagedRoot);
  return {
    sourceRoot: stagedRoot,
    cleanup: async () => {
      await fs.rm(stageDir, { recursive: true, force: true });
    },
  };
}

function installSourceFromOrigin(installation: SkillInstallationEntry): string | null {
  const origin = installation.origin;
  if (!origin) {
    return null;
  }

  if (
    (origin.kind === "skills.sh" || origin.kind === "github" || origin.kind === "bootstrap") &&
    origin.url
  ) {
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

function normalizeInstallSourceInput(input: string | null | undefined): string | null {
  const normalized = input?.trim().replace(/\/+$/g, "") ?? "";
  return normalized.length > 0 ? normalized : null;
}

async function refreshCatalog(config: AgentConfig): Promise<SkillCatalogSnapshot> {
  const pluginCatalog = await buildPluginCatalogSnapshot(config);
  const catalog = await scanSkillCatalogFromSources(
    [
      ...getSkillScopeDescriptors(config.skillsDirs).map((descriptor) => ({
        kind: "standalone" as const,
        descriptor,
      })),
      ...pluginCatalog.plugins.flatMap((plugin) =>
        plugin.skills.map((skill) => ({
          kind: "plugin" as const,
          plugin,
          skill,
          enabled: skill.enabled,
        })),
      ),
    ],
    { includeDisabled: true },
  );
  // Feature-owned built-in skills (task mode, advanced memory) are backend
  // services; they never surface in the user-facing management catalog.
  return {
    ...catalog,
    installations: catalog.installations.filter((installation) =>
      isSkillVisibleInCatalog(config, installation),
    ),
    effectiveSkills: catalog.effectiveSkills.filter((installation) =>
      isSkillVisibleInCatalog(config, installation),
    ),
  };
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
  const validCandidates = matchingCandidates.filter(
    (candidate) => candidate.diagnostics.length === 0,
  );
  if (validCandidates.length === 1) {
    return { candidate: validCandidates[0] ?? null, reason: null };
  }

  if (validCandidates.length > 1) {
    return {
      candidate: null,
      reason: `The update source contains more than one valid skill named "${installationName}". Split the source or remove duplicates so each skill name is unique.`,
    };
  }

  if (matchingCandidates.length === 0) {
    return {
      candidate: null,
      reason: `Recorded skill "${installationName}" was not found in the update source.`,
    };
  }

  const diagnosticMessages = [
    ...new Set(
      matchingCandidates.flatMap((candidate) =>
        candidate.diagnostics
          .map((diagnostic) => diagnostic.message.trim())
          .filter((message) => message.length > 0),
      ),
    ),
  ];

  return {
    candidate: null,
    reason:
      diagnosticMessages.length > 0
        ? `Recorded skill "${installationName}" exists in the update source but is not a valid skill installation. ${diagnosticMessages.join(" ")}`
        : `Recorded skill "${installationName}" exists in the update source but is not a valid skill installation.`,
  };
}

export async function installSkillsFromSource(opts: {
  config: AgentConfig;
  input: string;
  targetScope: SkillMutationTargetScope;
}): Promise<{
  preview: SkillInstallPreview;
  installationIds: string[];
  catalog: SkillCatalogSnapshot;
}> {
  const currentCatalog = await refreshCatalog(opts.config);
  const materialized = await materializeSkillSource({
    input: opts.input,
    cwd: opts.config.workingDirectory,
  });

  try {
    const preview = await buildSkillInstallPreview({
      input: opts.input,
      targetScope: opts.targetScope,
      catalog: currentCatalog,
      cwd: opts.config.workingDirectory,
      materialized,
    });
    const writableScope = requireWritableScope(opts.config, opts.targetScope);
    const validCandidates = materialized.candidates.filter(
      (candidate) => candidate.diagnostics.length === 0,
    );
    if (validCandidates.length === 0) {
      throw new Error("No valid skill installations were found in the provided source");
    }

    const seenNames = new Set<string>();
    for (const candidate of validCandidates) {
      if (seenNames.has(candidate.name)) {
        throw new Error(
          `The install source contains more than one valid skill named "${candidate.name}". Split the source or remove duplicates so each skill name is unique.`,
        );
      }
      seenNames.add(candidate.name);
    }

    const origin = originFromDescriptor(materialized.descriptor);
    const installedIds: string[] = [];
    for (const candidate of validCandidates) {
      const destinationRoot = path.join(writableScope.skillsDir, candidate.name);
      const conflictingRoots = conflictingTargetRoots(writableScope, candidate.name);
      const sourceHash = await computeSourceRootHash(candidate.rootDir);
      const stagedSource = await stageCopySourceIfNeeded(candidate.rootDir, conflictingRoots);
      const installationId = createManagedInstallationId();
      try {
        await replacePluginInstallRoot({
          sourceRoot: stagedSource.sourceRoot,
          destinationRoot,
          conflictingRoots,
          onInstalled: async () => {
            await writeSkillInstallManifest({
              skillRoot: destinationRoot,
              installationId,
              origin: { ...origin, sourceHash },
            });
          },
        });
      } finally {
        await stagedSource.cleanup();
      }
      installedIds.push(installationId);
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
  if (opts.installation.plugin) {
    throw new Error("Plugin-owned skills are read-only and cannot be copied in phase 1.");
  }
  if (opts.installation.scope === opts.targetScope) {
    throw new Error(
      `Cannot copy "${opts.installation.name}" into the ${opts.targetScope} scope because it already lives there; that would delete the source before copying.`,
    );
  }

  const writableScope = requireWritableScope(opts.config, opts.targetScope);
  if (!opts.installation.skillPath) {
    throw new Error(`Installation "${opts.installation.installationId}" has no readable SKILL.md`);
  }

  const destinationRoot = path.join(writableScope.skillsDir, opts.installation.name);
  const conflictingRoots = conflictingTargetRoots(writableScope, opts.installation.name);
  const stagedSource = await stageCopySourceIfNeeded(opts.installation.rootDir, conflictingRoots);
  const installationId = createManagedInstallationId();
  try {
    await replacePluginInstallRoot({
      sourceRoot: stagedSource.sourceRoot,
      destinationRoot,
      conflictingRoots,
      onInstalled: async () => {
        await writeSkillInstallManifest({
          skillRoot: destinationRoot,
          installationId,
          origin: opts.installation.origin,
        });
      },
    });
  } finally {
    await stagedSource.cleanup();
  }

  return {
    installationId,
    catalog: await refreshCatalog(opts.config),
  };
}

export async function disableSkillInstallation(opts: {
  config: AgentConfig;
  installation: SkillInstallationEntry;
}): Promise<SkillCatalogSnapshot> {
  if (opts.installation.plugin) {
    await setPluginSkillEnabled({
      config: opts.config,
      pluginId: opts.installation.plugin.pluginId,
      scope: opts.installation.plugin.scope,
      rawSkillName: opts.installation.name.split(":").slice(1).join(":") || opts.installation.name,
      enabled: false,
    });
    return await refreshCatalog(opts.config);
  }
  if (!opts.installation.writable) {
    throw new Error("This installation is read-only and cannot be disabled directly");
  }
  if (!opts.installation.enabled) {
    return await refreshCatalog(opts.config);
  }

  const writableScope = requireWritableScope(
    opts.config,
    opts.installation.scope as SkillMutationTargetScope,
  );
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
  if (opts.installation.plugin) {
    await setPluginSkillEnabled({
      config: opts.config,
      pluginId: opts.installation.plugin.pluginId,
      scope: opts.installation.plugin.scope,
      rawSkillName: opts.installation.name.split(":").slice(1).join(":") || opts.installation.name,
      enabled: true,
    });
    return await refreshCatalog(opts.config);
  }
  if (!opts.installation.writable) {
    throw new Error("This installation is read-only and cannot be enabled directly");
  }
  if (opts.installation.enabled) {
    return await refreshCatalog(opts.config);
  }

  const writableScope = requireWritableScope(
    opts.config,
    opts.installation.scope as SkillMutationTargetScope,
  );
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
  if (opts.installation.plugin) {
    throw new Error("Plugin-owned skills are read-only and cannot be deleted in phase 1.");
  }
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
  if (opts.installation.plugin) {
    return {
      installationId: opts.installation.installationId,
      canUpdate: false,
      reason: "Plugin-owned skills are read-only in phase 1.",
    };
  }
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
    const resolvedCandidate = resolveRecordedUpdateCandidate(
      materialized.candidates,
      opts.installation.name,
    );
    if (!resolvedCandidate.candidate) {
      return {
        installationId: opts.installation.installationId,
        canUpdate: false,
        reason:
          resolvedCandidate.reason ??
          `No valid update candidate was found for "${opts.installation.name}".`,
        preview,
      };
    }

    const latestSourceHash = await computeSourceRootHash(resolvedCandidate.candidate.rootDir);
    const installedSourceHash = opts.installation.origin?.sourceHash;
    if (installedSourceHash && installedSourceHash === latestSourceHash) {
      return {
        installationId: opts.installation.installationId,
        canUpdate: false,
        reason: "This skill is already up to date.",
        preview,
        installedSourceHash,
        latestSourceHash,
      };
    }

    return {
      installationId: opts.installation.installationId,
      canUpdate: true,
      preview,
      ...(installedSourceHash ? { installedSourceHash } : {}),
      latestSourceHash,
    };
  } finally {
    await materialized.cleanup();
  }
}

export async function updateSkillInstallation(opts: {
  config: AgentConfig;
  installation: SkillInstallationEntry;
}): Promise<{ preview: SkillInstallPreview; catalog: SkillCatalogSnapshot }> {
  if (opts.installation.plugin) {
    throw new Error("Plugin-owned skills are read-only and cannot be updated in phase 1.");
  }
  if (!opts.installation.writable) {
    throw new Error("This installation is read-only and cannot be updated directly");
  }

  const input = installSourceFromOrigin(opts.installation);
  if (!input) {
    throw new Error("No update source is recorded for this installation");
  }

  const writableScope = requireWritableScope(
    opts.config,
    opts.installation.scope as SkillMutationTargetScope,
  );
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
    const resolvedCandidate = resolveRecordedUpdateCandidate(
      materialized.candidates,
      opts.installation.name,
    );
    const selectedCandidate = resolvedCandidate.candidate;
    if (!selectedCandidate) {
      throw new Error(
        resolvedCandidate.reason ??
          `No valid update candidate was found for "${opts.installation.name}"`,
      );
    }

    const destinationBase = opts.installation.enabled
      ? writableScope.skillsDir
      : writableScope.disabledSkillsDir;
    const destinationRoot = path.join(destinationBase, opts.installation.name);
    const conflictingRoots = conflictingTargetRoots(writableScope, opts.installation.name);
    const sourceHash = await computeSourceRootHash(selectedCandidate.rootDir);
    const stagedSource = await stageCopySourceIfNeeded(selectedCandidate.rootDir, conflictingRoots);
    const updateOrigin = originFromDescriptor(materialized.descriptor);
    try {
      await replacePluginInstallRoot({
        sourceRoot: stagedSource.sourceRoot,
        destinationRoot,
        conflictingRoots,
        onInstalled: async () => {
          await writeSkillInstallManifest({
            skillRoot: destinationRoot,
            installationId: opts.installation.installationId,
            installedAt: opts.installation.installedAt,
            origin: { ...updateOrigin, sourceHash },
          });
        },
      });
    } finally {
      await stagedSource.cleanup();
    }

    return {
      preview,
      catalog: await refreshCatalog(opts.config),
    };
  } finally {
    await materialized.cleanup();
  }
}

function annotateMarketplaceSkillUpdates(
  catalog: SkillCatalogSnapshot,
  marketplaceSkills: Array<{
    name: string;
    sourceInput?: string;
    sourceHash?: string;
  }>,
): SkillCatalogSnapshot {
  // Installations are matched against every configured marketplace's skill
  // entries by normalized install source; the first (built-in-first) entry wins.
  const marketplaceBySource = new Map<
    string,
    { name: string; sourceInput?: string; sourceHash?: string }
  >();
  for (const entry of marketplaceSkills) {
    if (!entry.sourceInput || !entry.sourceHash) continue;
    const normalizedSource = normalizeInstallSourceInput(entry.sourceInput);
    if (!normalizedSource || marketplaceBySource.has(normalizedSource)) continue;
    marketplaceBySource.set(normalizedSource, entry);
  }

  const annotatedInstallations = catalog.installations.map((installation) => {
    if (installation.plugin) return installation;
    const installedSource = normalizeInstallSourceInput(installSourceFromOrigin(installation));
    if (!installedSource) return installation;
    const marketplaceEntry = marketplaceBySource.get(installedSource);
    if (!marketplaceEntry?.sourceHash || marketplaceEntry.name !== installation.name) {
      return installation;
    }

    const installedSourceHash = installation.origin?.sourceHash;
    const updateAvailable = installedSourceHash !== marketplaceEntry.sourceHash;
    return {
      ...installation,
      ...(installedSourceHash ? { installedSourceHash } : {}),
      latestSourceHash: marketplaceEntry.sourceHash,
      updateAvailable,
      ...(updateAvailable && !installedSourceHash
        ? { updateCheckReason: "Installed source hash is missing." }
        : {}),
    };
  });
  const byId = new Map(
    annotatedInstallations.map((installation) => [installation.installationId, installation]),
  );
  return {
    ...catalog,
    installations: annotatedInstallations,
    effectiveSkills: catalog.effectiveSkills.map(
      (installation) => byId.get(installation.installationId) ?? installation,
    ),
  };
}

export async function getSkillCatalog(
  config: AgentConfig,
  opts: { includeRemoteMarketplace?: boolean; fetchImpl?: FetchLike } = {},
): Promise<SkillCatalogSnapshot & { remoteMarketplaceFailed?: boolean }> {
  let catalog = await refreshCatalog(config);
  if (!opts.includeRemoteMarketplace) {
    return catalog;
  }
  // Offer marketplace skills that are not already installed (deduped by name);
  // aggregate across every configured marketplace (built-in first).
  try {
    const { marketplaces, failures } = await fetchConfiguredMarketplaces({
      config,
      fetchImpl: opts.fetchImpl,
    });
    catalog = annotateMarketplaceSkillUpdates(
      catalog,
      marketplaces.flatMap(({ document }) => document.skills),
    );
    const installedNames = new Set(catalog.installations.map((entry) => entry.name));
    const availableSkillNames = new Set<string>();
    const availableSkills: MarketplaceSkillCatalogEntry[] = [];
    for (const { document: marketplace } of marketplaces) {
      for (const skillEntry of marketplace.skills) {
        if (
          !skillEntry.sourceInput ||
          installedNames.has(skillEntry.name) ||
          availableSkillNames.has(skillEntry.name)
        ) {
          continue;
        }
        const entry = buildRemoteMarketplaceSkillCatalogEntry({ marketplace, skill: skillEntry });
        if (entry) {
          availableSkills.push(entry);
          availableSkillNames.add(skillEntry.name);
        }
      }
    }
    // Any failed marketplace makes the available list partial so clients keep
    // cached rows, but successfully fetched marketplaces still contribute.
    return {
      ...catalog,
      availableSkills,
      ...(failures.length > 0 ? { remoteMarketplaceFailed: true } : {}),
    };
  } catch {
    // Partial: keep installed skills; signal failure so the client preserves cached rows.
    return { ...catalog, remoteMarketplaceFailed: true };
  }
}

export async function getSkillInstallationById(opts: {
  config: AgentConfig;
  installationId: string;
}): Promise<SkillInstallationEntry | null> {
  const catalog = await refreshCatalog(opts.config);
  return getInstallationById(catalog, opts.installationId);
}
