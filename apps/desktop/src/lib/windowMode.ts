export type DesktopWindowMode = "main" | "quick-chat" | "utility" | "canvas";

function readWindowSearchParams(): URLSearchParams | null {
  if (typeof window === "undefined") {
    return null;
  }
  let search: unknown;
  try {
    search = window.location?.search;
  } catch {
    return null;
  }
  if (typeof search !== "string") {
    return null;
  }
  return new URLSearchParams(search);
}

export function getDesktopWindowMode(): DesktopWindowMode {
  const params = readWindowSearchParams();
  if (!params) {
    return "main";
  }

  const mode = params.get("window");
  if (mode === "quick-chat" || mode === "utility" || mode === "canvas") {
    return mode;
  }
  return "main";
}

export function getDesktopWindowThreadId(): string | null {
  const params = readWindowSearchParams();
  const threadId = params?.get("threadId")?.trim();
  return threadId ? threadId : null;
}

export function shouldStartNewQuickChatThread(): boolean {
  const params = readWindowSearchParams();
  return params?.get("newThread") === "true";
}
