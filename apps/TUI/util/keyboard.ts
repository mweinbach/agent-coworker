function normalizeKeyCodeName(code: string): string | null {
  if (code.startsWith("key") && code.length === 4) return code[3] ?? null;
  if (code.startsWith("digit") && code.length === 6) return code[5] ?? null;
  if (code === "bracketright") return "]";
  if (code === "bracketleft") return "[";
  if (code === "slash") return "/";
  if (code === "backslash") return "\\";
  if (code === "period") return ".";
  if (code === "comma") return ",";
  return null;
}

function normalizeControlSequence(raw: string): string | null {
  if (raw === "\r" || raw === "\n" || raw === "\r\n") return "enter";
  if (raw === "\u001b") return "escape";
  if (raw === "\t") return "tab";
  if (raw === "\b" || raw === "\u007f") return "backspace";
  if (raw === "\u0003") return "c";
  return null;
}

function inferCtrlFromSequence(raw: string): boolean {
  if (raw.length !== 1) return false;
  const code = raw.charCodeAt(0);
  if (code < 1 || code > 26) return false;
  return raw !== "\n" && raw !== "\r" && raw !== "\t";
}

export function normalizeKeyName(raw: string): string {
  const bySequence = normalizeControlSequence(raw);
  if (bySequence) return bySequence;

  const key = raw.toLowerCase();
  if (key === "return" || key === "linefeed" || key === "carriagereturn" || key === "kpenter") return "enter";
  if (key === "esc") return "escape";

  const byCode = normalizeKeyCodeName(key);
  if (byCode) return byCode;

  return key;
}

export function keyNameFromEvent(event: unknown): string {
  if (typeof event === "string") {
    return normalizeKeyName(event);
  }
  if (!event || typeof event !== "object") {
    return "";
  }

  const record = event as Record<string, unknown>;
  const raw =
    typeof record.name === "string"
      ? record.name
      : typeof record.key === "string"
        ? record.key
        : typeof record.sequence === "string"
          ? record.sequence
          : typeof record.code === "string"
            ? record.code
            : "";

  return normalizeKeyName(raw);
}

export function keyModifiersFromEvent(event: unknown): {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
} {
  if (!event || typeof event !== "object") {
    if (typeof event === "string") {
      return { ctrl: inferCtrlFromSequence(event), shift: false, alt: false };
    }
    return { ctrl: false, shift: false, alt: false };
  }

  const record = event as Record<string, unknown>;
  const raw =
    typeof record.sequence === "string"
      ? record.sequence
      : typeof record.key === "string"
        ? record.key
        : typeof record.name === "string"
          ? record.name
          : "";

  const ctrl = Boolean(record.ctrl ?? record.ctrlKey) || inferCtrlFromSequence(raw);
  const shift = Boolean(record.shift ?? record.shiftKey);
  const alt = Boolean(record.alt ?? record.altKey ?? record.meta ?? record.metaKey ?? record.option);

  return { ctrl, shift, alt };
}
