import type { Interactions } from "@google/genai";
import { asNonEmptyString } from "./messageToInput";
import type { GoogleNativeStepRequest } from "./types";

function convertToolsToInteractionsTools(
  tools: Array<Record<string, unknown>>,
): Interactions.Tool[] {
  return tools.map(
    (tool) =>
      ({
        type: "function",
        name: asNonEmptyString(tool.name),
        description: asNonEmptyString(tool.description),
        parameters: tool.parameters,
      }) satisfies Interactions.Function,
  );
}

function hasToolNamed(tools: Array<Record<string, unknown>>, name: string): boolean {
  return tools.some((tool) => asNonEmptyString(tool.name) === name);
}

function canUseProviderNativeWebTools(tools: Array<Record<string, unknown>>): boolean {
  return hasToolNamed(tools, "webSearch") || hasToolNamed(tools, "webFetch");
}

function buildGoogleBuiltInTools(opts: GoogleNativeStepRequest): Interactions.Tool[] {
  const allowProviderNativeWebTools = canUseProviderNativeWebTools(opts.tools);
  const nativeWebSearchEnabled =
    opts.streamOptions.nativeWebSearch === true && allowProviderNativeWebTools;

  if (nativeWebSearchEnabled) {
    return [{ type: "google_search", search_types: ["web_search"] }, { type: "url_context" }];
  }

  return [];
}

export { buildGoogleBuiltInTools, convertToolsToInteractionsTools };
