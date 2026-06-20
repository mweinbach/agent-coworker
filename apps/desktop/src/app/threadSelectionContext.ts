import type { ViewId } from "./types";

export type ThreadSelectionContext = "chat" | "task";

export function getThreadSelectionContext(
  view: ViewId | null | undefined,
  lastNonSettingsView?: ViewId | null,
): ThreadSelectionContext {
  if (view === "task") return "task";
  if (view === "settings" && lastNonSettingsView === "task") return "task";
  return "chat";
}
