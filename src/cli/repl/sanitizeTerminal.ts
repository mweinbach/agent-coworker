/**
 * Sanitize text before writing to the terminal.
 *
 * Strips dangerous ANSI/VT escape sequences that could be injected by a
 * malicious or compromised model/server response, while preserving safe SGR
 * sequences used for colors, bold, underline, etc.
 *
 * Dangerous sequences removed:
 *   - OSC  (Operating System Command): `\x1b] … \x07` or `\x1b] … \x1b\\`
 *     Used to set terminal title, clipboard, hyperlinks, etc.
 *   - DCS  (Device Control String): `\x1bP … \x1b\\`
 *     Used for Sixel graphics, DECRQSS, tmux pass-through.
 *   - APC  (Application Program Command): `\x1b_ … \x1b\\`
 *     Used for iTerm2 inline images and custom payloads.
 *   - PM   (Privacy Message): `\x1b^ … \x1b\\`
 *     Rarely used but can carry arbitrary data.
 *   - SOS  (Start of String): `\x1bX … \x1b\\`
 *     Another arbitrary-data carrier.
 */

// Matches OSC terminated by BEL (\x07) or ST (\x1b\\).
// Using [\s\S] instead of . to match across newlines.
// biome-ignore lint/complexity/useRegexLiterals: string form avoids control-character regex diagnostics.
const OSC_RE = new RegExp("\\x1b\\][\\s\\S]*?(?:\\x07|\\x1b\\\\)", "g");

// Matches DCS, APC, PM, and SOS — all terminated by ST (\x1b\\).
// biome-ignore lint/complexity/useRegexLiterals: string form avoids control-character regex diagnostics.
const DCS_APC_PM_SOS_RE = new RegExp("\\x1b[P_^X][\\s\\S]*?\\x1b\\\\", "g");

/**
 * Sanitize server-supplied text before writing it to the terminal.
 *
 * Safe SGR sequences (`\x1b[…m`) are preserved so normal color/bold output
 * continues to work. All other escape sequences that could alter terminal
 * state (title, clipboard, sixel, etc.) are stripped.
 */
export function sanitizeTerminalOutput(text: string): string {
  // Fast path: no escape characters at all → nothing to sanitize.
  if (!text.includes("\x1b") && !text.includes("\x07")) return text;

  let sanitized = text;
  sanitized = sanitized.replace(OSC_RE, "");
  sanitized = sanitized.replace(DCS_APC_PM_SOS_RE, "");

  return sanitized;
}
