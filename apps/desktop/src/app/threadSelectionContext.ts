import type { ViewId } from "./types";

export type ThreadSelectionContext = "chat" | "task";

export type ThreadSelectionIntent =
  | { context: "chat"; selectedTaskId: null }
  | { context: "task"; selectedTaskId: string | null };

export function getThreadSelectionContext(
  view: ViewId | null | undefined,
  lastNonSettingsView?: ViewId | null,
): ThreadSelectionContext {
  if (view === "task") return "task";
  if (view === "settings" && lastNonSettingsView === "task") return "task";
  return "chat";
}

function normalizeSelectedTaskId(selectedTaskId: string | null | undefined): string | null {
  return typeof selectedTaskId === "string" && selectedTaskId.trim().length > 0
    ? selectedTaskId
    : null;
}

export function getThreadSelectionIntent(
  view: ViewId | null | undefined,
  lastNonSettingsView: ViewId | null | undefined,
  selectedTaskId: string | null | undefined,
): ThreadSelectionIntent {
  const context = getThreadSelectionContext(view, lastNonSettingsView);
  if (context === "task") {
    return { context, selectedTaskId: normalizeSelectedTaskId(selectedTaskId) };
  }
  return { context, selectedTaskId: null };
}
