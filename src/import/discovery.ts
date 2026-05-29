import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { buildPluginCatalogSnapshot } from "../plugins";
import {
  CLAUDE_PLUGIN_MANIFEST_DIR_NAME,
  pluginManifestPathsForPluginRoot,
  readPluginManifest,
} from "../plugins/manifest";
import { getSkillCatalog } from "../skills/operations";
import type { AgentConfig } from "../types";
import type { ExternalHome, ImportSource } from "./externalHomes";

export type ImportableKind = "plugin" | "skill";

export interface ImportDiagnostic {
  code: string;
  message: string;
}

export interface ImportableItem {
  kind: ImportableKind;
  source: ImportSource;
  /** Plugin id (manifest name) or skill name. */
  id: string;
  displayName: string;
  description: string;
  version?: string;
  /** Absolute path passed to the install pipeline. */
  sourcePath: string;
  alreadyInstalledGlobal: boolean;
  alreadyInstalledWorkspace: boolean;
  /** Non-empty => not importable; surfaced to the user. */
  diagnostics: ImportDiagnostic[];
  /** True when the bundle is a Claude `.claude-plugin` that needs conversion. */
  conversionRequired?: boolean;
}

// Manifest dir names recognized during import: cowork-native first (no
// conversion), then Claude's (needs conversion).
const IMPORT_PLUGIN_MANIFEST_DIR_NAMES = [
  ".cowork-plugin",
  ".codex-plugin",
  CLAUDE_PLUGIN_MANIFEST_DIR_NAME,
] as const;

// Heavy directories that never contain a plugin root we care about.
const SKIP_WALK_DIR_NAMES = new Set([".git", "node_modules"]);
const MAX_PLUGIN_WALK_DEPTH = 8;

type DiscoveredPluginRoot = { rootDir: string; manifestDirName: string };

async function manifestDirNameAt(dir: string): Promise<string | null> {
  for (const dirName of IMPORT_PLUGIN_MANIFEST_DIR_NAMES) {
    const [manifestPath] = pluginManifestPathsForPluginRoot(dir, [dirName]);
    if (!manifestPath) continue;
    try {
      const stat = await fs.stat(manifestPath);
      if (stat.isFile()) {
        return dirName;
      }
    } catch {
      // try the next recognized manifest dir
    }
  }
  return null;
}

async function discoverPluginRoots(scanRoot: string): Promise<DiscoveredPluginRoot[]> {
  const found: DiscoveredPluginRoot[] = [];
  const visited = new Set<string>();

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > MAX_PLUGIN_WALK_DEPTH) return;
    let canonicalDir: string;
    try {
      canonicalDir = await fs.realpath(dir);
    } catch {
      canonicalDir = path.resolve(dir);
    }
    if (visited.has(canonicalDir)) return;
    visited.add(canonicalDir);

    const manifestDirName = await manifestDirNameAt(dir);
    if (manifestDirName) {
      // A plugin root — record it and stop descending (avoid scanning its deps).
      found.push({ rootDir: dir, manifestDirName });
      return;
    }

    let dirents: Array<import("node:fs").Dirent>;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (SKIP_WALK_DIR_NAMES.has(dirent.name)) continue;
      const childPath = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await visit(childPath, depth + 1);
        continue;
      }
      if (!dirent.isSymbolicLink()) continue;
      try {
        const stat = await fs.stat(childPath);
        if (stat.isDirectory()) {
          await visit(childPath, depth + 1);
        }
      } catch {
        // unreadable symlink target — skip
      }
    }
  }

  await visit(scanRoot, 0);
  return found.sort((left, right) => left.rootDir.localeCompare(right.rootDir));
}

const claudeManifestSchema = z
  .object({
    name: z.string().trim().min(1),
    version: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    interface: z.object({ displayName: z.string().trim().min(1).optional() }).passthrough().optional(),
  })
  .passthrough();

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function buildPluginItem(
  discovered: DiscoveredPluginRoot,
  source: ImportSource,
  installedByScope: { user: Set<string>; workspace: Set<string> },
): Promise<ImportableItem> {
  const conversionRequired = discovered.manifestDirName === CLAUDE_PLUGIN_MANIFEST_DIR_NAME;
  const base: Omit<ImportableItem, "id" | "displayName" | "description"> = {
    kind: "plugin",
    source,
    sourcePath: discovered.rootDir,
    alreadyInstalledGlobal: false,
    alreadyInstalledWorkspace: false,
    diagnostics: [],
    conversionRequired,
  };

  try {
    if (conversionRequired) {
      const [manifestPath] = pluginManifestPathsForPluginRoot(discovered.rootDir, [
        CLAUDE_PLUGIN_MANIFEST_DIR_NAME,
      ]);
      const raw = await fs.readFile(manifestPath as string, "utf-8");
      const parsed = claudeManifestSchema.parse(JSON.parse(raw));
      const diagnostics: ImportDiagnostic[] = [];
      if (!KEBAB_CASE.test(parsed.name)) {
        diagnostics.push({
          code: "invalid_plugin_name",
          message: `Plugin name "${parsed.name}" is not a valid kebab-case identifier.`,
        });
      }
      const id = parsed.name;
      return {
        ...base,
        id,
        displayName: parsed.interface?.displayName ?? id,
        description: parsed.description ?? id,
        ...(parsed.version ? { version: parsed.version } : {}),
        diagnostics,
        alreadyInstalledGlobal: installedByScope.user.has(id),
        alreadyInstalledWorkspace: installedByScope.workspace.has(id),
      };
    }

    const manifest = await readPluginManifest(discovered.rootDir);
    return {
      ...base,
      id: manifest.name,
      displayName: manifest.interface?.displayName ?? manifest.name,
      description: manifest.description,
      ...(manifest.version ? { version: manifest.version } : {}),
      alreadyInstalledGlobal: installedByScope.user.has(manifest.name),
      alreadyInstalledWorkspace: installedByScope.workspace.has(manifest.name),
    };
  } catch (error) {
    const id = path.basename(discovered.rootDir);
    return {
      ...base,
      id,
      displayName: id,
      description: "Invalid plugin bundle",
      diagnostics: [
        {
          code: "invalid_plugin_manifest",
          message: `Invalid or unreadable plugin manifest: ${String(error)}`,
        },
      ],
    };
  }
}

