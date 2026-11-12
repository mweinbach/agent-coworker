export type ToolFeedState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "output-available"
  | "output-error"
  | "output-denied";

export function isTerminalToolState(state: ToolFeedState): boolean {
  return state === "output-available" || state === "output-error" || state === "output-denied";
}
