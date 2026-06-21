import fs from "node:fs/promises";
import path from "node:path";

import { coworkRuntimeRoot } from "./install";

const LEGACY_SKILL_NAMES = ["documents", "presentations", "spreadsheets"] as const;
const CLEANUP_MARKER = "legacy-cleanup-v2.json";

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function removeManagedWorkspaceToolsPlugin(home: string): Promise<string | null> {
  const pluginRoot = path.join(home, ".cowork", "plugins", "workspace-tools");
  const metadata = await readJson(path.join(pluginRoot, ".cowork-plugin", "install.json"));
  const bootstrap = metadata?.bootstrap;
  if (typeof bootstrap !== "object" || bootstrap === null || Array.isArray(bootstrap)) return null;
  const record = bootstrap as Record<string, unknown>;
  if (record.name !== "codex-primary-runtime" || record.pluginId !== "workspace-tools") return null;
  await fs.rm(pluginRoot, { recursive: true, force: true });
  return pluginRoot;
}

async function removeManagedRuntimeSkills(home: string): Promise<string[]> {
  const removed: string[] = [];
  for (const name of LEGACY_SKILL_NAMES) {
    const skillRoot = path.join(home, ".cowork", "skills", name);
    const metadata = await readJson(path.join(skillRoot, ".cowork-skill.json"));
    const installationId = metadata?.installationId;
    const origin = metadata?.origin;
    const bootstrapOrigin =
      typeof origin === "object" &&
      origin !== null &&
      !Array.isArray(origin) &&
      (origin as Record<string, unknown>).kind === "bootstrap";
    if (
      !bootstrapOrigin ||
      (installationId !== `bootstrap-${name}` &&
        installationId !== `bootstrap-codex-primary-runtime-${name}`)
    ) {
      continue;
    }
    await fs.rm(skillRoot, { recursive: true, force: true });
    removed.push(skillRoot);
  }
  return removed;
}

export async function cleanupLegacyCoworkRuntimes(opts: {
  home: string;
  log?: (line: string) => void;
}): Promise<string[]> {
  const home = path.resolve(opts.home);
  const markerPath = path.join(coworkRuntimeRoot(home), CLEANUP_MARKER);
  if (await fs.stat(markerPath).catch(() => null)) return [];

  const removed: string[] = [];
  for (const target of [
    path.join(home, ".cache", "cowork", "artifact-runtime"),
    path.join(home, ".cache", "cowork", "libreoffice"),
    path.join(home, ".cowork", "config", "artifact-runtime.json"),
    path.join(home, ".cowork", "config", "codex-primary-runtime.json"),
  ]) {
    if (await fs.stat(target).catch(() => null)) {
      await fs.rm(target, { recursive: true, force: true });
      removed.push(target);
    }
  }

  const pluginRoot = await removeManagedWorkspaceToolsPlugin(home);
  if (pluginRoot) removed.push(pluginRoot);
  removed.push(...(await removeManagedRuntimeSkills(home)));

  await fs.mkdir(path.dirname(markerPath), { recursive: true });
  await fs.writeFile(
    markerPath,
    `${JSON.stringify({ schemaVersion: 1, completedAt: new Date().toISOString(), removed }, null, 2)}\n`,
    "utf8",
  );
  for (const target of removed) opts.log?.(`Removed legacy Cowork runtime state at ${target}`);
  return removed;
}
