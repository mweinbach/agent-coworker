import fs from "node:fs/promises";
import path from "node:path";

import { legacyManifestPathForPluginRoot, manifestPathForPluginRoot } from "../plugins";
import { getSkillScopeDescriptors } from "../skills/catalog";
import { manifestPathForSkillRoot } from "../skills/manifest";
import type { AgentConfig } from "../types";

async function statToken(targetPath: string): Promise<string> {
  try {
    const stat = await fs.stat(targetPath);
    const kind = stat.isDirectory() ? "d" : stat.isFile() ? "f" : "o";
    return `${targetPath}\0${kind}\0${stat.mtimeMs}\0${stat.size}`;
  } catch {
    return `${targetPath}\0missing`;
  }
}

async function listChildPaths(rootDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink() || entry.isFile())
      .map((entry) => path.join(rootDir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

async function addStandaloneSkillPaths(paths: Set<string>, rootDir: string): Promise<void> {
  paths.add(rootDir);
  for (const childPath of await listChildPaths(rootDir)) {
    paths.add(childPath);
    paths.add(path.join(childPath, "SKILL.md"));
    paths.add(manifestPathForSkillRoot(childPath));
  }
}

async function addPluginPaths(paths: Set<string>, pluginsDir: string): Promise<void> {
  paths.add(pluginsDir);
  paths.add(path.join(pluginsDir, "marketplace.json"));
  for (const pluginRoot of await listChildPaths(pluginsDir)) {
    paths.add(pluginRoot);
    paths.add(manifestPathForPluginRoot(pluginRoot));
    paths.add(legacyManifestPathForPluginRoot(pluginRoot));
    paths.add(path.join(pluginRoot, ".mcp.json"));
    paths.add(path.join(pluginRoot, ".app.json"));

    const defaultSkillsDir = path.join(pluginRoot, "skills");
    paths.add(defaultSkillsDir);
    for (const skillRoot of await listChildPaths(defaultSkillsDir)) {
      paths.add(skillRoot);
      paths.add(path.join(skillRoot, "SKILL.md"));
    }
  }
}

export async function readSkillCatalogMtimeSnapshot(config: AgentConfig): Promise<string> {
  const paths = new Set<string>();
  for (const descriptor of getSkillScopeDescriptors(config.skillsDirs)) {
    await addStandaloneSkillPaths(paths, descriptor.skillsDir);
    if (descriptor.disabledSkillsDir) {
      await addStandaloneSkillPaths(paths, descriptor.disabledSkillsDir);
    }
  }

  if (config.workspacePluginsDir) {
    await addPluginPaths(paths, config.workspacePluginsDir);
  }
  if (config.userPluginsDir) {
    await addPluginPaths(paths, config.userPluginsDir);
  }

  const tokens = await Promise.all([...paths].sort().map((targetPath) => statToken(targetPath)));
  return tokens.join("\n");
}
