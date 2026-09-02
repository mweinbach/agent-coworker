import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { replacePluginInstallRoot } from "../plugins/operations";
import { getSkillScopeDescriptors } from "../skills/catalog";
import type { AgentConfig, SkillInstallationEntry } from "../types";
import type { SkillImprovementJobStore } from "./JobStore";
import type { SkillImprovementBackupRecord } from "./types";

function sanitizeSegment(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "skill";
}

function backupKeyForSkill(skillName: string, sourceRootDir: string): string {
  const digest = createHash("sha256")
    .update(path.resolve(sourceRootDir))
    .digest("hex")
    .slice(0, 16);
  return `${sanitizeSegment(skillName)}-${digest}`;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function resolveGlobalSkillShadowRoot(config: AgentConfig, skillName: string): string {
  const globalSkillsDir =
    getSkillScopeDescriptors(config.skillsDirs).find((descriptor) => descriptor.scope === "global")
      ?.skillsDir ?? path.join(config.userCoworkDir, "skills");
  return path.join(globalSkillsDir, skillName);
}

export function skillImprovementWriteRestriction(
  installation: SkillInstallationEntry,
): string | undefined {
  if (installation.plugin) return "Plugin-owned skills are read-only and cannot be improved.";
  if (!installation.writable && installation.scope !== "built-in") {
    return "This skill installation is read-only and cannot be improved.";
  }
  return undefined;
}

export async function prepareSkillImprovementTarget(input: {
  config: AgentConfig;
  store: SkillImprovementJobStore;
  installation: SkillInstallationEntry;
  now?: Date;
}): Promise<{
  backup: SkillImprovementBackupRecord;
  targetRootDir: string;
  targetSkillPath: string;
}> {
  const restriction = skillImprovementWriteRestriction(input.installation);
  if (restriction) throw new Error(restriction);
  const now = input.now ?? new Date();
  const sourceRootDir = path.resolve(input.installation.rootDir);
  const existingState = await input.store.read();

  // Improving a shadow copy we created earlier (a previously improved built-in
  // that now resolves as the effective global skill) must reuse the original
  // delete-shadow backup. Registering a second copy-back backup of the already
  // improved shadow would make restore recreate the improved copy right after
  // deleting it.
  const shadowOwner = Object.values(existingState.backups).find(
    (record) =>
      record.restoreMode === "delete-shadow" &&
      record.shadowRootDir &&
      path.resolve(record.shadowRootDir) === sourceRootDir,
  );
  if (shadowOwner) {
    return {
      backup: shadowOwner,
      targetRootDir: sourceRootDir,
      targetSkillPath: input.installation.skillPath ?? path.join(sourceRootDir, "SKILL.md"),
    };
  }

  const backupKey = backupKeyForSkill(input.installation.name, sourceRootDir);
  const backupRootDir = path.join(input.store.rootDir, "originals", backupKey);
  let backup = existingState.backups[backupKey];

  if (!backup) {
    await fs.mkdir(path.dirname(backupRootDir), { recursive: true });
    if (!(await pathExists(backupRootDir))) {
      await fs.cp(sourceRootDir, backupRootDir, { recursive: true, preserveTimestamps: true });
    }
  }

  let targetRootDir = sourceRootDir;
  let targetSkillPath = input.installation.skillPath ?? path.join(targetRootDir, "SKILL.md");
  let restoreMode: SkillImprovementBackupRecord["restoreMode"] = "copy-back";
  let shadowRootDir: string | undefined;

  if (input.installation.scope === "built-in") {
    shadowRootDir = resolveGlobalSkillShadowRoot(input.config, input.installation.name);
    restoreMode = "delete-shadow";
    if (!(await pathExists(shadowRootDir))) {
      await fs.mkdir(path.dirname(shadowRootDir), { recursive: true });
      await fs.cp(sourceRootDir, shadowRootDir, { recursive: true, preserveTimestamps: true });
    }
    targetRootDir = shadowRootDir;
    targetSkillPath = path.join(targetRootDir, "SKILL.md");
  }

  backup = {
    key: backupKey,
    skillName: input.installation.name,
    sourceRootDir,
    backupRootDir,
    createdAt: backup?.createdAt ?? now.toISOString(),
    restoreMode,
    ...(shadowRootDir ? { shadowRootDir } : {}),
  };
  await input.store.registerBackup(backup);

  return { backup, targetRootDir, targetSkillPath };
}

export async function restoreSkillImprovementBackup(input: {
  backup: SkillImprovementBackupRecord;
}): Promise<void> {
  if (input.backup.restoreMode === "delete-shadow") {
    if (input.backup.shadowRootDir) {
      await fs.rm(input.backup.shadowRootDir, { recursive: true, force: true });
    }
    return;
  }

  // Verify the stored copy exists BEFORE deleting the live skill — otherwise a
  // manually cleaned originals/ directory would turn restore into deletion.
  if (!(await pathExists(path.join(input.backup.backupRootDir, "SKILL.md")))) {
    throw new Error(
      `Backup for "${input.backup.skillName}" is missing at ${input.backup.backupRootDir}; the skill was left unchanged.`,
    );
  }
  await replacePluginInstallRoot({
    sourceRoot: input.backup.backupRootDir,
    destinationRoot: input.backup.sourceRootDir,
    conflictingRoots: [],
  });
}

/** Remove the stored original (and its sidecar) once a backup record is retired. */
export async function deleteSkillImprovementBackupArtifacts(input: {
  store: SkillImprovementJobStore;
  backup: SkillImprovementBackupRecord;
}): Promise<void> {
  await fs.rm(input.backup.backupRootDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(input.store.backupMetaPath(input.backup.key), { force: true }).catch(() => {});
}

/**
 * Per-run rollback snapshot. Unlike the originals/ backup (which always holds
 * the pre-first-improvement state for user-facing restore), this captures the
 * directory exactly as it was before ONE run, so a failed run rolls back only
 * its own changes instead of reverting every prior improvement or manual edit.
 */
export async function createPrerunSnapshot(input: {
  store: SkillImprovementJobStore;
  key: string;
  targetRootDir: string;
}): Promise<string> {
  const parentDir = path.join(input.store.rootDir, "prerun");
  await fs.mkdir(parentDir, { recursive: true });
  const snapshotDir = await fs.mkdtemp(path.join(parentDir, `${input.key}-`));
  try {
    await fs.cp(input.targetRootDir, snapshotDir, { recursive: true, preserveTimestamps: true });
  } catch (error) {
    await fs.rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return snapshotDir;
}

export async function restorePrerunSnapshot(input: {
  snapshotDir: string;
  targetRootDir: string;
}): Promise<void> {
  if (!(await pathExists(path.join(input.snapshotDir, "SKILL.md")))) {
    throw new Error(`Pre-run snapshot at ${input.snapshotDir} is missing; rollback skipped.`);
  }
  await replacePluginInstallRoot({
    sourceRoot: input.snapshotDir,
    destinationRoot: input.targetRootDir,
    conflictingRoots: [],
  });
}

export async function discardPrerunSnapshot(snapshotDir: string): Promise<void> {
  await fs.rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
}
