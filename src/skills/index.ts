import type { SkillEntry } from "../types";
import { scanSkillCatalog, toLegacySkillEntry } from "./catalog";

export async function discoverSkills(
  skillsDirs: string[],
  opts: { includeDisabled?: boolean } = {}
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

export function stripSkillFrontMatter(raw: string): string {
  const re = /^\ufeff?---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/;
  const body = raw.replace(re, "");
  return body.trimStart();
}
