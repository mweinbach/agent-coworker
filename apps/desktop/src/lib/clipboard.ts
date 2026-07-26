import { copyText } from "./desktopCommands";

/**
 * Write text to the system clipboard.
 *
 * Prefer the Electron main-process path (`clipboard.writeText` via IPC). The
 * browser Clipboard API is unreliable in Electron renderers on Windows —
 * often missing permissions or throwing NotAllowedError — which made message
 * copy appear broken.
 */
export async function writeClipboardText(text: string): Promise<void> {
  const value = typeof text === "string" ? text : String(text ?? "");
  if (!value) return;

  try {
    await copyText(value);
    return;
  } catch {
    // Fall through when the desktop bridge is unavailable (tests, web adapter).
  }

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  // Last-resort fallback for non-secure / legacy contexts.
  if (typeof document === "undefined") {
    throw new Error("clipboard unavailable");
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  const ok = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!ok) {
    throw new Error("clipboard unavailable");
  }
}
