import type { PluginCatalogEntry } from "../../../lib/wsProtocol";

export function pluginIcon(plugin: PluginCatalogEntry): string | undefined {
  return plugin.interface?.logo ?? plugin.interface?.composerIcon;
}

export function skillIcon(entry: {
  interface?: { iconSmall?: string; iconLarge?: string };
}): string | undefined {
  return entry.interface?.iconSmall ?? entry.interface?.iconLarge;
}

/**
 * Human-friendly name for a skill bundled inside a plugin. Prefers the skill's
 * declared displayName, then the un-namespaced raw name (or the `name` with a
 * leading `{pluginId}:` prefix stripped) converted from kebab-case to Title
 * Case (e.g. "apple-native-transcribe" → "Apple Native Transcribe").
 */
export function pluginSkillDisplayName(
  pluginId: string,
  skill: { name: string; rawName?: string; interface?: { displayName?: string } },
): string {
  const declared = skill.interface?.displayName?.trim();
  if (declared) return declared;
  const prefix = `${pluginId}:`;
  const rawName =
    skill.rawName ?? (skill.name.startsWith(prefix) ? skill.name.slice(prefix.length) : skill.name);
  const words = rawName.split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) return skill.name;
  return words.map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join(" ");
}

/** Case-insensitive substring match; `normalizedQuery` must already be trimmed + lowercased. */
export function matchesQuery(
  normalizedQuery: string,
  ...fields: Array<string | null | undefined>
): boolean {
  return fields.some((field) => field?.toLowerCase().includes(normalizedQuery) === true);
}

export function NoMatchesState({ query }: { query: string }) {
  return (
    <div className="px-4 py-10 text-center text-sm text-muted-foreground">
      No matches for &ldquo;{query}&rdquo;
    </div>
  );
}
