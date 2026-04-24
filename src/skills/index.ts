import path from "node:path";
import { buildPluginCatalogSnapshot, comparePluginCatalogEntries } from "../plugins";
import type { AgentConfig, SkillEntry, SkillScope, SkillScopeDescriptor } from "../types";
import {
  type SkillCatalogSource,
  scanSkillCatalog,
  scanSkillCatalogFromSources,
  toLegacySkillEntry,
} from "./catalog";

export { extractTriggers } from "./catalog";

function standaloneScopeForIndex(index: number): SkillScope {
  return (["project", "global", "user", "built-in"][index] ?? "built-in") as SkillScope;
}

function descriptorForSkillsDir(skillsDir: string, index: number): SkillScopeDescriptor {
  const scope = standaloneScopeForIndex(index);
  const writable = scope === "project" || scope === "global";
  const disabledSkillsDir =
    path.basename(skillsDir) === "skills"
      ? path.join(path.dirname(skillsDir), "disabled-skills")
      : undefined;
  return {
    scope,
    skillsDir,
    ...(disabledSkillsDir ? { disabledSkillsDir } : {}),
    writable,
    readable: true,
  };
}

function standaloneSources(skillsDirs: string[]): SkillCatalogSource[] {
  return skillsDirs.map((skillsDir, index) => ({
    kind: "standalone" as const,
    descriptor: descriptorForSkillsDir(skillsDir, index),
  }));
}

export async function discoverSkills(
  skillsDirs: string[],
  opts: { includeDisabled?: boolean } = {},
): Promise<SkillEntry[]> {
  const catalog = await scanSkillCatalog(skillsDirs, {
    includeDisabled: opts.includeDisabled === true,
  });
  const filtered = opts.includeDisabled
    ? catalog.installations
    : catalog.installations.filter((installation) => installation.enabled);

  const seen = new Set<string>();
  const out: SkillEntry[] = [];
  for (const installation of filtered) {
    if (installation.state === "invalid") {
      continue;
    }
    if (seen.has(installation.name)) {
      continue;
    }
    const legacyEntry = toLegacySkillEntry(installation);
    if (!legacyEntry) {
      continue;
    }
    seen.add(legacyEntry.name);
    out.push(legacyEntry);
  }

  return out;
}

export async function discoverSkillsForConfig(
  config: AgentConfig,
  opts: {
    includeDisabled?: boolean;
    pluginCatalog?: Awaited<ReturnType<typeof buildPluginCatalogSnapshot>>;
  } = {},
): Promise<SkillEntry[]> {
  const pluginCatalog = opts.pluginCatalog ?? (await buildPluginCatalogSnapshot(config));
  const orderedPlugins = [...pluginCatalog.plugins].sort(comparePluginCatalogEntries);
  const catalog = await scanSkillCatalogFromSources(
    [
      ...standaloneSources(config.skillsDirs),
      ...orderedPlugins.flatMap((plugin) =>
        plugin.skills.map((skill) => ({
          kind: "plugin" as const,
          plugin,
          skill,
          enabled: skill.enabled,
        })),
      ),
    ],
    {
      includeDisabled: opts.includeDisabled === true,
    },
  );
  const filtered = opts.includeDisabled
    ? catalog.installations
    : catalog.installations.filter((installation) => installation.enabled);

  const seen = new Set<string>();
  const out: SkillEntry[] = [];
  for (const installation of filtered) {
    if (installation.state === "invalid") continue;
    if (seen.has(installation.name)) continue;
    const legacyEntry = toLegacySkillEntry(installation);
    if (!legacyEntry) continue;
    seen.add(legacyEntry.name);
    out.push(legacyEntry);
  }
  return out;
}

export function stripSkillFrontMatter(raw: string): string {
  const re = /^\ufeff?---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/;
  const body = raw.replace(re, "");
  return body.trimStart();
}
