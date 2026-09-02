import { createHashHistory, createMemoryHistory, type RouterHistory } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
import { getDesktopWindowMode } from "../lib/windowMode";
import { normalizeKnownSettingsPageId } from "./settingsNavigation";
import { invalidateNavigationIntent } from "./store.helpers/operationIntent";
import type { SettingsPageId, ViewId } from "./types";

export type NavigationSnapshot = {
  view: ViewId;
  settingsPage: SettingsPageId;
  lastNonSettingsView: "chat" | "task";
};

function readSnapshot(history: RouterHistory): NavigationSnapshot {
  const { pathname, state } = history.location;
  const metadata = (state as { coworkNavigation?: Partial<NavigationSnapshot> }).coworkNavigation;
  const view =
    pathname === "/settings" || pathname.startsWith("/settings/")
      ? "settings"
      : pathname === "/task"
        ? "task"
        : "chat";
  return {
    view,
    settingsPage: normalizeKnownSettingsPageId(
      view === "settings" ? pathname.split("/")[2] : metadata?.settingsPage,
    ),
    lastNonSettingsView: metadata?.lastNonSettingsView === "task" ? "task" : "chat",
  };
}

function snapshotPath(snapshot: NavigationSnapshot): string {
  return snapshot.view === "settings" ? `/settings/${snapshot.settingsPage}` : `/${snapshot.view}`;
}

export function createNavigation(history: RouterHistory, explicitLocation = false) {
  let snapshot = readSnapshot(history);
  let initialized = false;
  let applyingCommand = false;
  const listeners = new Set<() => void>();
  const publish = () => {
    snapshot = readSnapshot(history);
    for (const listener of listeners) listener();
  };
  history.subscribe(() => {
    if (!applyingCommand) invalidateNavigationIntent();
    publish();
  });

  const update = (change: Partial<NavigationSnapshot>, replace = false) => {
    const next: NavigationSnapshot = {
      view: change.view ?? snapshot.view,
      settingsPage: normalizeKnownSettingsPageId(change.settingsPage ?? snapshot.settingsPage),
      lastNonSettingsView:
        change.lastNonSettingsView ??
        (change.view === "settings" && snapshot.view !== "settings"
          ? snapshot.view
          : snapshot.lastNonSettingsView),
    };
    const pathname = snapshotPath(next);
    if (
      history.location.pathname === pathname &&
      snapshot.settingsPage === next.settingsPage &&
      snapshot.lastNonSettingsView === next.lastNonSettingsView
    ) {
      return;
    }
    applyingCommand = true;
    try {
      const state = { ...history.location.state, coworkNavigation: next };
      if (replace || pathname === history.location.pathname) history.replace(pathname, state);
      else history.push(pathname, state);
    } finally {
      applyingCommand = false;
    }
  };

  return {
    history,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update,
    initialize: (saved: Partial<NavigationSnapshot> | null | undefined) => {
      if (initialized) return;
      initialized = true;
      update(explicitLocation ? snapshot : (saved ?? snapshot), true);
    },
  };
}

const browserHistoryAvailable =
  typeof window !== "undefined" && typeof window.history?.pushState === "function";
const useHashHistory = browserHistoryAvailable && getDesktopWindowMode() === "main";

export const appNavigation = createNavigation(
  useHashHistory ? createHashHistory() : createMemoryHistory({ initialEntries: ["/chat"] }),
  useHashHistory && window.location.hash.length > 1,
);

import.meta.hot?.dispose(() => appNavigation.history.destroy());

export function useNavigationSnapshot(): NavigationSnapshot {
  return useSyncExternalStore(
    appNavigation.subscribe,
    appNavigation.getSnapshot,
    appNavigation.getSnapshot,
  );
}
