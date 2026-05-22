import type { ToolFeedState } from "./types";

export function isTerminalToolState(state: ToolFeedState): boolean {
  return state === "output-available" || state === "output-error" || state === "output-denied";
}
