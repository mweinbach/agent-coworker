import type { FetchLike } from "../extensions/source";
import { getSkillCatalog, installSourceFromOrigin } from "../skills/operations";
import type { AgentConfig, InstalledPluginCatalogEntry, SkillInstallationEntry } from "../types";
import { buildPluginCatalogSnapshot } from "./catalog";
import type { ParsedMarketplaceDocument } from "./marketplace";
import {
  type ConfiguredMarketplace,
  fetchConfiguredMarketplaceById,
  type MarketplaceListEntry,
} from "./marketplaceRegistry";

type MarketplaceDetailPluginEntry = {
  name: string;
  displayName: string;
  category?: string;
  icon?: string;
  installed: boolean;
  enabled?: boolean;
  installSource?: string;
  skills: string[];
  mcpServers: string[];
};

type MarketplaceDetailSkillEntry = {
  name: string;
  displayName: string;
  category?: string;
  icon?: string;
  installed: boolean;
  enabled?: boolean;
  installSource?: string;
};

type MarketplaceDetailConnectorEntry = {
  name: string;
  pluginName: string;
  pluginDisplayName: string;
  installed: boolean;
};

export type MarketplaceDetail = {
  source: MarketplaceListEntry;
  plugins: MarketplaceDetailPluginEntry[];
  skills: MarketplaceDetailSkillEntry[];
  connectors: MarketplaceDetailConnectorEntry[];
};

function detailSourceEntry(
  source: ConfiguredMarketplace,
  document: ParsedMarketplaceDocument,
): MarketplaceListEntry {
  return {
    id: source.id,
    repo: source.repo,
    ref: source.ref,
    url: source.url,
    marketplacePath: source.marketplacePath,
    builtIn: source.builtIn,
    displayName: document.displayName ?? document.name,
    pluginCount: document.plugins.length,
    skillCount: document.skills.length,
    ...(source.addedAt ? { addedAt: source.addedAt } : {}),
  };
}

function normalizeInstallSource(input: string | null | undefined): string | null {
  const normalized = input?.trim().replace(/\/+$/g, "") ?? "";
  return normalized.length > 0 ? normalized : null;
}

function detailPluginEntry(
  entry: ParsedMarketplaceDocument["plugins"][number],
  installedPlugin: InstalledPluginCatalogEntry | undefined,
): MarketplaceDetailPluginEntry {
  const base = {
    name: entry.name,
    displayName: entry.displayName ?? entry.name,
    ...(entry.category ? { category: entry.category } : {}),
    ...(entry.icon ? { icon: entry.icon } : {}),
  };
  if (installedPlugin) {
    return {
      ...base,
      installed: true,
      enabled: installedPlugin.enabled,
      skills: installedPlugin.skills.map((skill) => skill.rawName),
      mcpServers: [...installedPlugin.mcpServers],
    };
  }
  return {
    ...base,
    installed: false,
    ...(entry.sourceInput ? { installSource: entry.sourceInput } : {}),
    skills: [],
    mcpServers: [],
  };
}

function findInstalledSkill(
  entry: ParsedMarketplaceDocument["skills"][number],
  standaloneInstallations: SkillInstallationEntry[],
  sourceRepo: string,
): SkillInstallationEntry | undefined {
  const normalizedRepo = sourceRepo.trim().toLowerCase();
  const normalizedEntrySource = normalizeInstallSource(entry.sourceInput);
  return standaloneInstallations.find((installation) => {
    if (installation.name !== entry.name) return false;
    const originRepo = installation.origin?.repo?.trim().toLowerCase();
    if (originRepo === normalizedRepo) return true;
    // Fallback: match the recorded install source against the marketplace entry's
    // sourceInput, mirroring annotateMarketplaceSkillUpdates in skills/operations.
    if (!normalizedEntrySource) return false;
    return normalizeInstallSource(installSourceFromOrigin(installation)) === normalizedEntrySource;
  });
}

function detailSkillEntry(
  entry: ParsedMarketplaceDocument["skills"][number],
  installation: SkillInstallationEntry | undefined,
): MarketplaceDetailSkillEntry {
  const base = {
    name: entry.name,
    displayName: entry.displayName ?? entry.name,
    ...(entry.category ? { category: entry.category } : {}),
    ...(entry.icon ? { icon: entry.icon } : {}),
  };
  if (installation) {
    return { ...base, installed: true, enabled: installation.enabled };
  }
  return {
    ...base,
    installed: false,
    ...(entry.sourceInput ? { installSource: entry.sourceInput } : {}),
  };
}

/**
 * Assemble everything one configured marketplace includes — its plugins, its
 * standalone skills, and the connectors (MCP servers) contributed by installed
 * plugins — annotated with local installed/enabled state. Unknown ids and
 * manifest fetch failures throw so session wrappers can surface them through
 * the standard error path.
 */
export async function buildMarketplaceDetail(opts: {
  config: AgentConfig;
  id: string;
  fetchImpl?: FetchLike;
}): Promise<MarketplaceDetail> {
  const { source, document } = await fetchConfiguredMarketplaceById({
    config: opts.config,
    id: opts.id,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  const [pluginCatalog, skillCatalog] = await Promise.all([
    buildPluginCatalogSnapshot(opts.config),
    getSkillCatalog(opts.config),
  ]);

  // Installed copies of this marketplace's plugins: same id and recorded
  // marketplace provenance. Workspace copies win when both scopes exist
  // (the catalog is sorted workspace-first).
  const installedPlugins = new Map<string, InstalledPluginCatalogEntry>();
  for (const plugin of pluginCatalog.plugins) {
    if (plugin.marketplace?.name !== document.name) continue;
    if (!installedPlugins.has(plugin.id)) {
      installedPlugins.set(plugin.id, plugin);
    }
  }

  const standaloneInstallations = skillCatalog.installations.filter(
    (installation) => !installation.plugin,
  );

  const plugins = document.plugins.map((entry) =>
    detailPluginEntry(entry, installedPlugins.get(entry.name)),
  );
  const skills = document.skills.map((entry) =>
    detailSkillEntry(entry, findInstalledSkill(entry, standaloneInstallations, source.repo)),
  );

  // Connectors only exist locally once a plugin is installed; the remote
  // manifest alone cannot enumerate them.
  const connectors: MarketplaceDetailConnectorEntry[] = [];
  for (const entry of document.plugins) {
    const installedPlugin = installedPlugins.get(entry.name);
    if (!installedPlugin) continue;
    for (const serverName of installedPlugin.mcpServers) {
      connectors.push({
        name: serverName,
        pluginName: installedPlugin.id,
        pluginDisplayName: installedPlugin.displayName,
        installed: true,
      });
    }
  }

  return {
    source: detailSourceEntry(source, document),
    plugins,
    skills,
    connectors,
  };
}
