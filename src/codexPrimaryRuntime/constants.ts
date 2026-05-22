import type { SkillSourceSpec } from "./types";

export const CODEX_CURATED_PLUGINS_EXPORT_URL =
  "https://chatgpt.com/backend-api/plugins/export/curated";
export const CODEX_RUNTIME_STATE_VERSION = 1;
export const CODEX_RUNTIME_STATE_FILE = "codex-primary-runtime.json";

export const CODEX_RUNTIME_SKILLS: readonly SkillSourceSpec[] = [
  { name: "documents", pluginName: "documents", sourceSkillName: "documents" },
  { name: "presentations", pluginName: "presentations", sourceSkillName: "presentations" },
  { name: "spreadsheets", pluginName: "spreadsheets", sourceSkillName: "spreadsheets" },
] as const;

export const LEGACY_CODEX_RUNTIME_SKILLS = ["doc", "slides", "spreadsheet"] as const;
