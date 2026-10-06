import { buildPluginCatalogSnapshot, comparePluginCatalogEntries } from "../plugins";
import type { AgentConfig, SkillEntry, SkillInstallationEntry } from "../types";
import {
  buildSkillCatalogSources,
  scanSkillCatalog,
  scanSkillCatalogFromSources,
  toLegacySkillEntry,
} from "./catalog";
import { isSkillDiscoveryAllowed } from "./featureGates";

export { extractTriggers } from "./catalog";

function toDedupedSkillEntries(installations: SkillInstallationEntry[]): SkillEntry[] {
  const seen = new Set<string>();
  const out: SkillEntry[] = [];
  for (const installation of [
    ...installations.filter((i) => i.enabled),
    ...installations.filter((i) => !i.enabled),
  ]) {
    if (installation.state === "invalid" || seen.has(installation.name)) continue;
    const legacyEntry = toLegacySkillEntry(installation);
    if (!legacyEntry) continue;
    seen.add(legacyEntry.name);
    out.push(legacyEntry);
  }
  return out;
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

  return toDedupedSkillEntries(filtered);
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
    buildSkillCatalogSources(config.skillsDirs, orderedPlugins, [
      "project",
      "global",
      "user",
      "built-in",
    ]),
    {
      includeDisabled: opts.includeDisabled === true,
    },
  );
  const filtered = (
    opts.includeDisabled
      ? catalog.installations
      : catalog.installations.filter((installation) => installation.enabled)
  ).filter((installation) => isSkillDiscoveryAllowed(config, installation));

  return toDedupedSkillEntries(filtered);
}

export function stripSkillFrontMatter(raw: string): string {
  const re = /^\ufeff?---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/;
  return raw.replace(re, "").trimStart();
}
