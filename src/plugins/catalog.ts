import type { AgentConfig, PluginCatalogEntry, PluginCatalogSnapshot, PluginScope } from "../types";
import { discoverPlugins, type DiscoveredPluginCandidate } from "./discovery";
import {
  buildPluginCatalogEntry,
  readPluginAppSummaries,
  readPluginManifest,
  readPluginSkillSummaries,
} from "./manifest";
import { readPluginMcpServers } from "./mcp";
import { isPluginEnabled, isPluginSkillEnabled, readPluginOverrides } from "./overrides";

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

function entryWarnings(candidate: DiscoveredPluginCandidate, extraWarnings: string[] = []): string[] {
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

export async function buildPluginCatalogSnapshot(config: AgentConfig): Promise<PluginCatalogSnapshot> {
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
        warnings: entryWarnings(candidate, [
          ...skillWarnings,
          ...(mcpSummary.warning ? [mcpSummary.warning] : []),
        ]),
        ...(candidate.marketplace
          ? {
              marketplace: {
                name: candidate.marketplace.name,
                ...(candidate.marketplace.displayName ? { displayName: candidate.marketplace.displayName } : {}),
                ...(candidate.marketplace.category ? { category: candidate.marketplace.category } : {}),
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
          enabled: pluginEnabled && isPluginSkillEnabled(manifest.name, scope, skill.rawName, overrides),
        };
      });
      plugins.push(entry);
    } catch (error) {
      warnings.push(`[plugins] Failed to catalog plugin at ${candidate.rootDir}: ${String(error)}`);
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
  const matches = opts.catalog.plugins.filter((plugin) =>
    plugin.id === opts.pluginId && (opts.scope === undefined || plugin.scope === opts.scope));

  if (matches.length === 1) {
    return { plugin: matches[0] ?? null };
  }

  if (matches.length === 0) {
    return {
      plugin: null,
      error: opts.scope !== undefined
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
