import type { AgentConfig } from "../types";
import { createCodeModeTool } from "./codeMode";
import { createDeferredToolTools, createToolCatalog } from "./toolCatalog";
import type { RuntimeToolMap } from "./types";

type ToolExposureOptions = Parameters<typeof createToolCatalog>[0] & {
  tools: RuntimeToolMap;
  config?: AgentConfig["toolCalling"];
};

/** Compose opt-in envelopes only after provider, role, and profile filtering. */
export function createToolExposure(options: ToolExposureOptions): {
  tools: RuntimeToolMap;
  instructions: string;
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
    "Optional tool discovery is enabled. Use toolSearch to find currently permitted tools and their input schemas. Search results do not register new callable tool names.",
  ];
  if (deferred) {
    instructions.push(
      "Call discovered tools with toolCall({name, arguments}). Direct tool schemas are deferred; tools not returned by search are not granted by this mode.",
    );
  }
  if (codeMode) {
    tools.codeMode = createCodeModeTool({ catalog, abortSignal: options.abortSignal });
    instructions.push(
      "codeMode executes a bounded async JavaScript body. Use await tools.search(query), await tools.call(name, arguments), and return JSON data. It has no filesystem, shell, network, or import access of its own. Every nested call retains the original tool's validation, permissions, and approvals. Return the source/citation fields you need; do not assume discarded fields remain available.",
    );
  }
  return { tools, instructions: instructions.join("\n") };
}
