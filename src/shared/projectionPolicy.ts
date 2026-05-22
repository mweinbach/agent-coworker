import type { ProjectedToolState } from "./projectedItems";

/** Collapses all whitespace for transcript dedupe when only paragraph breaks differ. */
export function stripWhitespaceForTranscriptDedupe(text: string): string {
  return text.replace(/\s/g, "");
}

export function isTerminalProjectedToolState(state: ProjectedToolState): boolean {
  return state === "output-available" || state === "output-error" || state === "output-denied";
}
