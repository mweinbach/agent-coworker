import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type {
  PluginAppSummary,
  PluginCatalogEntry,
  PluginDiscoveryKind,
  PluginInterfaceMeta,
  PluginScope,
  PluginSkillSummary,
  SkillInterfaceMeta,
} from "../types";
import { isPathInside, resolveMaybeRelative } from "../utils/paths";
import { isRecord } from "../utils/typeGuards";

const nonEmptyStringSchema = z.string().trim().min(1);
const optionalStringArraySchema = z.array(nonEmptyStringSchema).optional();

const pluginInterfaceSchema = z
  .object({
    displayName: nonEmptyStringSchema.optional(),
    shortDescription: nonEmptyStringSchema.optional(),
    longDescription: nonEmptyStringSchema.optional(),
    developerName: nonEmptyStringSchema.optional(),
    category: nonEmptyStringSchema.optional(),
    capabilities: z.array(nonEmptyStringSchema).optional(),
    websiteURL: nonEmptyStringSchema.optional(),
    privacyPolicyURL: nonEmptyStringSchema.optional(),
    termsOfServiceURL: nonEmptyStringSchema.optional(),
    defaultPrompt: z.union([nonEmptyStringSchema, z.array(nonEmptyStringSchema)]).optional(),
    brandColor: nonEmptyStringSchema.optional(),
    composerIcon: nonEmptyStringSchema.optional(),
    logo: nonEmptyStringSchema.optional(),
    screenshots: z.array(nonEmptyStringSchema).optional(),
  })
  .strict();

const pluginAuthorSchema = z.union([
  nonEmptyStringSchema,
  z
    .object({
      name: nonEmptyStringSchema.optional(),
      email: nonEmptyStringSchema.optional(),
      url: nonEmptyStringSchema.optional(),
    })
    .strict(),
]);

const pluginManifestSchema = z
  .object({
    name: nonEmptyStringSchema.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    version: nonEmptyStringSchema.optional(),
    description: nonEmptyStringSchema.optional(),
    author: pluginAuthorSchema.optional(),
    homepage: nonEmptyStringSchema.optional(),
    repository: nonEmptyStringSchema.optional(),
    license: nonEmptyStringSchema.optional(),
    keywords: optionalStringArraySchema,
    skills: z.union([nonEmptyStringSchema, z.array(nonEmptyStringSchema)]).optional(),
    mcpServers: nonEmptyStringSchema.optional(),
    apps: nonEmptyStringSchema.optional(),
    interface: pluginInterfaceSchema.optional(),
  })
  .strict();

export interface PluginManifest {
  name: string;
  version?: string;
  description: string;
  authorName?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords: string[];
  interface?: PluginInterfaceMeta;
  skillsPath: string;
  skillsPaths: string[];
  mcpPath?: string;
  appPath?: string;
  manifestPath: string;
  rootDir: string;
}

export type ParsedPluginSkill = {
  rawName: string;
  description: string;
  triggers: string[];
  skillPath: string;
  rootDir: string;
  interface?: SkillInterfaceMeta;
  warnings: string[];
};

export type ParsedPluginApp = PluginAppSummary;

type ParsedSkillFrontMatter = {
  name: string;
  description: string;
  rawFrontMatter: Record<string, unknown>;
};

const skillFrontMatterSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().trim().min(1).max(1024),
    metadata: z.record(z.string(), z.unknown()).optional(),
    triggers: z.union([z.string(), z.array(z.unknown())]).optional(),
  })
  .passthrough();

function splitFrontMatter(raw: string): { frontMatterRaw: string | null } {
  const re = /^\ufeff?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
  const match = raw.match(re);
  return { frontMatterRaw: match?.[1] ?? null };
}

