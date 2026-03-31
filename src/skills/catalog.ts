import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type {
  PluginCatalogEntry,
  SkillCatalogSnapshot,
  SkillEntry,
  SkillInstallationDiagnostic,
  SkillInstallationEntry,
  SkillInterfaceMeta,
  SkillPluginOwner,
  SkillScope,
  SkillScopeDescriptor,
} from "../types";
import {
  adoptSkillInstallManifest,
  deriveFallbackInstallationId,
  manifestPathForSkillRoot,
  readSkillInstallManifest,
} from "./manifest";
import { isPathInside } from "../utils/paths";

type SkillFrontMatter = {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
};

type ParsedSkillDocument = {
  frontMatter: SkillFrontMatter;
  rawFrontMatter: Record<string, unknown>;
  body: string;
};

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
      plugin: PluginCatalogEntry;
      skill: PluginCatalogEntry["skills"][number];
      enabled: boolean;
    };

const unknownRecordSchema = z.record(z.string(), z.unknown());
const nonEmptyTrimmedStringSchema = z.string().trim().min(1);
const triggerValueSchema = z.union([z.string(), z.array(z.unknown())]);
const metadataSchema = z.record(z.string(), z.string());
const skillFrontMatterSchema = z.object({
  name: z.string().trim().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().min(1).max(1024),
  license: nonEmptyTrimmedStringSchema.optional(),
  compatibility: z.string().trim().min(1).max(500).optional(),
  metadata: metadataSchema.optional(),
  "allowed-tools": nonEmptyTrimmedStringSchema.optional(),
}).passthrough();

