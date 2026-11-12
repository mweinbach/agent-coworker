import type { ProjectedToolState } from "./projectedItems";

export function isTerminalProjectedToolState(state: ProjectedToolState): boolean {
  return state === "output-available" || state === "output-error" || state === "output-denied";
}
