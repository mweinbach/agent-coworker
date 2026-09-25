import { writeRendererLog } from "../lib/desktopCommands";
import { getCurrentWebWorkspaceScopeHash } from "../lib/webWorkspaceState";
import type { DesktopStateCache } from "./types";

export const DESKTOP_STATE_CACHE_KEY = "cowork.desktop.state-cache.v2";

function getDesktopStateCacheKey(): string {
  const scopeHash = getCurrentWebWorkspaceScopeHash();
  return scopeHash ? `${DESKTOP_STATE_CACHE_KEY}:${scopeHash}` : DESKTOP_STATE_CACHE_KEY;
}

export function loadDesktopStateCacheRaw(): unknown | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(getDesktopStateCacheKey());
    if (!raw) {
      return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

let loggedSaveFailure = false;

export function saveDesktopStateCache(state: DesktopStateCache): void {
  if (typeof window === "undefined") {
    return;
  }
  let serialized: string | null = null;
  try {
    serialized = JSON.stringify(state);
    window.localStorage.setItem(getDesktopStateCacheKey(), serialized);
  } catch (error) {
    // Best effort only; do not block the desktop UI on local storage writes,
    // but leave one trace so a full quota does not fail silently forever.
    if (loggedSaveFailure) return;
    loggedSaveFailure = true;
    void writeRendererLog({
      level: "warn",
      category: "local-state-cache",
      message: "desktop state cache write failed",
      meta: {
        error: error instanceof Error ? error.name : "unknown",
        bytes: serialized?.length ?? null,
      },
    }).catch(() => {
      // Renderer diagnostics are best-effort only.
    });
  }
}
