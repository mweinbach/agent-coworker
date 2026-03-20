import type { HarnessContextState } from "../types";
import { renderHarnessContextSection } from "./renderHarnessContextSection";

const MCP_NAMESPACING_TOKEN = "`mcp__{serverName}__{toolName}`";

export function stripStaticMcpNamespacingGuidance(system: string): string {
  return system
    .split("\n")
    .filter((line) => !line.includes(MCP_NAMESPACING_TOKEN))
    .join("\n");
}

export function buildTurnSystemPrompt(
  system: string,
  mcpToolNames: string[],
  harnessContext?: HarnessContextState | null,
): string {
  const sections = [stripStaticMcpNamespacingGuidance(system)];

  if (mcpToolNames.length > 0) {
    sections.push([
      "## Active MCP Tools",
      "MCP tools are active in this turn. Their names follow `mcp__{serverName}__{toolName}`.",
      "Only call MCP tools that are present in the current tool list.",
    ].join("\n"));
  }

  const harnessSection = renderHarnessContextSection(harnessContext);
  if (harnessSection) {
    sections.push(harnessSection);
  }

  return sections.join("\n\n");
}
