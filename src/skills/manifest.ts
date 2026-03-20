import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { SkillInstallManifest, SkillInstallOrigin, SkillScope } from "../types";
import { writeTextFileAtomic } from "../utils/atomicFile";

export const SKILL_INSTALL_MANIFEST_FILENAME = ".cowork-skill.json";

const skillInstallOriginSchema = z.object({
  kind: z.enum(["github", "skills.sh", "local", "manual", "bootstrap", "unknown"]),
  url: z.string().optional(),
  repo: z.string().optional(),
  ref: z.string().optional(),
  subdir: z.string().optional(),
  sourcePath: z.string().optional(),
  sourceHash: z.string().optional(),
}).strict();

const skillInstallManifestSchema = z.object({
  version: z.literal(1),
  installationId: z.string().trim().min(1),
  installedAt: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1),
  origin: skillInstallOriginSchema.optional(),
}).strict();

export function manifestPathForSkillRoot(skillRoot: string): string {
  return path.join(skillRoot, SKILL_INSTALL_MANIFEST_FILENAME);
}

export function createManagedInstallationId(): string {
  return crypto.randomUUID();
}

export function deriveFallbackInstallationId(scope: SkillScope, scopeAnchorDir: string, skillName: string): string {
  const seed = `${scope}\u0000${path.resolve(scopeAnchorDir)}\u0000${skillName.trim().toLowerCase()}`;
  const digest = crypto.createHash("sha256").update(seed).digest("hex");
  return `adopted-${digest.slice(0, 24)}`;
}

export async function readSkillInstallManifest(skillRoot: string): Promise<SkillInstallManifest | null> {
  try {
    const raw = await fs.readFile(manifestPathForSkillRoot(skillRoot), "utf-8");
    const parsed = JSON.parse(raw);
    const validated = skillInstallManifestSchema.safeParse(parsed);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

export async function writeSkillInstallManifest(opts: {
  skillRoot: string;
  installationId: string;
  installedAt?: string;
  updatedAt?: string;
  origin?: SkillInstallOrigin;
}): Promise<SkillInstallManifest> {
  const current = await readSkillInstallManifest(opts.skillRoot);
  const now = new Date().toISOString();
  const manifest: SkillInstallManifest = {
    version: 1,
    installationId: opts.installationId,
    installedAt: opts.installedAt ?? current?.installedAt ?? now,
    updatedAt: opts.updatedAt ?? now,
    ...(opts.origin !== undefined
      ? { origin: opts.origin }
      : current?.origin !== undefined
        ? { origin: current.origin }
        : {}),
  };

  await fs.mkdir(opts.skillRoot, { recursive: true });
  await writeTextFileAtomic(
    manifestPathForSkillRoot(opts.skillRoot),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

export async function adoptSkillInstallManifest(opts: {
  skillRoot: string;
  fallbackInstallationId: string;
  origin?: SkillInstallOrigin;
}): Promise<SkillInstallManifest> {
  const existing = await readSkillInstallManifest(opts.skillRoot);
  if (existing) {
    return existing;
  }

  return await writeSkillInstallManifest({
    skillRoot: opts.skillRoot,
    installationId: opts.fallbackInstallationId,
    origin: opts.origin,
  });
}
