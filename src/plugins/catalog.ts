import type { FetchLike } from "../extensions/source";
import type {
  AgentConfig,
  InstalledPluginCatalogEntry,
  MarketplacePluginCatalogEntry,
  PluginCatalogEntry,
  PluginCatalogSnapshot,
  PluginScope,
} from "../types";
import { type DiscoveredPluginCandidate, discoverPlugins } from "./discovery";
import {
  buildPluginCatalogEntry,
  type PluginManifest,
  readPluginAppSummaries,
  readPluginInstallMetadata,
  readPluginManifest,
  readPluginSkillSummaries,
} from "./manifest";
import { readPluginMcpServers } from "./mcp";
import { isPluginEnabled, isPluginSkillEnabled, readPluginOverrides } from "./overrides";
import { fetchRemotePluginMarketplace } from "./remoteMarketplace";
import { materializePluginSource } from "./sourceResolver";

function resolvePluginScope(config: AgentConfig, pluginRoot: string): PluginScope {
  if (config.workspacePluginsDir && pluginRoot.startsWith(config.workspacePluginsDir)) {
    return "workspace";
  }
  return "user";
}

async function readPluginMcpSummary(
  mcpPath: string | undefined,
): Promise<{ serverNames: string[]; warning?: string }> {
  if (!mcpPath) {
    return { serverNames: [] };
  }
  try {
    return {
      serverNames: (await readPluginMcpServers(mcpPath)).map((server) => server.name),
    };
  } catch (error) {
    return {
      serverNames: [],
      warning: `[plugins] Invalid or unreadable bundled MCP config at ${mcpPath}: ${String(error)}`,
    };
  }
}

function _entryWarnings(
  _candidate: DiscoveredPluginCandidate,
  extraWarnings: string[] = [],
): string[] {
  return [...extraWarnings].filter((warning) => warning.trim().length > 0);
}

async function buildPluginCatalogEntryFromManifest(opts: {
  manifest: PluginManifest;
  scope: PluginScope;
  discoveryKind: PluginCatalogEntry["discoveryKind"];
  enabled: boolean;
  marketplace?: PluginCatalogEntry["marketplace"];
  installSource?: string;
  applySkillOverrides?: boolean;
  overrides: Awaited<ReturnType<typeof readPluginOverrides>>;
  candidateWarnings?: string[];
}): Promise<InstalledPluginCatalogEntry> {
  const { skills, warnings: skillWarnings } = await readPluginSkillSummaries(opts.manifest);
  const normalizedSkills = skills.map((skill) => ({
    ...skill,
    warnings: [...skill.warnings],
  }));
  const mcpSummary = await readPluginMcpSummary(opts.manifest.mcpPath);
  const entry = buildPluginCatalogEntry({
    pluginId: opts.manifest.name,
    pluginManifest: opts.manifest,
    scope: opts.scope,
    discoveryKind: opts.discoveryKind,
    enabled: opts.enabled,
    skills: normalizedSkills.map((skill) => ({
      ...skill,
      warnings: [...skill.warnings],
    })),
    mcpServers: mcpSummary.serverNames,
    apps: await readPluginAppSummaries(opts.manifest.appPath),
    warnings: [
      ...(opts.candidateWarnings ?? []),
      ...skillWarnings,
      ...(mcpSummary.warning ? [mcpSummary.warning] : []),
    ],
    ...(opts.marketplace ? { marketplace: opts.marketplace } : {}),
    ...(opts.installSource ? { installSource: opts.installSource } : {}),
  });
  entry.skills = entry.skills.map((skill) => {
    return {
      ...skill,
      enabled:
        opts.enabled &&
        (opts.applySkillOverrides === false
          ? skill.enabled
          : isPluginSkillEnabled(opts.manifest.name, opts.scope, skill.rawName, opts.overrides)),
    };
  });
  return entry;
}

function pluginScopePriority(scope: PluginScope): number {
  return scope === "workspace" ? 0 : 1;
}

export function comparePluginCatalogEntries(
  left: Pick<PluginCatalogEntry, "scope" | "displayName" | "id">,
  right: Pick<PluginCatalogEntry, "scope" | "displayName" | "id">,
): number {
  const scopeDelta = pluginScopePriority(left.scope) - pluginScopePriority(right.scope);
  if (scopeDelta !== 0) {
    return scopeDelta;
  }
  return `${left.displayName}:${left.id}`.localeCompare(`${right.displayName}:${right.id}`);
}

function isPluginFromMarketplace(plugin: PluginCatalogEntry, marketplaceName: string): boolean {
  return plugin.marketplace?.name === marketplaceName;
}

