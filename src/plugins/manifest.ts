import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { extractSkillTriggers, readAgentInterface, readSkillDocument } from "../skills/metadata";
import type {
  InstalledPluginCatalogEntry,
  PluginAppSummary,
  PluginCatalogEntry,
  PluginDiscoveryKind,
  PluginInterfaceMeta,
  PluginScope,
  SkillInterfaceMeta,
} from "../types";
import { isPathInside, resolveMaybeRelative } from "../utils/paths";
import { isRecord } from "../utils/typeGuards";

const nonEmptyStringSchema = z.string().trim().min(1);
const optionalStringArraySchema = z.array(nonEmptyStringSchema).optional();
const MAX_SKILL_ICON_BYTES = 256 * 1024;

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

export interface PluginInstallMetadata {
  marketplace?: {
    name: string;
    displayName?: string;
    category?: string;
    installationPolicy?: string;
    authenticationPolicy?: string;
    sourceInput?: string;
    sourceHash?: string;
  };
  bootstrap?: {
    name: string;
    source?: string;
    pluginId?: string;
  };
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

function mimeTypeForIconPath(targetPath: string): string {
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

async function readSkillIconAsDataUri(
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
    const stat = await fs.stat(canonicalTarget);
    // Catalog payloads inline icons, so cap files before base64 encoding.
    if (!stat.isFile() || stat.size > MAX_SKILL_ICON_BYTES) {
      return null;
    }
    const buf = await fs.readFile(canonicalTarget);
    return `data:${mimeTypeForIconPath(canonicalTarget)};base64,${buf.toString("base64")}`;
  } catch {
    return null;
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

const PLUGIN_MANIFEST_DIR_NAMES = [".cowork-plugin", ".codex-plugin"] as const;

/**
 * Claude Code stores plugin manifests under `.claude-plugin/`. Cowork does not
 * recognize this directory in its normal install/discovery paths, but the
 * import feature scans for it so Claude plugins can be converted and imported.
 */
export const CLAUDE_PLUGIN_MANIFEST_DIR_NAME = ".claude-plugin";

export function isPluginManifestDirName(value: string): boolean {
  return PLUGIN_MANIFEST_DIR_NAMES.includes(value as (typeof PLUGIN_MANIFEST_DIR_NAMES)[number]);
}

export function pluginManifestPathsForPluginRoot(
  pluginRoot: string,
  dirNames: readonly string[] = PLUGIN_MANIFEST_DIR_NAMES,
): string[] {
  return dirNames.map((dirName) => path.join(pluginRoot, dirName, "plugin.json"));
}

function pluginInstallMetadataPathForManifestPath(manifestPath: string): string {
  return path.join(path.dirname(manifestPath), "install.json");
}

function pluginInstallMetadataPathsForPluginRoot(pluginRoot: string): string[] {
  return PLUGIN_MANIFEST_DIR_NAMES.map((dirName) => path.join(pluginRoot, dirName, "install.json"));
}

function manifestPathForPluginRoot(pluginRoot: string): string {
  return pluginManifestPathsForPluginRoot(pluginRoot)[0] ?? path.join(pluginRoot, "plugin.json");
}

async function findPluginManifestPath(pluginRoot: string): Promise<string> {
  for (const candidatePath of pluginManifestPathsForPluginRoot(pluginRoot)) {
    try {
      const stat = await fs.stat(candidatePath);
      if (stat.isFile()) {
        return candidatePath;
      }
    } catch {
      // Try the next supported manifest directory.
    }
  }
  return manifestPathForPluginRoot(pluginRoot);
}

const pluginInstallMetadataSchema = z
  .object({
    marketplace: z
      .object({
        name: nonEmptyStringSchema,
        displayName: nonEmptyStringSchema.optional(),
        category: nonEmptyStringSchema.optional(),
        installationPolicy: nonEmptyStringSchema.optional(),
        authenticationPolicy: nonEmptyStringSchema.optional(),
        sourceInput: nonEmptyStringSchema.optional(),
        sourceHash: nonEmptyStringSchema.optional(),
      })
      .optional(),
    bootstrap: z
      .object({
        name: nonEmptyStringSchema,
        source: nonEmptyStringSchema.optional(),
        pluginId: nonEmptyStringSchema.optional(),
      })
      .optional(),
  })
  .passthrough();

export async function readPluginInstallMetadata(
  pluginRoot: string,
): Promise<PluginInstallMetadata | null> {
  for (const metadataPath of pluginInstallMetadataPathsForPluginRoot(pluginRoot)) {
    try {
      const raw = await fs.readFile(metadataPath, "utf-8");
      const parsed = pluginInstallMetadataSchema.parse(JSON.parse(raw));
      return {
        ...(parsed.marketplace
          ? {
              marketplace: {
                name: parsed.marketplace.name,
                ...(parsed.marketplace.displayName
                  ? { displayName: parsed.marketplace.displayName }
                  : {}),
                ...(parsed.marketplace.category ? { category: parsed.marketplace.category } : {}),
                ...(parsed.marketplace.installationPolicy
                  ? { installationPolicy: parsed.marketplace.installationPolicy }
                  : {}),
                ...(parsed.marketplace.authenticationPolicy
                  ? { authenticationPolicy: parsed.marketplace.authenticationPolicy }
                  : {}),
                ...(parsed.marketplace.sourceInput
                  ? { sourceInput: parsed.marketplace.sourceInput }
                  : {}),
                ...(parsed.marketplace.sourceHash
                  ? { sourceHash: parsed.marketplace.sourceHash }
                  : {}),
              },
            }
          : {}),
        ...(parsed.bootstrap
          ? {
              bootstrap: {
                name: parsed.bootstrap.name,
                ...(parsed.bootstrap.source ? { source: parsed.bootstrap.source } : {}),
                ...(parsed.bootstrap.pluginId ? { pluginId: parsed.bootstrap.pluginId } : {}),
              },
            }
          : {}),
      };
    } catch {
      // Missing or malformed install metadata should not make the plugin unreadable.
    }
  }
  return null;
}

export async function writePluginInstallMetadata(
  pluginRoot: string,
  metadata: PluginInstallMetadata,
): Promise<void> {
  const manifestPath = await findPluginManifestPath(pluginRoot);
  const metadataPath = pluginInstallMetadataPathForManifestPath(manifestPath);
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
}

export async function clearPluginInstallMetadata(pluginRoot: string): Promise<void> {
  await Promise.all(
    pluginInstallMetadataPathsForPluginRoot(pluginRoot).map(async (metadataPath) => {
      await fs.rm(metadataPath, { force: true }).catch(() => {});
    }),
  );
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
  const manifestPath = await findPluginManifestPath(pluginRoot);
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
      const parsed = await readSkillDocument(skillPath, { expectedName: dirent.name });
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
      const parsed = await readSkillDocument(skillPath, { expectedName: dirent.name });
      if (!parsed) {
        warnings.push(
          `[plugins] Ignoring malformed bundled skill "${dirent.name}" at ${skillPath}.`,
        );
        continue;
      }
      const interfaceMeta = await readAgentInterface(skillRoot, readSkillIconAsDataUri);
      skills.push({
        rawName: parsed.frontMatter.name,
        description: parsed.frontMatter.description,
        triggers: extractSkillTriggers(parsed.frontMatter.name, parsed.rawFrontMatter),
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
  installSource?: string;
}): InstalledPluginCatalogEntry {
  return {
    id: opts.pluginId,
    name: opts.pluginManifest.name,
    displayName: opts.pluginManifest.interface?.displayName ?? opts.pluginManifest.name,
    description: opts.pluginManifest.description,
    scope: opts.scope,
    discoveryKind: opts.discoveryKind,
    installed: true,
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
    ...(opts.installSource ? { installSource: opts.installSource } : {}),
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
