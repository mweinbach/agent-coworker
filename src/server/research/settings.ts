import type { Interactions } from "@google/genai";

import type { ResearchSettings } from "./types";

export function buildInteractionToolsFromSettings(
  _settings: ResearchSettings,
  fileSearchStoreName?: string | null,
): Interactions.Tool[] {
  const tools: Interactions.Tool[] = [];
  if (fileSearchStoreName) {
    tools.push({
      type: "file_search",
      file_search_store_names: [fileSearchStoreName],
    });
  }
  return tools;
}

