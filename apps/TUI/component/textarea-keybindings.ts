import { normalizeKeyName } from "../util/keyboard";

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
  | "shell_mode"
  | "none";

export function getTextareaAction(
  key: string,
  ctrl: boolean,
  shift: boolean,
  alt: boolean
): TextareaAction {
  const normalized = normalizeKeyName(key);
  const isEnter = normalized === "enter";

  // Enter without shift = submit
  if (isEnter && !shift) return "submit";

  // Shift+Enter or Ctrl+J = newline
  if ((isEnter && shift) || (normalized === "j" && ctrl)) return "newline";

  // Ctrl+C = clear (do not swallow terminal copy bindings like Ctrl+Shift+C).
  if (normalized === "c" && ctrl && !shift && !alt) return "clear";

  // Up/Down arrows = history navigation
  if (normalized === "up" && !ctrl && !shift) return "history_up";
  if (normalized === "down" && !ctrl && !shift) return "history_down";

  // Escape = cancel
  if (normalized === "escape") return "cancel";

  // Ctrl+] = shell mode toggle
  if (normalized === "]" && ctrl) return "shell_mode";

  return "none";
}
