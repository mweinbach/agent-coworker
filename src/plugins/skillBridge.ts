import type { AgentConfig, PluginCatalogSnapshot, SkillPluginOwner, SkillScope, SkillScopeDescriptor } from "../types";
import { buildPluginCatalogSnapshot } from "./catalog";
import { isPluginEnabled, isPluginSkillEnabled, readPluginOverrides } from "./overrides";

export interface PluginSkillCatalogSource {
  descriptor: SkillScopeDescriptor;
  owner: SkillPluginOwner;
  skillsDir: string;
  enabledSkillNames: Set<string>;
}

function pluginSkillScope(scope: SkillPluginOwner["scope"]): SkillScope {
  return scope === "workspace" ? "project" : "user";
}

function pluginOwnerForEntry(entry: PluginCatalogSnapshot["plugins"][number]): SkillPluginOwner {
  return {
    pluginId: entry.id,
    name: entry.name,
    displayName: entry.displayName,
    scope: entry.scope,
    discoveryKind: entry.discoveryKind,
    rootDir: entry.rootDir,
  };
}

export async function buildPluginSkillSources(
  config: AgentConfig,
  catalog?: PluginCatalogSnapshot,
): Promise<PluginSkillCatalogSource[]> {
  const snapshot = catalog ?? await buildPluginCatalogSnapshot(config);
  const overrides = await readPluginOverrides(config);
  const sources: PluginSkillCatalogSource[] = [];

  for (const plugin of snapshot.plugins) {
    const enabledPlugin = isPluginEnabled(plugin, overrides) && plugin.enabled;
    if (!enabledPlugin) continue;
    if (plugin.skills.length === 0) continue;
    const owner = pluginOwnerForEntry(plugin);
    const enabledSkillNames = new Set(
      plugin.skills
        .filter((skill) => isPluginSkillEnabled(plugin.id, plugin.scope, skill.rawName, overrides) && skill.enabled)
        .map((skill) => skill.rawName),
    );
    if (enabledSkillNames.size === 0) continue;
    sources.push({
      descriptor: {
        scope: pluginSkillScope(plugin.scope),
        skillsDir: plugin.skillsPath,
        writable: false,
        readable: true,
      },
      owner,
      skillsDir: plugin.skillsPath,
      enabledSkillNames,
    });
  }

  return sources;
}
