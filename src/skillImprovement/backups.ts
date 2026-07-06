import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
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

export function backupKeyForSkill(skillName: string, sourceRootDir: string): string {
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

export function resolveGlobalSkillShadowRoot(config: AgentConfig, skillName: string): string {
  const projectSkillsDir = path.join(config.projectCoworkDir, "skills");
  const builtInSkillsDir = path.join(config.builtInDir, "skills");
  const globalSkillsDir =
    config.skillsDirs.find((skillsDir) => {
      const resolved = path.resolve(skillsDir);
      return (
        resolved !== path.resolve(projectSkillsDir) && resolved !== path.resolve(builtInSkillsDir)
      );
    }) ?? path.join(config.userCoworkDir, "skills");
  return path.join(globalSkillsDir, skillName);
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
  const now = input.now ?? new Date();
  const sourceRootDir = path.resolve(input.installation.rootDir);
  const backupKey = backupKeyForSkill(input.installation.name, sourceRootDir);
  const backupRootDir = path.join(input.store.rootDir, "originals", backupKey);
  const existingState = await input.store.read();
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
  store: SkillImprovementJobStore;
  backup: SkillImprovementBackupRecord;
}): Promise<void> {
  if (input.backup.restoreMode === "delete-shadow") {
    if (input.backup.shadowRootDir) {
      await fs.rm(input.backup.shadowRootDir, { recursive: true, force: true });
    }
    return;
  }

  await fs.rm(input.backup.sourceRootDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(input.backup.sourceRootDir), { recursive: true });
  await fs.cp(input.backup.backupRootDir, input.backup.sourceRootDir, {
    recursive: true,
    preserveTimestamps: true,
  });
}
