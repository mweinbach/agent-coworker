/**
 * Textarea keybinding definitions for the prompt input.
 * These map key combinations to editing actions.
 */

export type TextareaAction =
  | "submit"
  | "newline"
  | "clear"
  | "history_up"
  | "history_down"
  | "cancel"
  | "stash"
  | "unstash"
  | "shell_mode"
  | "none";

export function getTextareaAction(
  key: string,
  ctrl: boolean,
  shift: boolean,
  _alt: boolean
): TextareaAction {
  // Enter without shift = submit
  if (key === "return" && !shift) return "submit";

  // Shift+Enter or Ctrl+J = newline
  if ((key === "return" && shift) || (key === "j" && ctrl)) return "newline";

  // Ctrl+C = clear
  if (key === "c" && ctrl) return "clear";

  // Up/Down arrows = history navigation
  if (key === "up" && !ctrl && !shift) return "history_up";
  if (key === "down" && !ctrl && !shift) return "history_down";

  // Escape = cancel
  if (key === "escape") return "cancel";

  // Ctrl+Z = stash
  if (key === "z" && ctrl && !shift) return "stash";

  // Ctrl+Shift+Z = unstash
  if (key === "z" && ctrl && shift) return "unstash";

  // Ctrl+] = shell mode toggle
  if (key === "]" && ctrl) return "shell_mode";

  return "none";
}
