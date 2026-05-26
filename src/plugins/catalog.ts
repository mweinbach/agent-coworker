import type { FetchLike } from "../extensions/source";
import type { AgentConfig, PluginCatalogEntry, PluginCatalogSnapshot, PluginScope } from "../types";
import { type DiscoveredPluginCandidate, discoverPlugins } from "./discovery";
import {
  buildPluginCatalogEntry,
  type PluginManifest,
  readPluginAppSummaries,
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
  installed?: boolean;
  installSource?: string;
  applySkillOverrides?: boolean;
  overrides: Awaited<ReturnType<typeof readPluginOverrides>>;
  candidateWarnings?: string[];
}): Promise<PluginCatalogEntry> {
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
    ...(opts.installed !== undefined ? { installed: opts.installed } : {}),
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

function isPluginFromMarketplace(
  plugin: PluginCatalogEntry,
  marketplaceName: string,
): boolean {
  return plugin.discoveryKind === "marketplace" && plugin.marketplace?.name === marketplaceName;
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
      const scope = candidate.scope ?? resolvePluginScope(config, candidate.rootDir);
      const pluginEnabled = isPluginEnabled(
        {
          id: manifest.name,
          name: manifest.name,
          displayName: manifest.interface?.displayName ?? manifest.name,
          description: manifest.description,
          scope,
          discoveryKind: candidate.discoveryKind,
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
        discoveryKind: candidate.discoveryKind,
        enabled: pluginEnabled,
        overrides,
        candidateWarnings: _entryWarnings(candidate),
        installed: true,
        ...(candidate.marketplace
          ? {
              marketplace: {
                name: candidate.marketplace.name,
                ...(candidate.marketplace.displayName
                  ? { displayName: candidate.marketplace.displayName }
                  : {}),
                ...(candidate.marketplace.category
                  ? { category: candidate.marketplace.category }
                  : {}),
                ...(candidate.marketplace.installationPolicy
                  ? { installationPolicy: candidate.marketplace.installationPolicy }
                  : {}),
                ...(candidate.marketplace.authenticationPolicy
                  ? { authenticationPolicy: candidate.marketplace.authenticationPolicy }
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
            plugin.installed = true;
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

        const materialized = await materializePluginSource({
          input: marketplaceEntry.sourceInput,
          fetchImpl: opts.fetchImpl,
        });
        try {
          const candidate = materialized.candidates.find(
            (entry) => entry.pluginId === marketplaceEntry.name && entry.diagnostics.length === 0,
          );
          if (!candidate) {
            warnings.push(
              `[plugins] Remote marketplace entry "${marketplaceEntry.name}" did not contain a valid plugin bundle with a matching plugin name.`,
            );
            continue;
          }
          const manifest = await readPluginManifest(candidate.rootDir);
          plugins.push(
            await buildPluginCatalogEntryFromManifest({
              manifest,
              scope: "user",
              discoveryKind: "marketplace",
              enabled: false,
              overrides,
              marketplace: marketplaceMetadata,
              installed: false,
              installSource: marketplaceEntry.sourceInput,
              applySkillOverrides: false,
            }),
          );
        } finally {
          await materialized.cleanup();
        }
      }
    } catch (error) {
      warnings.push(`[plugins] Failed to load remote marketplace: ${String(error)}`);
    }
  }

  plugins.sort(comparePluginCatalogEntries);

  return { plugins, warnings };
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
