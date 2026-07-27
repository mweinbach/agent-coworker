import type { ViewId } from "./types";

export function isResearchAvailable(providerConnected: readonly string[]): boolean {
  return providerConnected.includes("google");
}

export function resolveResearchAwareView(
  view: ViewId,
  providerConnected: readonly string[],
): ViewId {
  return view === "research" && !isResearchAvailable(providerConnected) ? "chat" : view;
}