export async function listImportablePlugins(opts: {
  config: AgentConfig;
  homes: ExternalHome[];
}): Promise<ImportableItem[]> {
  const catalog = await buildPluginCatalogSnapshot(opts.config);
  const installedByScope = {
    user: new Set(catalog.plugins.filter((p) => p.scope === "user").map((p) => p.id)),
    workspace: new Set(catalog.plugins.filter((p) => p.scope === "workspace").map((p) => p.id)),
  };

  const items: ImportableItem[] = [];
  const seen = new Set<string>();
  for (const home of opts.homes) {
    if (!home.exists) continue;
    for (const scanRoot of home.pluginScanRoots) {
      const roots = await discoverPluginRoots(scanRoot);
      for (const discovered of roots) {
        const item = await buildPluginItem(discovered, home.source, installedByScope);
        // De-dupe across scan roots / nested copies by source + id.
        const key = `${home.source}:${item.id}`;
        if (seen.has(key) && item.diagnostics.length === 0) continue;
        seen.add(key);
        items.push(item);
      }
    }
  }
  return dedupeImportable(items);
}

const skillFrontMatterSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    description: z.string().trim().min(1).max(1024),
  })
  .passthrough();

function splitFrontMatter(raw: string): string | null {
  const match = raw.match(/^\ufeff?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  return match?.[1] ?? null;
}

async function buildSkillItem(
  skillRoot: string,
  source: ImportSource,
  installedByScope: { global: Set<string>; project: Set<string> },
): Promise<ImportableItem | null> {
  const dirName = path.basename(skillRoot);
  const skillPath = path.join(skillRoot, "SKILL.md");
  let raw: string;
  try {
    raw = await fs.readFile(skillPath, "utf-8");
  } catch {
    // No SKILL.md (e.g. empty/placeholder dir) — not a skill, skip silently.
    return null;
  }

  const base: Omit<ImportableItem, "id" | "displayName" | "description" | "diagnostics"> = {
    kind: "skill",
    source,
    sourcePath: skillRoot,
    alreadyInstalledGlobal: false,
    alreadyInstalledWorkspace: false,
  };

  const frontMatterRaw = splitFrontMatter(raw);
  let parsedName: string | null = null;
  let parsedDescription = "";
  if (frontMatterRaw) {
    try {
      const parsed = skillFrontMatterSchema.safeParse(Bun.YAML.parse(frontMatterRaw));
      if (parsed.success) {
        parsedName = parsed.data.name;
        parsedDescription = parsed.data.description;
      }
    } catch {
      // fall through to diagnostic
    }
  }

  if (!parsedName) {
    return {
      ...base,
      id: dirName,
      displayName: dirName,
      description: "Invalid skill source",
      diagnostics: [
        { code: "invalid_frontmatter", message: "Invalid or missing SKILL.md frontmatter." },
      ],
    };
  }
  if (!KEBAB_CASE.test(parsedName) || parsedName !== dirName) {
    return {
      ...base,
      id: dirName,
      displayName: dirName,
      description: parsedDescription || dirName,
      diagnostics: [
        {
          code: "name_mismatch",
          message:
            parsedName !== dirName
              ? `Skill name "${parsedName}" does not match its directory "${dirName}".`
              : `Skill name "${parsedName}" is not a valid kebab-case identifier.`,
        },
      ],
    };
  }

  return {
    ...base,
    id: parsedName,
    displayName: parsedName,
    description: parsedDescription,
    diagnostics: [],
    alreadyInstalledGlobal: installedByScope.global.has(parsedName),
    alreadyInstalledWorkspace: installedByScope.project.has(parsedName),
  };
}

export async function listImportableSkills(opts: {
  config: AgentConfig;
  homes: ExternalHome[];
}): Promise<ImportableItem[]> {
  const catalog = await getSkillCatalog(opts.config);
  const standalone = catalog.installations.filter((i) => !i.plugin);
  const installedByScope = {
    global: new Set(standalone.filter((i) => i.scope === "global").map((i) => i.name)),
    project: new Set(standalone.filter((i) => i.scope === "project").map((i) => i.name)),
  };

  const items: ImportableItem[] = [];
  for (const home of opts.homes) {
    if (!home.exists) continue;
    let dirents: Array<import("node:fs").Dirent>;
    try {
      dirents = await fs.readdir(home.skillsDir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      const childPath = path.join(home.skillsDir, dirent.name);
      let isDir = dirent.isDirectory();
      if (!isDir && dirent.isSymbolicLink()) {
        try {
          isDir = (await fs.stat(childPath)).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (!isDir) continue;
      const item = await buildSkillItem(childPath, home.source, installedByScope);
      if (item) items.push(item);
    }
  }
  return dedupeImportable(items);
}

function dedupeImportable(items: ImportableItem[]): ImportableItem[] {
  const byKey = new Map<string, ImportableItem>();
  for (const item of items) {
    const key = `${item.source}:${item.kind}:${item.id}`;
    const existing = byKey.get(key);
    // Prefer an importable row over a diagnostic one for the same id.
    if (!existing || (existing.diagnostics.length > 0 && item.diagnostics.length === 0)) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
}
