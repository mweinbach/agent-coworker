export const DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR = "CommandOrControl+Shift+Space";

const MODIFIER_TOKENS = ["CommandOrControl", "Ctrl", "Alt", "Shift"] as const;
const FUNCTION_KEY_PATTERN = /^F(?:[1-9]|1[0-9]|2[0-4])$/;
const SUPPORTED_SPECIAL_KEYS = new Map<string, string>([
  ["space", "Space"],
  ["spacebar", "Space"],
  ["tab", "Tab"],
  ["enter", "Enter"],
  ["return", "Enter"],
  ["escape", "Escape"],
  ["esc", "Escape"],
  ["backspace", "Backspace"],
  ["delete", "Delete"],
  ["del", "Delete"],
  ["insert", "Insert"],
  ["ins", "Insert"],
  ["home", "Home"],
  ["end", "End"],
  ["pageup", "PageUp"],
  ["pagedown", "PageDown"],
  ["up", "Up"],
  ["arrowup", "Up"],
  ["down", "Down"],
  ["arrowdown", "Down"],
  ["left", "Left"],
  ["arrowleft", "Left"],
  ["right", "Right"],
  ["arrowright", "Right"],
  ["plus", "Plus"],
  ["+", "Plus"],
  ["minus", "Minus"],
  ["-", "Minus"],
]);
const MODIFIER_ONLY_KEYS = new Set([
  "Shift",
  "Control",
  "Ctrl",
  "Meta",
  "Command",
  "Alt",
  "Option",
]);
const LABEL_TOKEN_MAP = new Map<string, string>([
  ["CommandOrControl", "Command/Ctrl"],
  ["Ctrl", "Ctrl"],
  ["Alt", "Alt"],
  ["Shift", "Shift"],
]);

export type ShortcutEventLike = {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

export type QuickChatShortcutCapture =
  | { status: "pending" }
  | { status: "invalid"; message: string }
  | { status: "complete"; accelerator: string };

function canonicalModifierToken(token: string): typeof MODIFIER_TOKENS[number] | null {
  const normalized = token.trim().toLowerCase();
  switch (normalized) {
    case "cmdorctrl":
    case "commandorcontrol":
      return "CommandOrControl";
    case "ctrl":
    case "control":
      return "Ctrl";
    case "alt":
    case "option":
      return "Alt";
    case "shift":
      return "Shift";
    default:
      return null;
  }
}

function canonicalMainKeyToken(token: string): string | null {
  if (token === " ") {
    return "Space";
  }
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }
  if (/^[A-Za-z]$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  if (/^[0-9]$/.test(trimmed)) {
    return trimmed;
  }
  if (FUNCTION_KEY_PATTERN.test(trimmed.toUpperCase())) {
    return trimmed.toUpperCase();
  }

  const special = SUPPORTED_SPECIAL_KEYS.get(trimmed.toLowerCase());
  return special ?? null;
}

function parseAccelerator(value: string): { modifiers: string[]; key: string } | null {
  const tokens = value
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length < 2) {
    return null;
  }

  const keyToken = canonicalMainKeyToken(tokens.at(-1) ?? "");
  if (!keyToken) {
    return null;
  }

  const modifiers: string[] = [];
  for (const token of tokens.slice(0, -1)) {
    const normalized = canonicalModifierToken(token);
    if (!normalized || modifiers.includes(normalized)) {
      return null;
    }
    modifiers.push(normalized);
  }

  if (modifiers.length === 0) {
    return null;
  }

  return { modifiers, key: keyToken };
}

function acceleratorFromParts(parts: { modifiers: string[]; key: string }): string {
  return [...parts.modifiers, parts.key].join("+");
}

function canonicalKeyFromKeyboardEvent(event: ShortcutEventLike): string | null {
  if (MODIFIER_ONLY_KEYS.has(event.key)) {
    return null;
  }
  if (event.code === "Space") {
    return "Space";
  }

  if (event.code?.startsWith("Key") && event.code.length === 4) {
    return event.code.slice(3).toUpperCase();
  }
  if (event.code?.startsWith("Digit") && event.code.length === 6) {
    return event.code.slice(5);
  }

  return canonicalMainKeyToken(event.key);
}

export function normalizeQuickChatShortcutAccelerator(value?: string | null): string {
  if (typeof value !== "string") {
    return DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR;
  }
  const parsed = parseAccelerator(value);
  return parsed ? acceleratorFromParts(parsed) : DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR;
}

export function formatQuickChatShortcutLabel(accelerator: string): string {
  const parsed = parseAccelerator(normalizeQuickChatShortcutAccelerator(accelerator));
  if (!parsed) {
    return "Command/Ctrl + Shift + Space";
  }

  return [...parsed.modifiers, parsed.key]
    .map((token) => LABEL_TOKEN_MAP.get(token) ?? token)
    .join(" + ");
}

export function captureQuickChatShortcut(event: ShortcutEventLike): QuickChatShortcutCapture {
  const key = canonicalKeyFromKeyboardEvent(event);
  const modifiers: string[] = [];

  if (event.metaKey && event.ctrlKey) {
    modifiers.push("CommandOrControl", "Ctrl");
  } else if (event.metaKey || event.ctrlKey) {
    modifiers.push("CommandOrControl");
  }
  if (event.altKey) {
    modifiers.push("Alt");
  }
  if (event.shiftKey) {
    modifiers.push("Shift");
  }

  if (!key) {
    return { status: "pending" };
  }
  if (modifiers.length === 0) {
    return { status: "invalid", message: "Use at least one modifier key." };
  }

  const accelerator = acceleratorFromParts({ modifiers, key });
  const parsed = parseAccelerator(accelerator);
  if (!parsed) {
    return { status: "invalid", message: "That key combination is not supported." };
  }

  return { status: "complete", accelerator };
}
