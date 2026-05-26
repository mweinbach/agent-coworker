import type {
  AgentConfig,
  PluginCatalogEntry,
  PluginCatalogSnapshot,
  PluginScope,
} from "../types";
import { BUILT_IN_MARKETPLACES, type RemoteMarketplaceConfig } from "./builtInMarketplaces";
import { type DiscoveredPluginCandidate, discoverPlugins } from "./discovery";
import {
  buildPluginCatalogEntry,
  readPluginAppSummaries,
  readPluginManifest,
  readPluginSkillSummaries,
} from "./manifest";
import { readPluginMcpServers } from "./mcp";
import { isPluginEnabled, isPluginSkillEnabled, readPluginOverrides } from "./overrides";
import {
  fetchRemoteMarketplaces,
  type RemoteMarketplaceSnapshot,
} from "./remoteMarketplace";

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

function shouldFetchRemoteMarketplaces(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const flag = env.COWORK_DISABLE_REMOTE_MARKETPLACES?.trim().toLowerCase();
  if (!flag) return true;
  return !(flag === "1" || flag === "true" || flag === "yes" || flag === "on");
}

let remoteMarketplaceCache: {
  snapshots: RemoteMarketplaceSnapshot[];
  fetchedAt: number;
} | null = null;
const REMOTE_MARKETPLACE_CACHE_TTL_MS = 5 * 60 * 1000;

export function clearRemoteMarketplaceCache(): void {
  remoteMarketplaceCache = null;
}

async function loadRemoteMarketplaces(
  configs: readonly RemoteMarketplaceConfig[],
): Promise<{ snapshots: RemoteMarketplaceSnapshot[]; warnings: string[] }> {
  if (configs.length === 0) {
    return { snapshots: [], warnings: [] };
  }
  if (
    remoteMarketplaceCache &&
    Date.now() - remoteMarketplaceCache.fetchedAt < REMOTE_MARKETPLACE_CACHE_TTL_MS
  ) {
    return { snapshots: remoteMarketplaceCache.snapshots, warnings: [] };
  }
  const { snapshots, errors } = await fetchRemoteMarketplaces(configs);
  remoteMarketplaceCache = { snapshots, fetchedAt: Date.now() };
  return {
    snapshots,
    warnings: errors.map(
      (failure) =>
        `[plugins] Remote marketplace ${failure.config.id} unavailable: ${failure.error}`,
    ),
  };
}

function buildAvailableRemoteEntry(opts: {
  config: RemoteMarketplaceConfig;
  document: RemoteMarketplaceSnapshot["document"];
  pluginEntry: RemoteMarketplaceSnapshot["document"]["plugins"][number];
}): PluginCatalogEntry {
  const { config, document, pluginEntry } = opts;
  const displayName = pluginEntry.displayName ?? pluginEntry.name;
  const subdir = pluginEntry.sourcePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .filter((segment) => segment !== "__remote__" && segment !== config.id && segment !== "root")
    .join("/");

  return {
    id: pluginEntry.name,
    name: pluginEntry.name,
    displayName,
    description: pluginEntry.displayName ?? pluginEntry.name,
    scope: "user",
    discoveryKind: "marketplace",
    enabled: false,
    rootDir: "",
    manifestPath: "",
    skillsPath: "",
    marketplace: {
      name: document.name,
      ...(document.displayName ? { displayName: document.displayName } : {}),
      ...(pluginEntry.category ? { category: pluginEntry.category } : {}),
      installationPolicy: pluginEntry.installationPolicy,
      authenticationPolicy: pluginEntry.authenticationPolicy,
    },
    installState: "available",
    remoteSource: {
      marketplaceId: config.id,
      repo: config.repo,
      ref: config.ref,
      subdir,
    },
    skills: [],
    mcpServers: [],
    apps: [],
    warnings: [],
  };
}

export async function buildPluginCatalogSnapshot(
  config: AgentConfig,
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
      const { skills, warnings: skillWarnings } = await readPluginSkillSummaries(manifest);
      const normalizedSkills = skills.map((skill) => ({
        ...skill,
        warnings: [...skill.warnings],
      }));
      const mcpSummary = await readPluginMcpSummary(manifest.mcpPath);
      const entry = buildPluginCatalogEntry({
        pluginId: manifest.name,
        pluginManifest: manifest,
        scope,
        discoveryKind: candidate.discoveryKind,
        enabled: pluginEnabled,
        skills: normalizedSkills.map((skill) => ({
          ...skill,
          warnings: [...skill.warnings],
        })),
        mcpServers: mcpSummary.serverNames,
        apps: await readPluginAppSummaries(manifest.appPath),
        warnings: _entryWarnings(candidate, [
          ...skillWarnings,
          ...(mcpSummary.warning ? [mcpSummary.warning] : []),
        ]),
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
      entry.skills = entry.skills.map((skill) => {
        return {
          ...skill,
          enabled:
            pluginEnabled && isPluginSkillEnabled(manifest.name, scope, skill.rawName, overrides),
        };
      });
      entry.installState = "installed";
      plugins.push(entry);
    } catch (error) {
      warnings.push(`[plugins] Failed to catalog plugin at ${candidate.rootDir}: ${String(error)}`);
    }
  }

  if (shouldFetchRemoteMarketplaces()) {
    const { snapshots, warnings: remoteWarnings } = await loadRemoteMarketplaces(
      BUILT_IN_MARKETPLACES,
    );
    warnings.push(...remoteWarnings);
    const installedKeys = new Set(
      plugins.map((entry) => `${entry.marketplace?.name ?? ""}:${entry.name}`),
    );
    for (const snapshot of snapshots) {
      for (const pluginEntry of snapshot.document.plugins) {
        const key = `${snapshot.document.name}:${pluginEntry.name}`;
        if (installedKeys.has(key)) {
          continue;
        }
        plugins.push(
          buildAvailableRemoteEntry({
            config: snapshot.config,
            document: snapshot.document,
            pluginEntry,
          }),
        );
      }
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
