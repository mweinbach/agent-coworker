export type DesktopIpcWindowMode = "main" | "quick-chat" | "utility";

export function resolveDesktopIpcWindowMode(event: {
  sender?: { getURL?: () => string };
}): DesktopIpcWindowMode {
  const rawUrl = typeof event.sender?.getURL === "function" ? event.sender.getURL() : "";
  if (!rawUrl) {
    return "main";
  }

  try {
    const mode = new URL(rawUrl).searchParams.get("window");
    return mode === "quick-chat" || mode === "utility" ? mode : "main";
  } catch {
    return "main";
  }
}
