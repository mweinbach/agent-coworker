import type { PluginCatalogEntry } from "../../../lib/wsProtocol";

export function pluginIcon(plugin: PluginCatalogEntry): string | undefined {
  return plugin.interface?.logo ?? plugin.interface?.composerIcon;
}

export function skillIcon(entry: {
  interface?: { iconSmall?: string; iconLarge?: string };
}): string | undefined {
  return entry.interface?.iconSmall ?? entry.interface?.iconLarge;
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
