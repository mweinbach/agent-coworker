import { buildPluginCatalogSnapshot } from "../../../plugins";
import { discoverSkillsForConfig } from "../../../skills";
import {
  isSkillBodyLoadAllowed,
  type LoadedSkillBody,
  loadSkillBodyByName,
} from "../../../skills/loadSkillBody";
import type { PluginCatalogSnapshot, ReferencedPluginContext, TurnReference } from "../../../types";
import type { SessionContext } from "../SessionContext";

/**
 * Server-side handling for skill/plugin references the user @-mentioned on a turn
 * (`TurnReference[]`).
 *
 * - Skill references are HARD-forced by folding the skill's SKILL.md body into the
 *   model-facing user message as plain text (see `renderReferencedSkillsInjection`).
 *   This is provider-agnostic: stateful interaction APIs (google-interactions,
 *   openai-responses, codex-app-server) reject synthetic tool-call/tool-result
 *   history they did not generate, so we must not fabricate one. The user's typed
 *   text stays the UI-visible message (`displayText`); only the model sees the
 *   appended skill instructions.
 * - Plugin references are SOFT awareness: resolved to `ReferencedPluginContext`
 *   and rendered into a turn-scoped system block (`renderReferencedPluginsSection`).
 */

export type ReferencedSkillContext = LoadedSkillBody;

function dedupeReferenceNames(references: TurnReference[], kind: TurnReference["kind"]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of references) {
    if (ref.kind !== kind) continue;
    if (seen.has(ref.name)) continue;
    seen.add(ref.name);
    out.push(ref.name);
  }
  return out;
}

/** Load the bodies of every enabled `kind:"skill"` reference. Unknown/disabled are dropped. */
export async function resolveReferencedSkills(opts: {
  context: SessionContext;
  references: TurnReference[];
  log: (line: string) => void;
}): Promise<ReferencedSkillContext[]> {
  const { context, references, log } = opts;
  const skillNames = dedupeReferenceNames(references, "skill");
  const skills: ReferencedSkillContext[] = [];
  for (const name of skillNames) {
    const loaded = await loadSkillBodyByName(context.state.config, name);
    if (!loaded) {
      log(`[skill-ref] skipping unknown, disabled, or unreadable skill "${name}"`);
      continue;
    }
    skills.push(loaded);
  }
  return skills;
}

/**
 * Render the resolved skill bodies as an instruction block to append to the
 * model-facing user (or steer) message. Returns "" when there is nothing to inject.
 */
export function renderReferencedSkillsInjection(skills: ReferencedSkillContext[]): string {
  if (skills.length === 0) return "";
  const lines: string[] = [
    "## Referenced Skills",
    "",
    "The user explicitly invoked the following skill(s) for this request. Treat the content below as authoritative instructions and follow them.",
    "",
  ];
  for (const skill of skills) {
    lines.push(`### ${skill.name}`, "", skill.body, "");
  }
  return lines.join("\n").trim();
}

/**
 * Resolve every `kind:"plugin"` reference against the plugin catalog into the
 * turn-scoped awareness context. Unknown plugin names are dropped, and names that
 * also resolve to an enabled skill are skipped (skills take precedence).
 */
export async function resolveReferencedPlugins(
  context: SessionContext,
  references: TurnReference[],
  pluginCatalog?: PluginCatalogSnapshot,
): Promise<ReferencedPluginContext[]> {
  const pluginNames = dedupeReferenceNames(references, "plugin");
  if (pluginNames.length === 0) return [];

  const catalog = pluginCatalog ?? (await buildPluginCatalogSnapshot(context.state.config));
  const enabledSkillNames = new Set(
    (await discoverSkillsForConfig(context.state.config))
      .filter((skill) => skill.enabled && isSkillBodyLoadAllowed(context.state.config, skill.name))
      .map((skill) => skill.name),
  );
  const out: ReferencedPluginContext[] = [];
  for (const name of pluginNames) {
    // Skill names take precedence over plugin names for the same token.
    if (enabledSkillNames.has(name)) continue;

    const entry = catalog.plugins.find((plugin) => plugin.name === name && plugin.enabled);
    if (!entry) continue;
    out.push({
      name: entry.name,
      displayName: entry.displayName || entry.name,
      skillNames: entry.skills
        .filter((skill) => skill.enabled && isSkillBodyLoadAllowed(context.state.config, skill.name))
        .map((skill) => skill.name),
    });
  }
  return out;
}
