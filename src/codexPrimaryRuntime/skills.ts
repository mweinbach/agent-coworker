import fs from "node:fs/promises";
import path from "node:path";
import { readSkillInstallManifest, writeSkillInstallManifest } from "../skills/manifest";
import {
  CODEX_CURATED_PLUGINS_EXPORT_URL,
  CODEX_RUNTIME_SKILLS,
  LEGACY_CODEX_RUNTIME_SKILLS,
} from "./constants";
import { codexPluginCacheRoot } from "./runtimeDiscovery";
import { pathExists } from "./state";
import type {
  CodexPrimaryRuntimeSkillResult,
  CodexRuntimeSkillName,
  SkillSourceSpec,
} from "./types";

async function sortedChildDirs(parent: string): Promise<string[]> {
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parent, entry.name))
    .sort((a, b) => path.basename(b).localeCompare(path.basename(a), undefined, { numeric: true }));
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true, verbatimSymlinks: false });
}

async function normalizeInstalledSkillName(skillRoot: string, name: string): Promise<void> {
  const skillFile = path.join(skillRoot, "SKILL.md");
  const raw = await fs.readFile(skillFile, "utf-8").catch(() => null);
  if (!raw) return;

  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return;

  const frontMatter = match[1] ?? "";
  const nextFrontMatter = /^name\s*:/m.test(frontMatter)
    ? frontMatter.replace(/^name\s*:.*$/m, `name: ${name}`)
    : `name: ${name}\n${frontMatter}`;
  const nextRaw = raw.replace(match[0], `---\n${nextFrontMatter}\n---`);
  await fs.writeFile(skillFile, nextRaw, "utf-8");
}

function skillSourceFromCuratedRepo(repoRoot: string, spec: SkillSourceSpec): string {
  return path.join(
    repoRoot,
    "plugins",
    "openai-primary-runtime",
    "plugins",
    spec.pluginName,
    "skills",
    spec.sourceSkillName,
  );
}

async function skillSourceFromPluginCache(
  home: string,
  spec: SkillSourceSpec,
): Promise<string | null> {
  const pluginRoot = path.join(codexPluginCacheRoot(home), spec.pluginName);
  for (const versionDir of await sortedChildDirs(pluginRoot)) {
    const candidate = path.join(versionDir, "skills", spec.sourceSkillName);
    if (await pathExists(path.join(candidate, "SKILL.md"))) return candidate;
  }
  return null;
}

async function skillSourceFromRuntimeRoot(
  root: string,
  spec: SkillSourceSpec,
): Promise<string | null> {
  const candidate = path.join(
    root,
    "plugins",
    "openai-primary-runtime",
    "plugins",
    spec.pluginName,
    "skills",
    spec.sourceSkillName,
  );
  return (await pathExists(path.join(candidate, "SKILL.md"))) ? candidate : null;
}

async function findFirstRuntimeSkillSource(
  runtimeRoots: readonly string[],
  spec: SkillSourceSpec,
): Promise<string | null> {
  for (const runtimeRoot of runtimeRoots) {
    const source = await skillSourceFromRuntimeRoot(runtimeRoot, spec);
    if (source) return source;
  }
  return null;
}

function expectedBootstrapInstallationId(name: CodexRuntimeSkillName): string {
  return `bootstrap-codex-primary-runtime-${name}`;
}

function expectedBootstrapOriginSubdir(spec: SkillSourceSpec): string {
  return `plugins/openai-primary-runtime/plugins/${spec.pluginName}/skills/${spec.sourceSkillName}`;
}

function isCurrentRuntimeSkillManifest(
  manifest: Awaited<ReturnType<typeof readSkillInstallManifest>>,
  spec: SkillSourceSpec,
): boolean {
  return (
    manifest?.origin?.kind === "bootstrap" &&
    manifest.installationId === expectedBootstrapInstallationId(spec.name) &&
    manifest.origin.url === CODEX_CURATED_PLUGINS_EXPORT_URL &&
    manifest.origin.subdir === expectedBootstrapOriginSubdir(spec)
  );
}

async function shouldOverwriteGlobalSkill(
  destination: string,
  spec: SkillSourceSpec,
  force: boolean,
): Promise<boolean> {
  if (force) return true;
  if (!(await pathExists(destination))) return true;
  const manifest = await readSkillInstallManifest(destination);
  if (
    isCurrentRuntimeSkillManifest(manifest, spec) &&
    (await pathExists(path.join(destination, "SKILL.md")))
  ) {
    return false;
  }
  return manifest?.origin?.kind === "bootstrap";
}

