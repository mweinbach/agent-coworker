import { stringifyDynamic } from "../../../../../../src/shared/a2ui/expressions";
import { resolveDynamicWithFunctions } from "../../../../../../src/shared/a2ui/functions";
import type { A2uiRenderableComponent } from "./A2uiRenderer";

/**
 * Walks a surface tree breadth-first to find the best heading to use as the
 * surface title. Prefers the highest-level `Heading` (smallest `level`), then
 * falls back to the first `Text`/`Paragraph` if no headings exist.
 */
export function extractSurfaceTitle(
  root: A2uiRenderableComponent | null,
  dataModel: unknown,
): string | null {
  if (!root) return null;
  const queue: A2uiRenderableComponent[] = [root];
  let bestHeading: { text: string; level: number } | null = null;
  let fallbackText: string | null = null;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (
      (current.type === "Heading" || current.type === "Text" || current.type === "Paragraph")
      && current.props
      && typeof current.props === "object"
    ) {
      const props = current.props as Record<string, unknown>;
      const text = stringifyDynamic(
        resolveDynamicWithFunctions(props.text ?? props.label ?? props.value, dataModel),
      ).trim();
      if (text) {
        if (current.type === "Heading") {
          const rawLevel = Number(props.level);
          const level = Number.isFinite(rawLevel) ? Math.min(Math.max(rawLevel, 1), 6) : 2;
          if (!bestHeading || level < bestHeading.level) {
            bestHeading = { text, level };
            if (level === 1) return text;
          }
        } else if (!fallbackText) {
          fallbackText = text;
        }
      }
    }
    if (Array.isArray(current.children)) {
      for (const child of current.children) {
        if (child && typeof child === "object" && !Array.isArray(child)) {
          queue.push(child as A2uiRenderableComponent);
        }
      }
    }
  }
  return bestHeading?.text ?? fallbackText;
}
