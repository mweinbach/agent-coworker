import fs from "node:fs/promises";

import type { AgentConfig, PluginCatalogEntry, PluginCatalogSnapshot, PluginScope } from "../types";
import { discoverPlugins, type DiscoveredPluginCandidate } from "./discovery";
import {
  buildPluginCatalogEntry,
  readPluginAppSummaries,
  readPluginManifest,
  readPluginSkillSummaries,
} from "./manifest";
import { parsePluginMcpDocument } from "./mcp";
import { isPluginEnabled, isPluginSkillEnabled, readPluginOverrides } from "./overrides";

function resolvePluginScope(config: AgentConfig, pluginRoot: string): PluginScope {
  if (config.workspacePluginsDir && pluginRoot.startsWith(config.workspacePluginsDir)) {
    return "workspace";
  }
  return "user";
}

async function readPluginMcpServerNames(mcpPath: string | undefined): Promise<string[]> {
  if (!mcpPath) return [];
  try {
    const raw = await fs.readFile(mcpPath, "utf-8");
    return parsePluginMcpDocument(raw, mcpPath).servers.map((server) => server.name);
  } catch {
    return [];
  }
}

function entryWarnings(candidate: DiscoveredPluginCandidate, extraWarnings: string[] = []): string[] {
  return [...extraWarnings].filter((warning) => warning.trim().length > 0);
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
      const skills = await readPluginSkillSummaries(manifest);
      const normalizedSkills = skills.map((skill) => ({
        ...skill,
        warnings: [...skill.warnings],
      }));
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
        mcpServers: await readPluginMcpServerNames(manifest.mcpPath),
        apps: await readPluginAppSummaries(manifest.appPath),
        warnings: entryWarnings(candidate),
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

  plugins.sort((left, right) =>
    `${left.scope}:${left.displayName}:${left.id}`.localeCompare(`${right.scope}:${right.displayName}:${right.id}`),
  );

  return { plugins, warnings };
}