function isManagedLegacyRuntimeSkillManifest(
  manifest: Awaited<ReturnType<typeof readSkillInstallManifest>>,
  skillName: (typeof LEGACY_CODEX_RUNTIME_SKILLS)[number],
): boolean {
  if (manifest?.origin?.kind !== "bootstrap") return false;
  if (
    manifest.installationId === `bootstrap-${skillName}` ||
    manifest.installationId === `bootstrap-codex-primary-runtime-${skillName}`
  ) {
    return true;
  }

  const subdir = manifest.origin.subdir ?? "";
  const url = manifest.origin.url ?? "";
  return (
    subdir === `skills/.curated/${skillName}` ||
    subdir.endsWith(`/skills/.curated/${skillName}`) ||
    subdir.endsWith(`/skills/${skillName}`) ||
    url.includes(`/skills/.curated/${skillName}`)
  );
}

export async function removeLegacyRuntimeSkills(opts: {
  destinationRoot?: string;
  global: boolean;
  log?: (line: string) => void;
}): Promise<void> {
  if (!opts.destinationRoot) return;

  for (const skillName of LEGACY_CODEX_RUNTIME_SKILLS) {
    const destination = path.join(opts.destinationRoot, skillName);
    if (!(await pathExists(destination))) continue;

    if (opts.global) {
      const manifest = await readSkillInstallManifest(destination);
      if (!isManagedLegacyRuntimeSkillManifest(manifest, skillName)) continue;
    }

    opts.log?.(`Removing legacy Codex ${skillName} skill from ${destination}`);
    await fs.rm(destination, { recursive: true, force: true });
  }
}

async function installSkill(opts: {
  spec: SkillSourceSpec;
  source: string | null;
  destinationRoot: string;
  global: boolean;
  force: boolean;
  log?: (line: string) => void;
}): Promise<CodexPrimaryRuntimeSkillResult> {
  const destination = path.join(opts.destinationRoot, opts.spec.name);
  if (!opts.source) {
    return { name: opts.spec.name, status: "missing", destination, reason: "No source found." };
  }
  if (!(await pathExists(path.join(opts.source, "SKILL.md")))) {
    return { name: opts.spec.name, status: "missing", source: opts.source, destination };
  }

  const overwrite = opts.global
    ? await shouldOverwriteGlobalSkill(destination, opts.spec, opts.force)
    : opts.force || !(await pathExists(destination));
  if (!overwrite) {
    return { name: opts.spec.name, status: "already_installed", source: opts.source, destination };
  }

  opts.log?.(`Installing Codex ${opts.spec.name} skill into ${destination}`);
  await copyDirectory(opts.source, destination);
  await normalizeInstalledSkillName(destination, opts.spec.name);
  if (opts.global) {
    await writeSkillInstallManifest({
      skillRoot: destination,
      installationId: `bootstrap-codex-primary-runtime-${opts.spec.name}`,
      origin: {
        kind: "bootstrap",
        url: CODEX_CURATED_PLUGINS_EXPORT_URL,
        subdir: expectedBootstrapOriginSubdir(opts.spec),
      },
    });
  }

  return { name: opts.spec.name, status: "installed", source: opts.source, destination };
}

export async function installSkills(opts: {
  home: string;
  runtimeRoots: readonly string[];
  destinationRoot?: string;
  global: boolean;
  force: boolean;
  curatedRepoRoot?: string;
  log?: (line: string) => void;
}): Promise<CodexPrimaryRuntimeSkillResult[]> {
  if (!opts.destinationRoot) return [];
  const results: CodexPrimaryRuntimeSkillResult[] = [];
  for (const spec of CODEX_RUNTIME_SKILLS) {
    const source =
      (opts.curatedRepoRoot &&
      (await pathExists(
        path.join(skillSourceFromCuratedRepo(opts.curatedRepoRoot, spec), "SKILL.md"),
      ))
        ? skillSourceFromCuratedRepo(opts.curatedRepoRoot, spec)
        : null) ??
      (await findFirstRuntimeSkillSource(opts.runtimeRoots, spec)) ??
      (await skillSourceFromPluginCache(opts.home, spec));
    results.push(
      await installSkill({
        spec,
        source,
        destinationRoot: opts.destinationRoot,
        global: opts.global,
        force: opts.force,
        log: opts.log,
      }),
    );
  }
  return results;
}

export async function skillSourceFromPluginCacheForProbe(
  home: string,
  spec: SkillSourceSpec,
): Promise<string | null> {
  return skillSourceFromPluginCache(home, spec);
}