function parseYamlFrontMatter(frontMatterRaw: string): Record<string, unknown> | null {
  try {
    const parsed = Bun.YAML.parse(frontMatterRaw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseTriggerValue(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function extractTriggers(name: string, frontMatter?: Record<string, unknown>): string[] {
  if (frontMatter) {
    const direct = parseTriggerValue(frontMatter.triggers);
    if (direct.length > 0) return direct;
    const metadata = isRecord(frontMatter.metadata) ? frontMatter.metadata : null;
    if (metadata) {
      const metadataTriggers = parseTriggerValue(metadata.triggers);
      if (metadataTriggers.length > 0) return metadataTriggers;
    }
  }
  return [name];
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
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

async function parseSkillFrontMatter(
  skillPath: string,
  expectedName: string,
): Promise<ParsedSkillFrontMatter | null> {
  const raw = await fs.readFile(skillPath, "utf-8");
  const { frontMatterRaw } = splitFrontMatter(raw);
  if (!frontMatterRaw) return null;
  const parsed = parseYamlFrontMatter(frontMatterRaw);
  if (!parsed) return null;
  const validated = skillFrontMatterSchema.safeParse(parsed);
  if (!validated.success || validated.data.name !== expectedName) {
    return null;
  }
  return {
    name: validated.data.name,
    description: validated.data.description,
    rawFrontMatter: parsed,
  };
}

async function readSkillInterface(skillRoot: string): Promise<SkillInterfaceMeta | undefined> {
  const agentsDir = path.join(skillRoot, "agents");
  let dirents: Array<{ name: string; isFile: boolean }> = [];
  try {
    const rawDirents = await fs.readdir(agentsDir, { withFileTypes: true, encoding: "utf8" });
    dirents = rawDirents.map((entry) => ({ name: entry.name, isFile: entry.isFile() }));
  } catch {
    return undefined;
  }
  const agentFiles = dirents
    .filter((entry) => entry.isFile && /\.(ya?ml)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (agentFiles.length === 0) return undefined;
  const primary = agentFiles.find((file) => file.toLowerCase() === "openai.yaml") ?? agentFiles[0]!;
  try {
    const raw = await fs.readFile(path.join(agentsDir, primary), "utf-8");
    return {
      ...(parseAgentInterfaceYaml(raw) ?? {}),
      agents: agentFiles.map((file) => file.replace(/\.(ya?ml)$/i, "")),
    };
  } catch {
    return { agents: agentFiles.map((file) => file.replace(/\.(ya?ml)$/i, "")) };
  }
}

function normalizePluginInterface(
  value: z.infer<typeof pluginInterfaceSchema> | undefined,
): PluginInterfaceMeta | undefined {
  if (!value) return undefined;
  const defaultPrompt = Array.isArray(value.defaultPrompt)
    ? [...value.defaultPrompt]
    : typeof value.defaultPrompt === "string"
      ? [value.defaultPrompt]
      : undefined;
  return {
    ...(value.displayName ? { displayName: value.displayName } : {}),
    ...(value.shortDescription ? { shortDescription: value.shortDescription } : {}),
    ...(value.longDescription ? { longDescription: value.longDescription } : {}),
    ...(value.developerName ? { developerName: value.developerName } : {}),
    ...(value.category ? { category: value.category } : {}),
    ...(value.capabilities ? { capabilities: [...value.capabilities] } : {}),
    ...(value.websiteURL ? { websiteURL: value.websiteURL } : {}),
    ...(value.privacyPolicyURL ? { privacyPolicyURL: value.privacyPolicyURL } : {}),
    ...(value.termsOfServiceURL ? { termsOfServiceURL: value.termsOfServiceURL } : {}),
    ...(defaultPrompt ? { defaultPrompt } : {}),
    ...(value.brandColor ? { brandColor: value.brandColor } : {}),
    ...(value.composerIcon ? { composerIcon: value.composerIcon } : {}),
    ...(value.logo ? { logo: value.logo } : {}),
    ...(value.screenshots ? { screenshots: [...value.screenshots] } : {}),
  };
}

function resolveRelativePath(
  pluginRoot: string,
  relativePath: string | undefined,
  fallback: string | undefined,
): string | undefined {
  const selected = relativePath ?? fallback;
  if (!selected) return undefined;
  return resolveMaybeRelative(selected, pluginRoot);
}

async function resolveOptionalRelativePath(
  pluginRoot: string,
  relativePath: string | undefined,
  fallback: string | undefined,
): Promise<string | undefined> {
  if (relativePath !== undefined) {
    return resolveMaybeRelative(relativePath, pluginRoot);
  }
  if (!fallback) return undefined;
  const resolvedFallback = resolveMaybeRelative(fallback, pluginRoot);
  if (!resolvedFallback) return undefined;
  try {
    await fs.access(resolvedFallback);
    return resolvedFallback;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function canonicalizePathFromExistingAncestor(targetPath: string): Promise<string> {
  const pendingSegments: string[] = [];
  let currentPath = path.resolve(targetPath);

  while (true) {
    try {
      const canonicalExistingPath = await fs.realpath(currentPath);
      return pendingSegments.length === 0
        ? canonicalExistingPath
        : path.join(canonicalExistingPath, ...pendingSegments.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        throw error;
      }
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        return path.resolve(targetPath);
      }
      pendingSegments.push(path.basename(currentPath));
      currentPath = parentPath;
    }
  }
}

async function canonicalizePathForBoundaryCheck(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return await canonicalizePathFromExistingAncestor(targetPath);
    }
    throw error;
  }
}

async function assertPathInsidePluginRoot(
  pluginRoot: string,
  targetPath: string | undefined,
  manifestPath: string,
  label: string,
): Promise<void> {
  if (!targetPath) return;
  const [canonicalPluginRoot, canonicalTargetPath] = await Promise.all([
    canonicalizePathForBoundaryCheck(pluginRoot),
    canonicalizePathForBoundaryCheck(targetPath),
  ]);
  if (!isPathInside(canonicalPluginRoot, canonicalTargetPath)) {
    throw new Error(
      `Plugin manifest at ${manifestPath} resolves ${label} outside the plugin root.`,
    );
  }
}

export function manifestPathForPluginRoot(pluginRoot: string): string {
  return path.join(pluginRoot, ".codex-plugin", "plugin.json");
}

async function resolvePluginSkillsPaths(
  pluginRoot: string,
  skillsValue: string | string[] | undefined,
  manifestPath: string,
): Promise<string[]> {
  const requestedValues = Array.isArray(skillsValue)
    ? skillsValue.length > 0
      ? skillsValue
      : [undefined]
    : [skillsValue];
  const shouldValidateExistingPaths =
    skillsValue !== undefined && (!Array.isArray(skillsValue) || skillsValue.length > 0);
  const resolvedSkillsPaths: string[] = [];

  for (const requestedValue of requestedValues) {
    const skillsPath = resolveRelativePath(pluginRoot, requestedValue, "./skills/");
    if (!skillsPath) {
      throw new Error(`Plugin manifest at ${manifestPath} is missing a skills path.`);
    }
    await assertPathInsidePluginRoot(pluginRoot, skillsPath, manifestPath, "skills");
    if (resolvedSkillsPaths.includes(skillsPath)) {
      continue;
    }

    if (shouldValidateExistingPaths) {
      let skillsStat: Awaited<ReturnType<typeof fs.stat>> | undefined;
      try {
        skillsStat = await fs.stat(skillsPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
          throw new Error(
            `Plugin manifest at ${manifestPath} declares skills path ${skillsPath}, but that directory does not exist.`,
          );
        }
        throw error;
      }
      if (!skillsStat.isDirectory()) {
        throw new Error(
          `Plugin manifest at ${manifestPath} declares skills path ${skillsPath}, but it is not a directory.`,
        );
      }
    }

    resolvedSkillsPaths.push(skillsPath);
  }

  return resolvedSkillsPaths;
}

export async function readPluginManifest(pluginRoot: string): Promise<PluginManifest> {
  const manifestPath = manifestPathForPluginRoot(pluginRoot);
  const raw = await fs.readFile(manifestPath, "utf-8");
  const parsed = pluginManifestSchema.parse(JSON.parse(raw));
  const skillsPaths = await resolvePluginSkillsPaths(pluginRoot, parsed.skills, manifestPath);
  const skillsPath = skillsPaths[0];
  if (!skillsPath) {
    throw new Error(`Plugin manifest at ${manifestPath} is missing a skills path.`);
  }
  const mcpPath = await resolveOptionalRelativePath(pluginRoot, parsed.mcpServers, "./.mcp.json");
  const appPath = await resolveOptionalRelativePath(pluginRoot, parsed.apps, "./.app.json");
  await assertPathInsidePluginRoot(pluginRoot, mcpPath, manifestPath, "mcpServers");
  await assertPathInsidePluginRoot(pluginRoot, appPath, manifestPath, "apps");
  const authorName = typeof parsed.author === "string" ? parsed.author : parsed.author?.name;
  return {
    name: parsed.name,
    ...(parsed.version ? { version: parsed.version } : {}),
    description: parsed.description ?? parsed.interface?.shortDescription ?? parsed.name,
    ...(authorName ? { authorName } : {}),
    ...(parsed.homepage ? { homepage: parsed.homepage } : {}),
    ...(parsed.repository ? { repository: parsed.repository } : {}),
    ...(parsed.license ? { license: parsed.license } : {}),
    keywords: parsed.keywords ?? [],
    ...(normalizePluginInterface(parsed.interface)
      ? { interface: normalizePluginInterface(parsed.interface) }
      : {}),
    skillsPath,
    skillsPaths,
    ...(mcpPath ? { mcpPath } : {}),
    ...(appPath ? { appPath } : {}),
    manifestPath,
    rootDir: pluginRoot,
  };
}

async function readPluginSkillDirents(
  pluginManifest: PluginManifest,
): Promise<Array<{ skillsPath: string; name: string }>> {
  const dirents: Array<{ skillsPath: string; name: string }> = [];
  const canonicalPluginRoot = await canonicalizePathForBoundaryCheck(pluginManifest.rootDir);

  for (const skillsPath of pluginManifest.skillsPaths) {
    let entries: Array<import("node:fs").Dirent> = [];
    try {
      entries = await fs.readdir(skillsPath, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirents.push({ skillsPath, name: entry.name });
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      const skillRoot = path.join(skillsPath, entry.name);
      try {
        const stat = await fs.stat(skillRoot);
        if (!stat.isDirectory()) continue;
        const canonicalSkillRoot = await canonicalizePathForBoundaryCheck(skillRoot);
        if (!isPathInside(canonicalPluginRoot, canonicalSkillRoot)) continue;
      } catch {
        continue;
      }
      dirents.push({ skillsPath, name: entry.name });
    }
  }

  return dirents.sort((left, right) =>
    `${left.skillsPath}:${left.name}`.localeCompare(`${right.skillsPath}:${right.name}`),
  );
}

export async function validatePluginBundledSkills(
  pluginManifest: PluginManifest,
): Promise<string[]> {
  const dirents = await readPluginSkillDirents(pluginManifest);
  const warnings: string[] = [];

  for (const dirent of dirents) {
    const skillPath = path.join(dirent.skillsPath, dirent.name, "SKILL.md");
    try {
      const parsed = await parseSkillFrontMatter(skillPath, dirent.name);
      if (!parsed) {
        warnings.push(
          `Ignoring plugin skill "${dirent.name}" from ${skillPath}: invalid or missing frontmatter.`,
        );
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        warnings.push(
          `Ignoring plugin skill "${dirent.name}" from ${skillPath}: missing SKILL.md.`,
        );
      } else {
        warnings.push(`Ignoring plugin skill "${dirent.name}" from ${skillPath}: ${String(error)}`);
      }
    }
  }

  return warnings.sort((left, right) => left.localeCompare(right));
}

export async function readPluginSkillSummaries(pluginManifest: PluginManifest): Promise<{
  skills: ParsedPluginSkill[];
  warnings: string[];
}> {
  const dirents = await readPluginSkillDirents(pluginManifest);
  const skills: ParsedPluginSkill[] = [];
  const warnings: string[] = [];
  for (const dirent of dirents) {
    const skillRoot = path.join(dirent.skillsPath, dirent.name);
    const skillPath = path.join(skillRoot, "SKILL.md");
    try {
      const parsed = await parseSkillFrontMatter(skillPath, dirent.name);
      if (!parsed) {
        warnings.push(
          `[plugins] Ignoring malformed bundled skill "${dirent.name}" at ${skillPath}.`,
        );
        continue;
      }
      const interfaceMeta = await readSkillInterface(skillRoot);
      skills.push({
        rawName: parsed.name,
        description: parsed.description,
        triggers: extractTriggers(parsed.name, parsed.rawFrontMatter),
        rootDir: skillRoot,
        skillPath,
        ...(interfaceMeta ? { interface: interfaceMeta } : {}),
        warnings: [],
      });
    } catch (error) {
      warnings.push(
        `[plugins] Ignoring malformed bundled skill "${dirent.name}" at ${skillPath}: ${String(error)}`,
      );
    }
  }

  return {
    skills: skills.sort((left, right) => left.rawName.localeCompare(right.rawName)),
    warnings,
  };
}

export async function readPluginAppSummaries(
  appPath: string | undefined,
): Promise<ParsedPluginApp[]> {
  if (!appPath) return [];
  try {
    const raw = await fs.readFile(appPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return [];
    const entries = Array.isArray(parsed.apps)
      ? parsed.apps
      : isRecord(parsed.apps)
        ? Object.entries(parsed.apps).map(([id, value]) => ({
            id,
            ...(isRecord(value) ? value : {}),
          }))
        : Object.entries(parsed)
            .filter(([, value]) => isRecord(value))
            .map(([id, value]) => ({ id, ...(value as Record<string, unknown>) }));
    return entries
      .map((entry) => {
        if (!isRecord(entry)) return null;
        const id =
          typeof entry.id === "string" && entry.id.trim().length > 0
            ? entry.id.trim()
            : typeof entry.name === "string" && entry.name.trim().length > 0
              ? entry.name.trim()
              : null;
        if (!id) return null;
        const displayName =
          typeof entry.displayName === "string" && entry.displayName.trim().length > 0
            ? entry.displayName.trim()
            : id;
        return {
          id,
          displayName,
          ...(typeof entry.description === "string" && entry.description.trim().length > 0
            ? { description: entry.description.trim() }
            : {}),
          ...(typeof entry.authType === "string" && entry.authType.trim().length > 0
            ? { authType: entry.authType.trim() }
            : {}),
        } satisfies PluginAppSummary;
      })
      .filter((entry): entry is PluginAppSummary => entry !== null)
      .sort((left, right) => left.id.localeCompare(right.id));
  } catch {
    return [];
  }
}

export function buildPluginCatalogEntry(opts: {
  pluginId: string;
  pluginManifest: PluginManifest;
  scope: PluginScope;
  discoveryKind: PluginDiscoveryKind;
  enabled: boolean;
  skills: ParsedPluginSkill[];
  mcpServers: string[];
  apps: ParsedPluginApp[];
  warnings?: string[];
  marketplace?: PluginCatalogEntry["marketplace"];
}): PluginCatalogEntry {
  return {
    id: opts.pluginId,
    name: opts.pluginManifest.name,
    displayName: opts.pluginManifest.interface?.displayName ?? opts.pluginManifest.name,
    description: opts.pluginManifest.description,
    scope: opts.scope,
    discoveryKind: opts.discoveryKind,
    enabled: opts.enabled,
    rootDir: opts.pluginManifest.rootDir,
    manifestPath: opts.pluginManifest.manifestPath,
    skillsPath: opts.pluginManifest.skillsPath,
    ...(opts.pluginManifest.mcpPath ? { mcpPath: opts.pluginManifest.mcpPath } : {}),
    ...(opts.pluginManifest.appPath ? { appPath: opts.pluginManifest.appPath } : {}),
    ...(opts.pluginManifest.version ? { version: opts.pluginManifest.version } : {}),
    ...(opts.pluginManifest.authorName ? { authorName: opts.pluginManifest.authorName } : {}),
    ...(opts.pluginManifest.homepage ? { homepage: opts.pluginManifest.homepage } : {}),
    ...(opts.pluginManifest.repository ? { repository: opts.pluginManifest.repository } : {}),
    ...(opts.pluginManifest.license ? { license: opts.pluginManifest.license } : {}),
    ...(opts.pluginManifest.keywords.length > 0
      ? { keywords: [...opts.pluginManifest.keywords] }
      : {}),
    ...(opts.pluginManifest.interface ? { interface: opts.pluginManifest.interface } : {}),
    ...(opts.marketplace ? { marketplace: opts.marketplace } : {}),
    skills: opts.skills.map((skill) => ({
      name: `${opts.pluginManifest.name}:${skill.rawName}`,
      rawName: skill.rawName,
      description: skill.description,
      enabled: opts.enabled,
      rootDir: skill.rootDir,
      skillPath: skill.skillPath,
      triggers: [...skill.triggers],
      ...(skill.interface ? { interface: skill.interface } : {}),
    })),
    mcpServers: [...opts.mcpServers],
    apps: [...opts.apps],
    warnings: [...(opts.warnings ?? [])],
  };
}