function buildRemoteMarketplaceCatalogEntry(opts: {
  marketplace: Awaited<ReturnType<typeof fetchRemotePluginMarketplace>>;
  plugin: Awaited<ReturnType<typeof fetchRemotePluginMarketplace>>["plugins"][number];
}): MarketplacePluginCatalogEntry | null {
  if (!opts.plugin.sourceInput) {
    return null;
  }
  const displayName = opts.plugin.displayName ?? opts.plugin.name;
  return {
    id: opts.plugin.name,
    name: opts.plugin.name,
    displayName,
    description: `Available from ${opts.marketplace.displayName ?? opts.marketplace.name}.`,
    scope: "user",
    discoveryKind: "marketplace",
    installed: false,
    enabled: false,
    interface: {
      displayName,
      shortDescription: opts.plugin.category,
    },
    marketplace: {
      name: opts.marketplace.name,
      ...(opts.marketplace.displayName ? { displayName: opts.marketplace.displayName } : {}),
      category: opts.plugin.category,
      installationPolicy: opts.plugin.installationPolicy,
      authenticationPolicy: opts.plugin.authenticationPolicy,
    },
    installSource: opts.plugin.sourceInput,
    warnings: [],
  };
}

export async function buildPluginCatalogSnapshot(
  config: AgentConfig,
  opts: {
    includeRemoteMarketplace?: boolean;
    fetchImpl?: FetchLike;
  } = {},
): Promise<PluginCatalogSnapshot> {
  const discovery = await discoverPlugins(config);
  const overrides = await readPluginOverrides(config);
  const plugins: PluginCatalogEntry[] = [];
  const warnings = [...discovery.warnings];

  for (const candidate of discovery.plugins) {
    try {
      const manifest = await readPluginManifest(candidate.rootDir);
      const installMetadata = await readPluginInstallMetadata(candidate.rootDir);
      const metadataMarketplace = installMetadata?.marketplace;
      const candidateMarketplace =
        candidate.marketplace ??
        (metadataMarketplace
          ? {
              name: metadataMarketplace.name,
              ...(metadataMarketplace.displayName
                ? { displayName: metadataMarketplace.displayName }
                : {}),
              ...(metadataMarketplace.category ? { category: metadataMarketplace.category } : {}),
              ...(metadataMarketplace.installationPolicy
                ? { installationPolicy: metadataMarketplace.installationPolicy }
                : {}),
              ...(metadataMarketplace.authenticationPolicy
                ? { authenticationPolicy: metadataMarketplace.authenticationPolicy }
                : {}),
            }
          : undefined);
      const discoveryKind = candidateMarketplace ? "marketplace" : candidate.discoveryKind;
      const scope = candidate.scope ?? resolvePluginScope(config, candidate.rootDir);
      const pluginEnabled = isPluginEnabled(
        {
          id: manifest.name,
          name: manifest.name,
          displayName: manifest.interface?.displayName ?? manifest.name,
          description: manifest.description,
          scope,
          discoveryKind,
          installed: true,
          enabled: true,
          rootDir: manifest.rootDir,
          manifestPath: manifest.manifestPath,
          skillsPath: manifest.skillsPath,
          ...(manifest.mcpPath ? { mcpPath: manifest.mcpPath } : {}),
          ...(manifest.appPath ? { appPath: manifest.appPath } : {}),
          skills: [],
          mcpServers: [],
          apps: [],
          warnings: [],
        },
        overrides,
      );
      const entry = await buildPluginCatalogEntryFromManifest({
        manifest,
        scope,
        discoveryKind,
        enabled: pluginEnabled,
        overrides,
        candidateWarnings: _entryWarnings(candidate),
        ...(metadataMarketplace?.sourceInput
          ? { installSource: metadataMarketplace.sourceInput }
          : {}),
        ...(candidateMarketplace
          ? {
              marketplace: {
                name: candidateMarketplace.name,
                ...(candidateMarketplace.displayName
                  ? { displayName: candidateMarketplace.displayName }
                  : {}),
                ...(candidateMarketplace.category
                  ? { category: candidateMarketplace.category }
                  : {}),
                ...(candidateMarketplace.installationPolicy
                  ? { installationPolicy: candidateMarketplace.installationPolicy }
                  : {}),
                ...(candidateMarketplace.authenticationPolicy
                  ? { authenticationPolicy: candidateMarketplace.authenticationPolicy }
                  : {}),
              },
            }
          : {}),
      });
      plugins.push(entry);
    } catch (error) {
      warnings.push(`[plugins] Failed to catalog plugin at ${candidate.rootDir}: ${String(error)}`);
    }
  }

  const includeRemoteMarketplace = opts.includeRemoteMarketplace ?? false;
  if (includeRemoteMarketplace) {
    try {
      const marketplace = await fetchRemotePluginMarketplace({ fetchImpl: opts.fetchImpl });
      for (const marketplaceEntry of marketplace.plugins) {
        const sameIdEntries = plugins.filter((plugin) => plugin.id === marketplaceEntry.name);
        const installedEntries = sameIdEntries.filter((plugin) =>
          isPluginFromMarketplace(plugin, marketplace.name),
        );
        const marketplaceMetadata = {
          name: marketplace.name,
          ...(marketplace.displayName ? { displayName: marketplace.displayName } : {}),
          category: marketplaceEntry.category,
          installationPolicy: marketplaceEntry.installationPolicy,
          authenticationPolicy: marketplaceEntry.authenticationPolicy,
        };
        if (installedEntries.length > 0) {
          for (const plugin of installedEntries) {
            plugin.marketplace = plugin.marketplace ?? marketplaceMetadata;
            if (marketplaceEntry.sourceInput) {
              plugin.installSource = marketplaceEntry.sourceInput;
            }
          }
          continue;
        }
        if (sameIdEntries.length > 0) {
          continue;
        }
        if (!marketplaceEntry.sourceInput) {
          continue;
        }

        const entry = buildRemoteMarketplaceCatalogEntry({
          marketplace,
          plugin: marketplaceEntry,
        });
        if (entry) {
          plugins.push(entry);
        }
      }
    } catch (error) {
      warnings.push(`[plugins] Failed to load remote marketplace: ${String(error)}`);
    }
  }

  plugins.sort(comparePluginCatalogEntries);

  return { plugins, warnings };
}

