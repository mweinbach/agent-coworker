export type DesktopWindowMode = "main" | "quick-chat" | "utility";

function readWindowSearchParams(): URLSearchParams | null {
  if (typeof window === "undefined") {
    return null;
  }
  return new URLSearchParams(window.location.search);
}

export function getDesktopWindowMode(): DesktopWindowMode {
  const params = readWindowSearchParams();
  if (!params) {
    return "main";
  }

  const mode = params.get("window");
  if (mode === "quick-chat" || mode === "utility") {
    return mode;
  }
  return "main";
}

export function getDesktopWindowThreadId(): string | null {
  const params = readWindowSearchParams();
  const threadId = params?.get("threadId")?.trim();
  return threadId ? threadId : null;
}
