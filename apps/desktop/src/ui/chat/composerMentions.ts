import type { PluginCatalogSnapshot, SkillEntry, TurnReference } from "@/lib/wsProtocol";

/**
 * Shared base styling for an @-mention chip — a soft solid fill in the accent
 * color (not an outline). Used by the composer highlight overlay and the
 * transcript mention chips so they look identical. Per-use callers add padding.
 */
export const MENTION_CHIP_CLASS = "rounded-[5px] bg-primary/20 font-medium text-primary";

/**
 * Pure, DOM-free parsing for composer @-mentions of skills and plugins. The
 * composer text string is the single source of truth — segments, references,
 * and the active autocomplete query are all derived from it against the live
 * skill/plugin catalog. No parallel offset state is kept.
 */

export type MentionKind = "skill" | "plugin";

export type MentionItem = {
  kind: MentionKind;
  /** Canonical kebab-case token name (inserted as `@name`). */
  name: string;
  /** Display label for the menu (skill name or plugin display name). */
  label: string;
  description: string;
  /** Source/owner chip text (e.g. "Built-in", "Project", a plugin name, "Plugin"). */
  badge: string;
};

export type MentionCatalog = {
  /** Rich entries for the autocomplete menu (skills first, then plugins). */
  items: MentionItem[];
  /** All valid mention names sorted longest-first for greedy matching. */
  names: string[];
  /** Name → kind. Skill wins when a name is both a skill and a plugin. */
  kindByName: Map<string, MentionKind>;
};

export type ComposerSegment =
  | { type: "text"; text: string; start: number; end: number }
  | {
      type: "mention";
      kind: MentionKind;
      name: string;
      raw: string;
      start: number;
      end: number;
    };

export type ActiveMentionQuery = { start: number; query: string };

export const MAX_TURN_REFERENCES = 32;

// Characters that may appear in a kebab-case skill/plugin name.
const NAME_CHAR = /[a-z0-9-]/i;

function sourceBadge(source: SkillEntry["source"]): string {
  switch (source) {
    case "project":
      return "Project";
    case "global":
      return "Global";
    case "user":
      return "User";
    case "built-in":
      return "Built-in";
    default:
      return source;
  }
}

export function buildMentionCatalog(
  skills: readonly SkillEntry[] | null | undefined,
  plugins: PluginCatalogSnapshot | null | undefined,
): MentionCatalog {
  const skillItems: MentionItem[] = (skills ?? [])
    .filter((skill) => skill.enabled)
    .map((skill) => ({
      kind: "skill" as const,
      name: skill.name,
      label: skill.name,
      description: skill.description ?? "",
      badge: skill.plugin?.displayName ?? sourceBadge(skill.source),
    }));
  const skillNames = new Set(skillItems.map((item) => item.name));

  const pluginItems: MentionItem[] = (plugins?.plugins ?? [])
    .filter((plugin) => plugin.enabled && !skillNames.has(plugin.name))
    .map((plugin) => ({
      kind: "plugin" as const,
      name: plugin.name,
      label: plugin.displayName || plugin.name,
      description: plugin.description ?? "",
      badge: "Plugin",
    }));

  const kindByName = new Map<string, MentionKind>();
  for (const item of skillItems) {
    if (!kindByName.has(item.name)) kindByName.set(item.name, "skill");
  }
  for (const item of pluginItems) {
    if (!kindByName.has(item.name)) kindByName.set(item.name, "plugin");
  }

  const names = [...kindByName.keys()].sort((a, b) => b.length - a.length);

  return { items: [...skillItems, ...pluginItems], names, kindByName };
}

function boundaryBefore(text: string, index: number): boolean {
  if (index === 0) return true;
  return /\s/.test(text[index - 1] ?? "");
}

function matchMentionAt(
  text: string,
  atIndex: number,
  catalog: MentionCatalog,
): { name: string; kind: MentionKind; end: number } | null {
  // names are longest-first, so the first match is the greedy/longest one.
  for (const name of catalog.names) {
    const candidate = text.slice(atIndex + 1, atIndex + 1 + name.length);
    if (candidate.length !== name.length || candidate.toLowerCase() !== name) continue;
    const afterIndex = atIndex + 1 + name.length;
    const after = text[afterIndex];
    if (after !== undefined && NAME_CHAR.test(after)) continue; // not a word boundary
    const kind = catalog.kindByName.get(name);
    if (!kind) continue;
    return { name, kind, end: afterIndex };
  }
  return null;
}

export function parseComposerSegments(text: string, catalog: MentionCatalog): ComposerSegment[] {
  if (!text) return [];
  const segments: ComposerSegment[] = [];
  const hasNames = catalog.names.length > 0;
  let cursor = 0;
  let textStart = 0;
  while (cursor < text.length) {
    if (hasNames && text[cursor] === "@" && boundaryBefore(text, cursor)) {
      const match = matchMentionAt(text, cursor, catalog);
      if (match) {
        if (textStart < cursor) {
          segments.push({
            type: "text",
            text: text.slice(textStart, cursor),
            start: textStart,
            end: cursor,
          });
        }
        segments.push({
          type: "mention",
          kind: match.kind,
          name: match.name,
          raw: text.slice(cursor, match.end),
          start: cursor,
          end: match.end,
        });
        cursor = match.end;
        textStart = cursor;
        continue;
      }
    }
    cursor++;
  }
  if (textStart < text.length) {
    segments.push({
      type: "text",
      text: text.slice(textStart),
      start: textStart,
      end: text.length,
    });
  }
  return segments;
}

/** Derive the deduped, first-occurrence-ordered references to send with the turn. */
export function extractReferencesFromText(text: string, catalog: MentionCatalog): TurnReference[] {
  const seen = new Set<string>();
  const out: TurnReference[] = [];
  for (const segment of parseComposerSegments(text, catalog)) {
    if (segment.type !== "mention") continue;
    const key = `${segment.kind}:${segment.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: segment.kind, name: segment.name });
    if (out.length >= MAX_TURN_REFERENCES) break;
  }
  return out;
}

/**
 * If the caret sits inside an in-progress `@query` token (an `@` at a word
 * boundary with no whitespace between it and the caret), return its start index
 * and the partial query; otherwise null.
 */
export function detectActiveMentionQuery(text: string, caret: number): ActiveMentionQuery | null {
  if (caret < 0 || caret > text.length) return null;
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@") {
      if (i === 0 || /\s/.test(text[i - 1] ?? "")) {
        return { start: i, query: text.slice(i + 1, caret) };
      }
      return null;
    }
    if (ch === undefined || /\s/.test(ch)) return null;
  }
  return null;
}

export function filterMentionItems(
  catalog: MentionCatalog,
  query: string,
  limit = 50,
): MentionItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return catalog.items.slice(0, limit);
  return catalog.items
    .filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.label.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q),
    )
    .slice(0, limit);
}
