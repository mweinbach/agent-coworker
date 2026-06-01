import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pluginManifestPathsForPluginRoot } from "../plugins/manifest";
import { replacePluginInstallRoot } from "../plugins/operations";
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

export const WORKSPACE_TOOLS_PLUGIN_ID = "workspace-tools";

type WorkspaceToolsSkillPlan = {
  spec: SkillSourceSpec;
  source?: string;
  destination: string;
  status: CodexPrimaryRuntimeSkillResult["status"];
  action: "copy" | "preserve" | "omit";
  reason?: string;
};

type WorkspaceToolsCopyPlan = WorkspaceToolsSkillPlan & { action: "copy"; source: string };

const LEGACY_RUNTIME_SKILL_TARGETS: Record<
  (typeof LEGACY_CODEX_RUNTIME_SKILLS)[number],
  CodexRuntimeSkillName
> = {
  doc: "documents",
  slides: "presentations",
  spreadsheet: "spreadsheets",
};

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

async function writeWorkspaceToolsPluginManifest(pluginRoot: string): Promise<void> {
  const manifestDir = path.join(pluginRoot, ".cowork-plugin");
  await fs.mkdir(manifestDir, { recursive: true });
  await fs.writeFile(
    path.join(manifestDir, "plugin.json"),
    `${JSON.stringify(
      {
        name: WORKSPACE_TOOLS_PLUGIN_ID,
        version: "0.1.0",
        description:
          "Create, edit, analyze, and verify documents, presentations, and spreadsheets.",
        author: { name: "Cowork" },
        license: "UNLICENSED",
        keywords: [
          "workspace-tools",
          "documents",
          "docx",
          "presentations",
          "pptx",
          "spreadsheets",
          "xlsx",
          "csv",
        ],
        skills: "./skills/",
        interface: {
          displayName: "Workspace Tools",
          shortDescription: "Create and edit documents, presentations, and spreadsheets",
          longDescription:
            "A bundled productivity plugin with document, presentation, and spreadsheet skills for creating, editing, analyzing, and visually verifying workspace artifacts.",
          developerName: "Cowork",
          category: "Productivity",
          capabilities: ["Read", "Write", "Analyze"],
          defaultPrompt: ["Create or update a document, presentation, or spreadsheet artifact."],
          brandColor: "#2563EB",
          screenshots: [],
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(manifestDir, "install.json"),
    `${JSON.stringify(
      {
        bootstrap: {
          name: "codex-primary-runtime",
          source: CODEX_CURATED_PLUGINS_EXPORT_URL,
          pluginId: WORKSPACE_TOOLS_PLUGIN_ID,
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

function normalizeSkillMarkdownName(raw: string, name: string): string {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return raw;

  const frontMatter = match[1] ?? "";
  const nextFrontMatter = /^name\s*:/m.test(frontMatter)
    ? frontMatter.replace(/^name\s*:.*$/m, `name: ${name}`)
    : `name: ${name}\n${frontMatter}`;
  return raw.replace(match[0], `---\n${nextFrontMatter}\n---`);
}

async function normalizeInstalledSkillName(skillRoot: string, name: string): Promise<void> {
  const skillFile = path.join(skillRoot, "SKILL.md");
  const raw = await fs.readFile(skillFile, "utf-8").catch(() => null);
  if (!raw) return;

  const nextRaw = normalizeSkillMarkdownName(raw, name);
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

// Shared by both the global-skill install path and the Workspace Tools plugin
// build: a bootstrap-managed destination may be overwritten when forced, when it
// does not yet exist, or when it is an older bootstrap install; an up-to-date
// current-runtime install is preserved.
async function shouldOverwriteBootstrapSkill(
  destination: string,
  spec: SkillSourceSpec,
  force: boolean,
  source?: string | null,
): Promise<boolean> {
  if (force) return true;
  if (!(await pathExists(destination))) return true;
  const manifest = await readSkillInstallManifest(destination);
  if (
    isCurrentRuntimeSkillManifest(manifest, spec) &&
    (await pathExists(path.join(destination, "SKILL.md")))
  ) {
    if (source && (await pathExists(path.join(source, "SKILL.md")))) {
      const [sourceSkill, installedSkill] = await Promise.all([
        fs.readFile(path.join(source, "SKILL.md"), "utf-8"),
        fs.readFile(path.join(destination, "SKILL.md"), "utf-8"),
      ]);
      if (normalizeSkillMarkdownName(sourceSkill, spec.name) !== installedSkill) return true;
    }
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

function isManagedCurrentRuntimeSkillManifest(
  manifest: Awaited<ReturnType<typeof readSkillInstallManifest>>,
  skillName: CodexRuntimeSkillName,
): boolean {
  const spec = CODEX_RUNTIME_SKILLS.find((entry) => entry.name === skillName);
  return spec ? isCurrentRuntimeSkillManifest(manifest, spec) : false;
}

export async function removeLegacyRuntimeSkills(opts: {
  destinationRoot?: string;
  global: boolean;
  runtimeSkillNames?: ReadonlySet<CodexRuntimeSkillName>;
  log?: (line: string) => void;
}): Promise<void> {
  if (!opts.destinationRoot) return;

  for (const skillName of LEGACY_CODEX_RUNTIME_SKILLS) {
    const targetSkillName = LEGACY_RUNTIME_SKILL_TARGETS[skillName];
    if (opts.runtimeSkillNames && !opts.runtimeSkillNames.has(targetSkillName)) continue;

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

export async function removeManagedRuntimeSkills(opts: {
  destinationRoot?: string;
  runtimeSkillNames?: ReadonlySet<CodexRuntimeSkillName>;
  log?: (line: string) => void;
}): Promise<void> {
  if (!opts.destinationRoot) return;

  for (const spec of CODEX_RUNTIME_SKILLS) {
    if (opts.runtimeSkillNames && !opts.runtimeSkillNames.has(spec.name)) continue;

    const destination = path.join(opts.destinationRoot, spec.name);
    if (!(await pathExists(destination))) continue;
    const manifest = await readSkillInstallManifest(destination);
    if (!isManagedCurrentRuntimeSkillManifest(manifest, spec.name)) continue;

    opts.log?.(`Removing managed Codex ${spec.name} skill from ${destination}`);
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
    ? await shouldOverwriteBootstrapSkill(destination, opts.spec, opts.force, opts.source)
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
    const source = await resolveRuntimeSkillSource({
      home: opts.home,
      runtimeRoots: opts.runtimeRoots,
      curatedRepoRoot: opts.curatedRepoRoot,
      spec,
    });
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

function workspaceToolsDestination(pluginRoot: string, spec: SkillSourceSpec): string {
  return path.join(pluginRoot, "skills", spec.name);
}

async function workspaceToolsPluginManifestExists(pluginRoot: string): Promise<boolean> {
  for (const manifestPath of pluginManifestPathsForPluginRoot(pluginRoot)) {
    if (await pathExists(manifestPath)) {
      return true;
    }
  }
  return false;
}

// Resolve a curated runtime skill's source directory, preferring an explicit
// curated repo checkout, then any discovered runtime root, then the plugin cache.
// Shared by the global-skill installer and the Workspace Tools plugin build.
async function resolveRuntimeSkillSource(opts: {
  home: string;
  runtimeRoots: readonly string[];
  curatedRepoRoot?: string;
  spec: SkillSourceSpec;
}): Promise<string | null> {
  return (
    (opts.curatedRepoRoot &&
    (await pathExists(
      path.join(skillSourceFromCuratedRepo(opts.curatedRepoRoot, opts.spec), "SKILL.md"),
    ))
      ? skillSourceFromCuratedRepo(opts.curatedRepoRoot, opts.spec)
      : null) ??
    (await findFirstRuntimeSkillSource(opts.runtimeRoots, opts.spec)) ??
    (await skillSourceFromPluginCache(opts.home, opts.spec))
  );
}

function workspaceToolsResultFromPlan(
  plan: WorkspaceToolsSkillPlan,
): CodexPrimaryRuntimeSkillResult {
  return {
    name: plan.spec.name,
    status: plan.status,
    ...(plan.source ? { source: plan.source } : {}),
    destination: plan.destination,
    ...(plan.reason ? { reason: plan.reason } : {}),
  };
}

async function writeWorkspaceToolsSkillIntoPluginSource(opts: {
  pluginRoot: string;
  plan: WorkspaceToolsCopyPlan;
  log?: (line: string) => void;
}): Promise<void> {
  const destination = workspaceToolsDestination(opts.pluginRoot, opts.plan.spec);
  opts.log?.(`Staging Codex ${opts.plan.spec.name} skill for Workspace Tools plugin`);
  await copyDirectory(opts.plan.source, destination);
  await normalizeInstalledSkillName(destination, opts.plan.spec.name);
  await writeSkillInstallManifest({
    skillRoot: destination,
    installationId: expectedBootstrapInstallationId(opts.plan.spec.name),
    origin: {
      kind: "bootstrap",
      url: CODEX_CURATED_PLUGINS_EXPORT_URL,
      subdir: expectedBootstrapOriginSubdir(opts.plan.spec),
    },
  });
}

async function buildWorkspaceToolsPluginSource(opts: {
  stageRoot: string;
  existingPluginRoot: string;
  plans: WorkspaceToolsSkillPlan[];
  log?: (line: string) => void;
}): Promise<string> {
  const pluginRoot = path.join(opts.stageRoot, WORKSPACE_TOOLS_PLUGIN_ID);
  if (await pathExists(opts.existingPluginRoot)) {
    await copyDirectory(opts.existingPluginRoot, pluginRoot);
  }
  await writeWorkspaceToolsPluginManifest(pluginRoot);
  for (const plan of opts.plans.filter(
    (plan): plan is WorkspaceToolsCopyPlan => plan.action === "copy" && !!plan.source,
  )) {
    await writeWorkspaceToolsSkillIntoPluginSource({
      pluginRoot,
      plan,
      log: opts.log,
    });
  }
  return pluginRoot;
}

export async function installWorkspaceToolsPlugin(opts: {
  home: string;
  runtimeRoots: readonly string[];
  pluginsDir?: string;
  force: boolean;
  skip: boolean;
  curatedRepoRoot?: string;
  log?: (line: string) => void;
}): Promise<CodexPrimaryRuntimeSkillResult[]> {
  const pluginRoot = opts.pluginsDir
    ? path.join(opts.pluginsDir, WORKSPACE_TOOLS_PLUGIN_ID)
    : undefined;
  if (!pluginRoot) return [];

  if (opts.skip) {
    return CODEX_RUNTIME_SKILLS.map((spec) => ({
      name: spec.name,
      status: "skipped",
      destination: workspaceToolsDestination(pluginRoot, spec),
      reason: "Workspace Tools plugin was removed by the user.",
    }));
  }

  const plans: WorkspaceToolsSkillPlan[] = [];
  for (const spec of CODEX_RUNTIME_SKILLS) {
    const source = await resolveRuntimeSkillSource({
      home: opts.home,
      runtimeRoots: opts.runtimeRoots,
      curatedRepoRoot: opts.curatedRepoRoot,
      spec,
    });
    const destination = workspaceToolsDestination(pluginRoot, spec);
    const overwrite = await shouldOverwriteBootstrapSkill(destination, spec, opts.force, source);
    if (!overwrite) {
      plans.push({
        spec,
        status: "already_installed",
        ...(source ? { source } : {}),
        destination,
        action: "preserve",
      });
      continue;
    }

    if (!source) {
      plans.push({
        spec,
        status: "missing",
        destination,
        action: "omit",
        reason: "No source found.",
      });
      continue;
    }
    if (!(await pathExists(path.join(source, "SKILL.md")))) {
      plans.push({ spec, status: "missing", source, destination, action: "omit" });
      continue;
    }

    plans.push({
      spec,
      status: "installed",
      source,
      destination,
      action: "copy",
    });
  }

  const shouldReplacePlugin =
    plans.some((plan) => plan.action === "copy") ||
    (plans.some((plan) => plan.action === "preserve") &&
      !(await workspaceToolsPluginManifestExists(pluginRoot)));

  if (shouldReplacePlugin) {
    const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-workspace-tools-plugin-"));
    try {
      const sourcePluginRoot = await buildWorkspaceToolsPluginSource({
        stageRoot,
        existingPluginRoot: pluginRoot,
        plans,
        log: opts.log,
      });
      opts.log?.(`Installing Workspace Tools plugin into ${pluginRoot}`);
      await replacePluginInstallRoot({
        sourceRoot: sourcePluginRoot,
        destinationRoot: pluginRoot,
        conflictingRoots: [pluginRoot],
      });
    } finally {
      await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  return plans.map(workspaceToolsResultFromPlan);
}

export async function skillSourceFromPluginCacheForProbe(
  home: string,
  spec: SkillSourceSpec,
): Promise<string | null> {
  return skillSourceFromPluginCache(home, spec);
}
