import fs from "node:fs/promises";
import path from "node:path";

import type {
  InstalledPluginCatalogEntry,
  SkillCatalogSnapshot,
  SkillEntry,
  SkillInstallationDiagnostic,
  SkillInstallationEntry,
  SkillPluginOwner,
  SkillScope,
  SkillScopeDescriptor,
} from "../types";
import { isPathInside } from "../utils/paths";
import {
  adoptSkillInstallManifest,
  deriveFallbackInstallationId,
  manifestPathForSkillRoot,
  readSkillInstallManifest,
} from "./manifest";
import {
  extractSkillTriggers,
  type ParsedSkillDocument,
  parseSkillDocument,
  readAgentInterface,
} from "./metadata";

type ScanScopeDir = {
  scope: SkillScope;
  writable: boolean;
  skillsDir: string;
  scopeAnchorDir: string;
  enabled: boolean;
};

export type SkillCatalogSource =
  | {
      kind: "standalone";
      descriptor: SkillScopeDescriptor;
    }
  | {
      kind: "plugin";
      plugin: InstalledPluginCatalogEntry;
      skill: InstalledPluginCatalogEntry["skills"][number];
      enabled: boolean;
    };

export function parseSkillFrontMatter(
  raw: string,
  skillDirName: string,
): ParsedSkillDocument | null {
  return parseSkillDocument(raw, { expectedName: skillDirName, mode: "catalog" });
}