export async function buildRemoteMarketplacePluginDetail(opts: {
  pluginId: string;
  fetchImpl?: FetchLike;
}): Promise<MarketplacePluginCatalogEntry | null> {
  const marketplace = await fetchRemotePluginMarketplace({ fetchImpl: opts.fetchImpl });
  const marketplaceEntry = marketplace.plugins.find((entry) => entry.name === opts.pluginId);
  if (!marketplaceEntry) {
    return null;
  }
  const baseEntry = buildRemoteMarketplaceCatalogEntry({
    marketplace,
    plugin: marketplaceEntry,
  });
  if (!baseEntry) {
    return null;
  }

  let materialized: Awaited<ReturnType<typeof materializePluginSource>> | null = null;
  try {
    materialized = await materializePluginSource({
      input: baseEntry.installSource,
      fetchImpl: opts.fetchImpl,
    });
    const candidate = materialized.candidates.find((entry) => entry.pluginId === opts.pluginId);
    if (!candidate || candidate.diagnostics.length > 0) {
      return {
        ...baseEntry,
        warnings: [
          ...baseEntry.warnings,
          `Remote marketplace entry "${opts.pluginId}" did not contain a valid plugin bundle with a matching plugin name.`,
        ],
      };
    }
    const manifest = await readPluginManifest(candidate.rootDir);
    return {
      ...baseEntry,
      displayName: manifest.interface?.displayName ?? baseEntry.displayName,
      description: manifest.description,
      ...(manifest.interface ? { interface: manifest.interface } : {}),
    };
  } catch (error) {
    return {
      ...baseEntry,
      warnings: [
        ...baseEntry.warnings,
        `[plugins] Failed to load remote marketplace entry "${opts.pluginId}": ${String(error)}`,
      ],
    };
  } finally {
    await materialized?.cleanup();
  }
}

export function resolvePluginCatalogEntry(opts: {
  catalog: PluginCatalogSnapshot;
  pluginId: string;
  scope?: PluginScope;
}): { plugin: PluginCatalogEntry | null; error?: string } {
  const matches = opts.catalog.plugins.filter(
    (plugin) =>
      plugin.id === opts.pluginId && (opts.scope === undefined || plugin.scope === opts.scope),
  );

  if (matches.length === 1) {
    return { plugin: matches[0] ?? null };
  }

  if (matches.length === 0) {
    return {
      plugin: null,
      error:
        opts.scope !== undefined
          ? `Plugin "${opts.pluginId}" was not found in the ${opts.scope} scope.`
          : `Plugin "${opts.pluginId}" was not found.`,
    };
  }

  if (opts.scope !== undefined) {
    return {
      plugin: null,
      error: `Multiple "${opts.pluginId}" plugins were found in the ${opts.scope} scope. Resolve the duplicate installations before continuing.`,
    };
  }

  return {
    plugin: null,
    error: `Plugin "${opts.pluginId}" exists in multiple scopes. Specify whether you want the workspace or user copy.`,
  };
}
