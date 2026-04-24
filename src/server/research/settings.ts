import type { Interactions } from "@google/genai";

export function buildInteractionTools(fileSearchStoreName?: string | null): Interactions.Tool[] {
  const tools: Interactions.Tool[] = [];
  if (fileSearchStoreName) {
    tools.push({
      type: "file_search",
      file_search_store_names: [fileSearchStoreName],
    });
  }
  return tools;
}
