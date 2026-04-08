import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { PluginDiscoveryKind, PluginScope } from "../types";
import { manifestPathForPluginRoot } from "./manifest";
import { parsePluginMarketplace, type ParsedMarketplaceDocument, type ParsedMarketplacePluginEntry } from "./marketplace";

const errorWithCodeSchema = z.object({ code: z.string() }).passthrough();

export interface DiscoveredPluginCandidate {
  rootDir: string;
  realRootDir: string;
  scope: PluginScope;
  discoveryKind: PluginDiscoveryKind;
  warnings: string[];
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

async function readMarketplaceDocument(marketplacePath: string): Promise<ParsedMarketplaceDocument | null> {
  try {
    const raw = await fs.readFile(marketplacePath, "utf-8");
    return parsePluginMarketplace(raw, marketplacePath);
  } catch {
    return null;
  }
}

async function resolveCanonicalPluginRoot(candidatePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(candidatePath);
    if (!stat.isDirectory()) return null;
    const manifestPath = manifestPathForPluginRoot(candidatePath);
    if (!(await pathExists(manifestPath))) return null;
    return await fs.realpath(candidatePath);
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
      warnings: [`[plugins] Ignoring malformed marketplace at ${marketplacePath}: ${String(error)}`],
    };
  }

  const plugins: DiscoveredPluginCandidate[] = [];
  const warnings: string[] = [];
  for (const pluginEntry of marketplace.plugins) {
    const realRootDir = await resolveCanonicalPluginRoot(pluginEntry.sourcePath);
    if (!realRootDir) {
      warnings.push(
        `[plugins] Ignoring marketplace entry "${pluginEntry.name}" from ${marketplacePath}: missing .codex-plugin/plugin.json under ${pluginEntry.sourcePath}`,
      );
      continue;
    }
    plugins.push({
      rootDir: pluginEntry.sourcePath,
      realRootDir,
      scope: opts.scope,
      discoveryKind: "marketplace",
      warnings: [],
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
  let dirents: Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }> = [];
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
      warnings: [],
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
  const seenByRootPath = new Map<string, DiscoveredPluginCandidate>();

  const scopes: Array<{ scope: PluginScope; pluginsDir?: string }> = [
    { scope: "workspace", pluginsDir: opts.workspacePluginsDir },
    { scope: "user", pluginsDir: opts.userPluginsDir },
  ];

  for (const scopeEntry of scopes) {
    if (!scopeEntry.pluginsDir) continue;
    const { plugins: marketplacePlugins, warnings: marketplaceWarnings } = await discoverMarketplacePlugins({
      pluginsDir: scopeEntry.pluginsDir,
      scope: scopeEntry.scope,
    });
    warnings.push(...marketplaceWarnings);

    for (const plugin of marketplacePlugins) {
      if (seenByRootPath.has(plugin.rootDir)) continue;
      seenByRootPath.set(plugin.rootDir, plugin);
      discovered.push(plugin);
    }

    const directPlugins = await discoverDirectPlugins({
      pluginsDir: scopeEntry.pluginsDir,
      scope: scopeEntry.scope,
    });
    for (const plugin of directPlugins) {
      if (seenByRootPath.has(plugin.rootDir)) continue;
      seenByRootPath.set(plugin.rootDir, plugin);
      discovered.push(plugin);
    }
  }

  return {
    plugins: discovered.sort((left, right) => left.realRootDir.localeCompare(right.realRootDir)),
    warnings,
  };
}