function stripQuotes(v: string): string {
  const trimmed = v.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length >= 2)
    || (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
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

function parseYamlFrontMatter(frontMatterRaw: string): Record<string, unknown> | null {
  try {
    const parsed = Bun.YAML.parse(frontMatterRaw);
    const validated = unknownRecordSchema.safeParse(parsed);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

function parseSkillFrontMatter(raw: string, skillDirName: string): ParsedSkillDocument | null {
  const { frontMatterRaw, body } = splitFrontMatter(raw);
  if (!frontMatterRaw) {
    return null;
  }

  const parsed = parseYamlFrontMatter(frontMatterRaw);
  if (!parsed) {
    return null;
  }

  const validated = skillFrontMatterSchema.safeParse(parsed);
  if (!validated.success) {
    return null;
  }

  const data = validated.data;
  if (data.name !== skillDirName) {
    return null;
  }

  return {
    frontMatter: {
      name: data.name,
      description: data.description,
      ...(data.license ? { license: data.license } : {}),
      ...(data.compatibility ? { compatibility: data.compatibility } : {}),
      ...(data.metadata ? { metadata: data.metadata } : {}),
      ...(data["allowed-tools"] ? { allowedTools: data["allowed-tools"] } : {}),
    },
    rawFrontMatter: parsed,
    body,
  };
}

function parseTriggerValue(value: unknown): string[] {
  const parsed = triggerValueSchema.safeParse(value);
  if (!parsed.success) {
    return [];
  }

  if (typeof parsed.data === "string") {
    return parsed.data
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return parsed.data
    .filter((entry): entry is string => nonEmptyTrimmedStringSchema.safeParse(entry).success)
    .map((entry) => entry.trim())
    .filter(Boolean);
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
    const buf = await fs.readFile(targetPath);
    return `data:${mimeTypeForPath(targetPath)};base64,${Buffer.from(buf).toString("base64")}`;
  } catch {
    return null;
  }
}

async function readSkillFileAsDataUri(skillRoot: string, relativePath: string): Promise<string | null> {
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

function parseAgentInterfaceYaml(raw: string): SkillInterfaceMeta | null {
  const lines = raw.split(/\r?\n/);
  let inInterface = false;
  const out: SkillInterfaceMeta = {};

  for (const line of lines) {
    if (!inInterface) {
      if (/^interface:\s*$/.test(line.trim())) {
        inInterface = true;
      }
      continue;
    }

    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) break;

    const match = line.match(/^\s+([A-Za-z0-9_]+)\s*:\s*(.+)\s*$/);
    if (!match) continue;

    const key = match[1] ?? "";
    const value = stripQuotes(match[2] ?? "");
    switch (key) {
      case "display_name":
        out.displayName = value;
        break;
      case "short_description":
        out.shortDescription = value;
        break;
      case "default_prompt":
        out.defaultPrompt = value;
        break;
      default:
        break;
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

async function readAgentInterface(skillRoot: string): Promise<SkillInterfaceMeta | undefined> {
  const agentsDir = path.join(skillRoot, "agents");
  let entries: Array<{ name: string; isFile: boolean }> = [];
  try {
    const dirents = await fs.readdir(agentsDir, { withFileTypes: true, encoding: "utf8" });
    entries = dirents.map((entry) => ({ name: entry.name, isFile: entry.isFile() }));
  } catch {
    return undefined;
  }

  const agentFiles = entries
    .filter((entry) => entry.isFile && /\.(ya?ml)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (agentFiles.length === 0) {
    return undefined;
  }

  const primary = agentFiles.find((file) => file.toLowerCase() === "openai.yaml") ?? agentFiles[0]!;
  let raw: string;
  try {
    raw = await fs.readFile(path.join(agentsDir, primary), "utf-8");
  } catch {
    return { agents: agentFiles.map((file) => file.replace(/\.(ya?ml)$/i, "")) };
  }

  const parsed = parseAgentInterfaceYaml(raw);
  const agents = agentFiles.map((file) => file.replace(/\.(ya?ml)$/i, ""));
  const out: SkillInterfaceMeta = { ...(parsed ?? {}), agents };

  const iconSmallPathMatch = raw.match(/^\s+icon_small:\s*(.+)\s*$/m);
  const iconLargePathMatch = raw.match(/^\s+icon_large:\s*(.+)\s*$/m);
  const iconSmallRel = iconSmallPathMatch ? stripQuotes(iconSmallPathMatch[1] ?? "") : "";
  const iconLargeRel = iconLargePathMatch ? stripQuotes(iconLargePathMatch[1] ?? "") : "";

  if (iconSmallRel) {
    const dataUri = await readSkillFileAsDataUri(skillRoot, iconSmallRel);
    if (dataUri) {
      out.iconSmall = dataUri;
    }
  }

  if (iconLargeRel) {
    const dataUri = await readSkillFileAsDataUri(skillRoot, iconLargeRel);
    if (dataUri) {
      out.iconLarge = dataUri;
    }
  }

  return out;
}

export function extractTriggers(name: string, frontMatter?: Record<string, unknown>): string[] {
  if (frontMatter) {
    const direct = parseTriggerValue(frontMatter.triggers);
    if (direct.length > 0) {
      return direct;
    }

    const metadata = unknownRecordSchema.safeParse(frontMatter.metadata);
    if (metadata.success) {
      const metadataTriggers = parseTriggerValue(metadata.data.triggers);
      if (metadataTriggers.length > 0) {
        return metadataTriggers;
      }
    }
  }

  const defaults: Record<string, string[]> = {
    xlsx: ["spreadsheet", "excel", ".xlsx", "csv", "data table", "chart"],
    pptx: ["presentation", "slides", "powerpoint", ".pptx", "deck", "pitch"],
    pdf: ["pdf", ".pdf", "form", "merge", "split"],
    docx: ["document", "word", ".docx", "report", "letter", "memo"],
    spreadsheet: ["spreadsheet", "excel", ".xlsx", "csv", "data table", "chart"],
    slides: ["presentation", "slides", "powerpoint", ".pptx", "deck", "pitch"],
    doc: ["document", "word", ".docx", "report", "letter", "memo"],
  };

  return defaults[name] || [name];
}

function buildDiagnostic(code: string, severity: SkillInstallationDiagnostic["severity"], message: string): SkillInstallationDiagnostic {
  return { code, severity, message };
}

function buildPluginOwner(plugin: PluginCatalogEntry): SkillPluginOwner {
  return {
    pluginId: plugin.id,
    name: plugin.name,
    displayName: plugin.displayName,
    scope: plugin.scope,
    discoveryKind: plugin.discoveryKind,
    rootDir: plugin.rootDir,
  };
}

export function getSkillScopeDescriptors(skillsDirs: string[]): SkillScopeDescriptor[] {
  const scopes: SkillScope[] = ["project", "global", "user", "built-in"];
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

function getScanScopeDirs(descriptors: SkillScopeDescriptor[], includeDisabled: boolean): ScanScopeDir[] {
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
  plugin: PluginCatalogEntry;
  skill: PluginCatalogEntry["skills"][number];
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
      const raw = await fs.readFile(opts.skill.skillPath, "utf-8");
      const parsed = parseSkillFrontMatter(raw, opts.skill.rawName);
      if (!parsed) {
        diagnostics.push(buildDiagnostic("invalid_frontmatter", "error", "Invalid or missing skill frontmatter"));
      }
    } catch (error) {
      diagnostics.push(buildDiagnostic("unreadable_skill_md", "error", `Unable to read SKILL.md: ${String(error)}`));
    }
  }

  const pluginOwner = buildPluginOwner(opts.plugin);
  return {
    installationId: `plugin:${opts.plugin.id}:${opts.skill.rawName}`,
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
  let installationId =
    manifest?.installationId
    ?? deriveFallbackInstallationId(opts.scopeDir.scope, opts.scopeDir.scopeAnchorDir, opts.dirent.name);
  let name = opts.dirent.name;
  let description = "Skill installation";
  let descriptionSource: SkillInstallationEntry["descriptionSource"] = "directory";
  let triggers: string[] = [opts.dirent.name];
  let interfaceMeta: SkillEntry["interface"] | undefined;
  let fileModifiedAt: string | undefined;
  let parsedSkill: ParsedSkillDocument | null = null;
  let readableSkillPath: string | null = null;

  try {
    const stat = await fs.stat(skillPath);
    fileModifiedAt = stat.mtime.toISOString();
  } catch {
    diagnostics.push(buildDiagnostic("missing_skill_md", "error", "Missing SKILL.md"));
  }

  if (diagnostics.length === 0) {
    try {
      const raw = await fs.readFile(skillPath, "utf-8");
      const parsed = parseSkillFrontMatter(raw, opts.dirent.name);
      if (!parsed) {
        diagnostics.push(buildDiagnostic("invalid_frontmatter", "error", "Invalid or missing skill frontmatter"));
      } else {
        parsedSkill = parsed;
        readableSkillPath = skillPath;
        name = parsed.frontMatter.name;
        description = parsed.frontMatter.description;
        descriptionSource = "frontmatter";
        triggers = extractTriggers(name, parsed.rawFrontMatter);
        interfaceMeta = await readAgentInterface(rootDir);
      }
    } catch (error) {
      diagnostics.push(buildDiagnostic("unreadable_skill_md", "error", `Unable to read SKILL.md: ${String(error)}`));
    }
  }

  if (manifest && manifest.installationId.trim()) {
    installationId = manifest.installationId.trim();
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
    .filter((source): source is Extract<SkillCatalogSource, { kind: "standalone" }> => source.kind === "standalone")
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
      if (opts.adoptManagedWritableInstalls && scopeDir.writable && entry.managed === false && entry.state !== "invalid") {
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
    getSkillScopeDescriptors(skillsDirs).map((descriptor) => ({ kind: "standalone" as const, descriptor })),
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
  return catalog.installations.find((installation) => installation.installationId === installationId) ?? null;
}

export function getEffectiveInstallationByName(
  catalog: SkillCatalogSnapshot,
  skillName: string,
): SkillInstallationEntry | null {
  return catalog.effectiveSkills.find((installation) => installation.name === skillName) ?? null;
}
