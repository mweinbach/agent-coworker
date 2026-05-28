import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { PluginDiscoveryKind, PluginScope } from "../types";
import { pluginManifestPathsForPluginRoot } from "./manifest";
import { type ParsedMarketplaceDocument, parsePluginMarketplace } from "./marketplace";

const errorWithCodeSchema = z.object({ code: z.string() }).passthrough();

interface DiscoveredPluginCandidate {
  rootDir: string;
  realRootDir: string;
  scope: PluginScope;
  discoveryKind: PluginDiscoveryKind;
  marketplace?: {
    name: string;
    displayName?: string;
    category: string;
    installationPolicy: string;
    authenticationPolicy: string;
    pluginDisplayName?: string;
    marketplacePath: string;
  };
}

export interface PluginDiscoverySnapshot {
  plugins: DiscoveredPluginCandidate[];
  warnings: string[];
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveCanonicalPluginRoot(candidatePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(candidatePath);
    if (!stat.isDirectory()) return null;
    let hasManifest = false;
    for (const manifestPath of pluginManifestPathsForPluginRoot(candidatePath)) {
      if (await pathExists(manifestPath)) {
        hasManifest = true;
        break;
      }
    }
    if (!hasManifest) return null;
    return await fs.realpath(candidatePath);
  } catch {
    return null;
  }
}

async function resolveCanonicalDirectory(dirPath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) return null;
    return await fs.realpath(dirPath);
  } catch {
    return null;
  }
}

async function discoverMarketplacePlugins(opts: {
  pluginsDir: string;
  scope: PluginScope;
}): Promise<{ plugins: DiscoveredPluginCandidate[]; warnings: string[] }> {
  const marketplacePath = path.join(opts.pluginsDir, "marketplace.json");
  if (!(await pathExists(marketplacePath))) {
    return { plugins: [], warnings: [] };
  }

  let marketplace: ParsedMarketplaceDocument;
  try {
    const raw = await fs.readFile(marketplacePath, "utf-8");
    marketplace = parsePluginMarketplace(raw, marketplacePath);
  } catch (error) {
    return {
      plugins: [],
      warnings: [
        `[plugins] Ignoring malformed marketplace at ${marketplacePath}: ${String(error)}`,
      ],
    };
  }

  const plugins: DiscoveredPluginCandidate[] = [];
  const warnings: string[] = [];
  for (const pluginEntry of marketplace.plugins) {
    const realRootDir = await resolveCanonicalPluginRoot(pluginEntry.sourcePath);
    if (!realRootDir) {
      warnings.push(
        `[plugins] Ignoring marketplace entry "${pluginEntry.name}" from ${marketplacePath}: missing plugin manifest under ${pluginEntry.sourcePath}`,
      );
      continue;
    }
    plugins.push({
      rootDir: pluginEntry.sourcePath,
      realRootDir,
      scope: opts.scope,
      discoveryKind: "marketplace",
      marketplace: {
        name: marketplace.name,
        ...(marketplace.displayName ? { displayName: marketplace.displayName } : {}),
        category: pluginEntry.category,
        installationPolicy: pluginEntry.installationPolicy,
        authenticationPolicy: pluginEntry.authenticationPolicy,
        ...(pluginEntry.displayName ? { pluginDisplayName: pluginEntry.displayName } : {}),
        marketplacePath: marketplace.marketplacePath,
      },
    });
  }

  return { plugins, warnings };
}

async function discoverDirectPlugins(opts: {
  pluginsDir: string;
  scope: PluginScope;
}): Promise<DiscoveredPluginCandidate[]> {
  let dirents: Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }> =
    [];
  try {
    dirents = await fs.readdir(opts.pluginsDir, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    const parsedCode = errorWithCodeSchema.safeParse(error);
    if (!parsedCode.success || parsedCode.data.code !== "ENOENT") {
      throw error;
    }
    return [];
  }

  const plugins: DiscoveredPluginCandidate[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
    const rootDir = path.join(opts.pluginsDir, dirent.name);
    const realRootDir = await resolveCanonicalPluginRoot(rootDir);
    if (!realRootDir) continue;
    plugins.push({
      rootDir,
      realRootDir,
      scope: opts.scope,
      discoveryKind: "direct",
    });
  }
  return plugins;
}

export async function discoverPlugins(opts: {
  workspacePluginsDir?: string;
  userPluginsDir?: string;
}): Promise<PluginDiscoverySnapshot> {
  const warnings: string[] = [];
  const discovered: DiscoveredPluginCandidate[] = [];
  const seenByRootPath = new Set<string>();
  const seenByCanonicalRoot = new Map<string, DiscoveredPluginCandidate>();

  const scopes: Array<{ scope: PluginScope; pluginsDir?: string }> = [
    { scope: "workspace", pluginsDir: opts.workspacePluginsDir },
    { scope: "user", pluginsDir: opts.userPluginsDir },
  ];

  // Record a candidate at most once per literal root path AND per canonical
  // (scope, realRootDir) pair. Marketplace entries are recorded before direct
  // entries within a scope, so this preserves first-wins precedence (marketplace
  // over direct, workspace over user) while collapsing aliases — e.g. two
  // marketplace entries whose source paths resolve to the same canonical plugin
  // root — into a single discovered candidate.
  const recordPlugin = (plugin: DiscoveredPluginCandidate) => {
    if (seenByRootPath.has(plugin.rootDir)) return;
    const dedupeKey = `${plugin.scope}:${plugin.realRootDir}`;
    if (seenByCanonicalRoot.has(dedupeKey)) return;
    seenByRootPath.add(plugin.rootDir);
    seenByCanonicalRoot.set(dedupeKey, plugin);
    discovered.push(plugin);
  };

  for (const scopeEntry of scopes) {
    if (!scopeEntry.pluginsDir) continue;
    const realPluginsDir = await resolveCanonicalDirectory(scopeEntry.pluginsDir);
    if (!realPluginsDir || seenByRootPath.has(realPluginsDir)) continue;
    seenByRootPath.add(realPluginsDir);

    const { plugins: marketplacePlugins, warnings: marketplaceWarnings } =
      await discoverMarketplacePlugins({
        pluginsDir: scopeEntry.pluginsDir,
        scope: scopeEntry.scope,
      });
    warnings.push(...marketplaceWarnings);

    for (const plugin of marketplacePlugins) {
      recordPlugin(plugin);
    }

    const directPlugins = await discoverDirectPlugins({
      pluginsDir: scopeEntry.pluginsDir,
      scope: scopeEntry.scope,
    });
    for (const plugin of directPlugins) {
      recordPlugin(plugin);
    }
  }

  return {
    plugins: discovered.sort((left, right) => left.realRootDir.localeCompare(right.realRootDir)),
    warnings,
  };
}
