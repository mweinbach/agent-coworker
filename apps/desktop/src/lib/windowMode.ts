export type DesktopWindowMode = "main" | "quick-chat";

export function getDesktopWindowMode(): DesktopWindowMode {
  if (typeof window === "undefined") {
    return "main";
  }

  const mode = new URLSearchParams(window.location.search).get("window");
  return mode === "quick-chat" ? "quick-chat" : "main";
}
