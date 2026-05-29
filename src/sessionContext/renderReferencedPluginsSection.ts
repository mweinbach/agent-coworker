import type { ReferencedPluginContext } from "../types";

/**
 * Render the turn-scoped "## Referenced Plugins" system block for plugins the
 * user @-mentioned. This is *soft awareness*: it biases the model toward the
 * plugin's bundled skills without force-loading any of them (individual skills
 * are hard-forced separately via synthetic skill injection).
 *
 * Returns "" when there is nothing to render. Uses the actual callable tool id
 * (`skill`) so the model routes to a real tool.
 */
export function renderReferencedPluginsSection(
  plugins: ReferencedPluginContext[] | null | undefined,
): string {
  if (!plugins || plugins.length === 0) return "";

  const normalized = plugins
    .map((plugin) => ({
      displayName: plugin.displayName?.trim() || plugin.name.trim(),
      skillNames: plugin.skillNames.map((name) => name.trim()).filter(Boolean),
    }))
    .filter((plugin) => plugin.displayName.length > 0);
  if (normalized.length === 0) return "";

  const lines: string[] = [
    "## Referenced Plugins",
    "",
    "The user explicitly referenced the following plugin(s) for this request.",
    "Prefer their bundled skills when relevant. Load a specific skill with the `skill` tool only when you actually need its instructions.",
    "",
  ];

  for (const plugin of normalized) {
    const skillList =
      plugin.skillNames.length > 0 ? ` (bundled skills: ${plugin.skillNames.join(", ")})` : "";
    lines.push(`- ${plugin.displayName}${skillList}`);
  }

  return lines.join("\n");
}
