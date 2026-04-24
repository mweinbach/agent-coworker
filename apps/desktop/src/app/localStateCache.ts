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

export function saveDesktopStateCache(state: DesktopStateCache): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(getDesktopStateCacheKey(), JSON.stringify(state));
  } catch {
    // Best effort only; do not block the desktop UI on local storage writes.
  }
}

export function clearDesktopStateCache(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(getDesktopStateCacheKey());
  } catch {
    // Ignore local storage cleanup failures.
  }
}
