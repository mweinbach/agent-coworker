import type { AgentConfig } from "../types";
import { type CodeModeToolOptions, createCodeModeTool } from "./codeMode";
import { createDeferredToolTools, createToolCatalog } from "./toolCatalog";
import type { RuntimeLiveToolCatalog, RuntimeToolMap } from "./types";

type ToolExposureOptions = Parameters<typeof createToolCatalog>[0] & {
  tools: RuntimeToolMap;
  config?: AgentConfig["toolCalling"];
  onCodeModeCallEvent?: CodeModeToolOptions["onCallEvent"];
};

/** Compose opt-in envelopes only after provider, role, and profile filtering. */
export function createToolExposure(
  options: ToolExposureOptions,
  dependencies?: Parameters<typeof createCodeModeTool>[1],
): {
  tools: RuntimeToolMap;
  instructions: string;
  deferredToolCatalog?: RuntimeLiveToolCatalog;
} {
  const codeMode = options.config?.codeMode === true;
  const deferred = options.config?.deferredToolSearch === true;
  if (!codeMode && !deferred) return { tools: options.tools, instructions: "" };

  const catalog = createToolCatalog(options);
  const discovery = createDeferredToolTools(catalog);
  const tools: RuntimeToolMap = deferred
    ? { ...discovery }
    : { ...options.tools, toolSearch: discovery.toolSearch };
  const instructions = [
    "Optional tool discovery is enabled. Use toolSearch to find currently permitted tools and their input schemas.",
  ];
  if (deferred) {
    instructions.push(
      "Call discovered tools with toolCall({name, arguments}), or directly if their schemas appear in your callable tool list after search. Direct schemas are deferred and may be unloaded when history is compacted or permissions change. Search again if unavailable.",
    );
  }
  if (codeMode) {
    tools.codeMode = createCodeModeTool(
      {
        catalog,
        abortSignal: options.abortSignal,
        onCallEvent: options.onCodeModeCallEvent,
      },
      dependencies,
    );
    instructions.push(
      "codeMode executes a bounded async JavaScript body. Use await tools.search(query), await tools.call(name, arguments), and return JSON data. It has no filesystem, shell, network, or import access of its own. Every nested call retains the original tool's validation, permissions, and approvals. Return the source/citation fields you need; do not assume discarded fields remain available. If its required process-memory backend is unavailable, use toolCall or available direct tools instead; do not retry with an unsafe executor.",
    );
  }
  return {
    tools,
    instructions: instructions.join("\n"),
    ...(deferred ? { deferredToolCatalog: catalog } : {}),
  };
}