function mimeTypeForPath(targetPath: string): string {
  const ext = path.extname(targetPath).toLowerCase();
  switch (ext) {
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

async function readFileAsDataUri(targetPath: string): Promise<string | null> {
  try {
    const buf = await Bun.file(targetPath).arrayBuffer();
    return `data:${mimeTypeForPath(targetPath)};base64,${Buffer.from(buf).toString("base64")}`;
  } catch {
    return null;
  }
}

async function readSkillFileAsDataUri(
  skillRoot: string,
  relativePath: string,
): Promise<string | null> {
  const resolvedPath = path.resolve(skillRoot, relativePath);
  if (!isPathInside(skillRoot, resolvedPath)) {
    return null;
  }

  try {
    // Resolve through symlinks before reading so icon paths cannot escape the skill root.
    const [canonicalSkillRoot, canonicalTarget] = await Promise.all([
      fs.realpath(skillRoot),
      fs.realpath(resolvedPath),
    ]);
    if (!isPathInside(canonicalSkillRoot, canonicalTarget)) {
      return null;
    }

    return await readFileAsDataUri(canonicalTarget);
  } catch {
    return null;
  }
}

export function extractTriggers(name: string, frontMatter?: Record<string, unknown>): string[] {
  const defaults: Record<string, string[]> = {
    xlsx: ["spreadsheet", "excel", ".xlsx", "csv", "data table", "chart"],
    pptx: ["presentation", "slides", "powerpoint", ".pptx", "deck", "pitch"],
    pdf: ["pdf", ".pdf", "form", "merge", "split"],
    docx: ["document", "word", ".docx", "report", "letter", "memo"],
    spreadsheet: ["spreadsheet", "excel", ".xlsx", "csv", "data table", "chart"],
    slides: ["presentation", "slides", "powerpoint", ".pptx", "deck", "pitch"],
    doc: ["document", "word", ".docx", "report", "letter", "memo"],
    spreadsheets: ["spreadsheet", "excel", ".xlsx", "csv", "data table", "chart"],
    presentations: ["presentation", "slides", "powerpoint", ".pptx", "deck", "pitch"],
    documents: ["document", "word", ".docx", "report", "letter", "memo"],
  };

  return extractSkillTriggers(name, frontMatter, { defaults });
}

function buildDiagnostic(
  code: string,
  severity: SkillInstallationDiagnostic["severity"],
  message: string,
): SkillInstallationDiagnostic {
  return { code, severity, message };
}

function buildPluginOwner(plugin: InstalledPluginCatalogEntry): SkillPluginOwner {
  return {
    pluginId: plugin.id,
    name: plugin.name,
    displayName: plugin.displayName,
    scope: plugin.scope,
    discoveryKind: plugin.discoveryKind,
    rootDir: plugin.rootDir,
  };
}

function buildPluginSkillInstallationId(
  plugin: InstalledPluginCatalogEntry,
  skill: InstalledPluginCatalogEntry["skills"][number],
): string {
  const relativeSkillRoot = path.relative(plugin.rootDir, skill.rootDir).split(path.sep).join("/");
  return `plugin:${plugin.scope}:${plugin.id}:${relativeSkillRoot || skill.rawName}`;
}

export function getSkillScopeDescriptors(skillsDirs: string[]): SkillScopeDescriptor[] {
  const scopes: SkillScope[] =
    skillsDirs.length >= 4
      ? ["project", "global", "user", "built-in"]
      : ["project", "global", "built-in"];
  return skillsDirs.map((skillsDir, index) => {
    const scope = scopes[index] ?? "built-in";
    const writable = scope === "project" || scope === "global";
    const disabledSkillsDir =
      path.basename(skillsDir) === "skills"
        ? path.join(path.dirname(skillsDir), "disabled-skills")
        : undefined;
    return {
      scope,
      skillsDir,
      ...(disabledSkillsDir ? { disabledSkillsDir } : {}),
      writable,
      readable: true,
    };
  });
}

function getScanScopeDirs(
  descriptors: SkillScopeDescriptor[],
  includeDisabled: boolean,
): ScanScopeDir[] {
  const out: ScanScopeDir[] = [];
  for (const descriptor of descriptors) {
    out.push({
      scope: descriptor.scope,
      writable: descriptor.writable,
      skillsDir: descriptor.skillsDir,
      scopeAnchorDir: path.dirname(descriptor.skillsDir),
      enabled: true,
    });
    if (includeDisabled && descriptor.disabledSkillsDir) {
      out.push({
        scope: descriptor.scope,
        writable: descriptor.writable,
        skillsDir: descriptor.disabledSkillsDir,
        scopeAnchorDir: path.dirname(descriptor.skillsDir),
        enabled: false,
      });
    }
  }
  return out;
}

async function buildPluginInstallationEntry(opts: {
  plugin: InstalledPluginCatalogEntry;
  skill: InstalledPluginCatalogEntry["skills"][number];
  enabled: boolean;
}): Promise<SkillInstallationEntry> {
  const diagnostics: SkillInstallationDiagnostic[] = [];
  let fileModifiedAt: string | undefined;
  try {
    const stat = await fs.stat(opts.skill.skillPath);
    fileModifiedAt = stat.mtime.toISOString();
  } catch {
    diagnostics.push(buildDiagnostic("missing_skill_md", "error", "Missing SKILL.md"));
  }

  if (diagnostics.length === 0) {
    try {
      const raw = await Bun.file(opts.skill.skillPath).text();
      const parsed = parseSkillFrontMatter(raw, opts.skill.rawName);
      if (!parsed) {
        diagnostics.push(
          buildDiagnostic("invalid_frontmatter", "error", "Invalid or missing skill frontmatter"),
        );
      }
    } catch (error) {
      diagnostics.push(
        buildDiagnostic(
          "unreadable_skill_md",
          "error",
          `Unable to read SKILL.md: ${String(error)}`,
        ),
      );
    }
  }

  const pluginOwner = buildPluginOwner(opts.plugin);
  return {
    installationId: buildPluginSkillInstallationId(opts.plugin, opts.skill),
    name: opts.skill.name,
    description: opts.skill.description,
    scope: opts.plugin.scope === "workspace" ? "project" : "user",
    enabled: opts.enabled,
    writable: false,
    managed: false,
    effective: false,
    state: diagnostics.length > 0 ? "invalid" : opts.enabled ? "shadowed" : "disabled",
    rootDir: opts.skill.rootDir,
    skillPath: diagnostics.length > 0 ? null : opts.skill.skillPath,
    path: diagnostics.length > 0 ? opts.skill.rootDir : opts.skill.skillPath,
    triggers: [...opts.skill.triggers],
    descriptionSource: "frontmatter",
    ...(opts.skill.interface ? { interface: opts.skill.interface } : {}),
    diagnostics,
    ...(fileModifiedAt ? { fileModifiedAt } : {}),
    plugin: pluginOwner,
  };
}

async function buildInstallationEntry(opts: {
  scopeDir: ScanScopeDir;
  dirent: { name: string };
}): Promise<SkillInstallationEntry> {
  const rootDir = path.join(opts.scopeDir.skillsDir, opts.dirent.name);
  const skillPath = path.join(rootDir, "SKILL.md");
  const diagnostics: SkillInstallationDiagnostic[] = [];
  const manifest = await readSkillInstallManifest(rootDir);
  const installationId =
    manifest?.installationId ??
    deriveFallbackInstallationId(
      opts.scopeDir.scope,
      opts.scopeDir.scopeAnchorDir,
      opts.dirent.name,
    );
  let name = opts.dirent.name;
  let description = "Skill installation";
  let descriptionSource: SkillInstallationEntry["descriptionSource"] = "directory";
  let triggers: string[] = [opts.dirent.name];
  let interfaceMeta: SkillEntry["interface"] | undefined;
  let fileModifiedAt: string | undefined;
  let readableSkillPath: string | null = null;

  try {
    const stat = await fs.stat(skillPath);
    fileModifiedAt = stat.mtime.toISOString();
  } catch {
    diagnostics.push(buildDiagnostic("missing_skill_md", "error", "Missing SKILL.md"));
  }

  if (diagnostics.length === 0) {
    try {
      const raw = await Bun.file(skillPath).text();
      const parsed = parseSkillFrontMatter(raw, opts.dirent.name);
      if (!parsed) {
        diagnostics.push(
          buildDiagnostic("invalid_frontmatter", "error", "Invalid or missing skill frontmatter"),
        );
      } else {
        readableSkillPath = skillPath;
        name = parsed.frontMatter.name;
        description = parsed.frontMatter.description;
        descriptionSource = "frontmatter";
        triggers = extractTriggers(name, parsed.rawFrontMatter);
        interfaceMeta = await readAgentInterface(rootDir, readSkillFileAsDataUri);
      }
    } catch (error) {
      diagnostics.push(
        buildDiagnostic(
          "unreadable_skill_md",
          "error",
          `Unable to read SKILL.md: ${String(error)}`,
        ),
      );
    }
  }

  return {
    installationId,
    name,
    description,
    scope: opts.scopeDir.scope,
    enabled: opts.scopeDir.enabled,
    writable: opts.scopeDir.writable,
    managed: manifest !== null,
    effective: false,
    state: diagnostics.length > 0 ? "invalid" : opts.scopeDir.enabled ? "shadowed" : "disabled",
    rootDir,
    skillPath: readableSkillPath,
    ...(manifest !== null ? { manifestPath: manifestPathForSkillRoot(rootDir) } : {}),
    path: readableSkillPath ?? rootDir,
    triggers,
    descriptionSource,
    ...(interfaceMeta ? { interface: interfaceMeta } : {}),
    diagnostics,
    ...(manifest?.origin ? { origin: manifest.origin } : {}),
    ...(manifest ? { manifest } : {}),
    ...(manifest?.installedAt ? { installedAt: manifest.installedAt } : {}),
    ...(manifest?.updatedAt ? { updatedAt: manifest.updatedAt } : {}),
    ...(fileModifiedAt ? { fileModifiedAt } : {}),
  };
}

function applyEffectiveResolution(installations: SkillInstallationEntry[]): SkillCatalogSnapshot {
  const winners = new Map<string, SkillInstallationEntry>();
  const resolved = installations.map((installation) => ({ ...installation }));

  for (const installation of resolved) {
    if (!installation.enabled || installation.state === "invalid" || !installation.skillPath) {
      if (installation.state !== "invalid") {
        installation.effective = false;
      }
      continue;
    }

    const winner = winners.get(installation.name);
    if (!winner) {
      installation.effective = true;
      installation.state = "effective";
      winners.set(installation.name, installation);
      continue;
    }

    installation.effective = false;
    installation.state = "shadowed";
    installation.shadowedByInstallationId = winner.installationId;
    installation.shadowedByScope = winner.scope;
  }

  return {
    scopes: [],
    effectiveSkills: resolved.filter((installation) => installation.effective),
    installations: resolved,
    availableSkills: [],
  };
}

export async function scanSkillCatalogFromSources(
  sources: SkillCatalogSource[],
  opts: {
    includeDisabled?: boolean;
    adoptManagedWritableInstalls?: boolean;
  } = {},
): Promise<SkillCatalogSnapshot> {
  const descriptors = sources
    .filter(
      (source): source is Extract<SkillCatalogSource, { kind: "standalone" }> =>
        source.kind === "standalone",
    )
    .map((source) => source.descriptor);
  const scanDirs = getScanScopeDirs(descriptors, opts.includeDisabled === true);
  const installations: SkillInstallationEntry[] = [];

  for (const scopeDir of scanDirs) {
    let dirents: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      dirents = await fs.readdir(scopeDir.skillsDir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }

    for (const dirent of dirents) {
      if (!dirent.isDirectory()) {
        continue;
      }

      const entry = await buildInstallationEntry({ scopeDir, dirent });
      if (
        opts.adoptManagedWritableInstalls &&
        scopeDir.writable &&
        entry.managed === false &&
        entry.state !== "invalid"
      ) {
        const manifest = await adoptSkillInstallManifest({
          skillRoot: entry.rootDir,
          fallbackInstallationId: entry.installationId,
        });
        entry.managed = true;
        entry.manifest = manifest;
        entry.manifestPath = manifestPathForSkillRoot(entry.rootDir);
        entry.origin = manifest.origin;
        entry.installedAt = manifest.installedAt;
        entry.updatedAt = manifest.updatedAt;
      }
      installations.push(entry);
    }
  }

  for (const source of sources) {
    if (source.kind !== "plugin") continue;
    const entry = await buildPluginInstallationEntry({
      plugin: source.plugin,
      skill: source.skill,
      enabled: source.enabled,
    });
    installations.push(entry);
  }

  const resolved = applyEffectiveResolution(installations);
  return {
    scopes: descriptors,
    effectiveSkills: resolved.effectiveSkills,
    installations: resolved.installations,
    availableSkills: [],
  };
}

export async function scanSkillCatalog(
  skillsDirs: string[],
  opts: {
    includeDisabled?: boolean;
    adoptManagedWritableInstalls?: boolean;
  } = {},
): Promise<SkillCatalogSnapshot> {
  return await scanSkillCatalogFromSources(
    getSkillScopeDescriptors(skillsDirs).map((descriptor) => ({
      kind: "standalone" as const,
      descriptor,
    })),
    opts,
  );
}

export function toLegacySkillEntry(installation: SkillInstallationEntry): SkillEntry | null {
  if (!installation.skillPath || installation.state === "invalid") {
    return null;
  }

  return {
    name: installation.name,
    path: installation.skillPath,
    source: installation.scope,
    enabled: installation.enabled,
    triggers: installation.triggers,
    description: installation.description,
    ...(installation.interface ? { interface: installation.interface } : {}),
    ...(installation.plugin ? { plugin: installation.plugin } : {}),
  };
}

export function getInstallationById(
  catalog: SkillCatalogSnapshot,
  installationId: string,
): SkillInstallationEntry | null {
  return (
    catalog.installations.find((installation) => installation.installationId === installationId) ??
    null
  );
}

export function getEffectiveInstallationByName(
  catalog: SkillCatalogSnapshot,
  skillName: string,
): SkillInstallationEntry | null {
  return catalog.effectiveSkills.find((installation) => installation.name === skillName) ?? null;
}
