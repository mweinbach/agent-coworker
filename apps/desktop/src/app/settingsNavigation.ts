import type { SettingsPageId } from "./types";

export const SETTINGS_PAGE_ALIASES: Partial<Record<SettingsPageId, SettingsPageId>> = {
  providers: "models",
  openAiNativeConnectors: "toolAccess",
  mcp: "toolAccess",
  workspaces: "defaults",
  memory: "profileMemory",
  featureFlags: "experiments",
  developer: "diagnostics",
  archivedChats: "chats",
};

export const SETTINGS_PAGE_IDS = [
  "models",
  "subagents",
  "toolAccess",
  "defaults",
  "profileMemory",
  "chats",
  "experiments",
  "diagnostics",
  "privacyTelemetry",
  "desktop",
  "usage",
  "remoteAccess",
  "backup",
  "updates",
] as const satisfies readonly SettingsPageId[];

export type CanonicalSettingsPageId = (typeof SETTINGS_PAGE_IDS)[number];

export function normalizeKnownSettingsPageId(value: unknown): CanonicalSettingsPageId {
  const normalized =
    typeof value === "string"
      ? (SETTINGS_PAGE_ALIASES[value as SettingsPageId] ?? value)
      : "models";
  return SETTINGS_PAGE_IDS.find((page) => page === normalized) ?? "models";
}
