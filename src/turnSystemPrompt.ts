import { renderHarnessContextSection } from "./sessionContext/renderHarnessContextSection";
import { renderReferencedPluginsSection } from "./sessionContext/renderReferencedPluginsSection";
import { renderTaskContextSection } from "./sessionContext/renderTaskContextSection";
import type { TaskContextSnapshot } from "./shared/tasks";
import type { AgentConfig, HarnessContextState, ReferencedPluginContext } from "./types";
import { renderActiveWorkspaceContextSection } from "./workspace/context";

const MCP_NAMESPACING_TOKEN = "`mcp__{serverName}__{toolName}`";

function stripStaticMcpNamespacingGuidance(system: string): string {
  return system
    .split("\n")
    .filter((line) => !line.includes(MCP_NAMESPACING_TOKEN))
    .join("\n");
}

export function buildTurnSystemPrompt(
  system: string,
  config: AgentConfig | null | undefined,
  mcpToolNames: string[],
  harnessContext?: HarnessContextState | null,
  referencedPlugins?: ReferencedPluginContext[] | null,
  taskContext?: TaskContextSnapshot | null,
): string {
  const sections = [stripStaticMcpNamespacingGuidance(system)];

  const workspaceSection = renderActiveWorkspaceContextSection(config);
  if (workspaceSection) {
    sections.push(workspaceSection);
  }

  if (mcpToolNames.length > 0) {
    sections.push(
      [
        "## Active MCP Tools",
        "MCP tools are active in this turn. Their names follow `mcp__{serverName}__{toolName}`.",
        "Only call MCP tools that are present in the current tool list.",
      ].join("\n"),
    );
  }

  const harnessSection = renderHarnessContextSection(harnessContext);
  if (harnessSection) {
    sections.push(harnessSection);
  }

  const referencedPluginsSection = renderReferencedPluginsSection(referencedPlugins);
  if (referencedPluginsSection) {
    sections.push(referencedPluginsSection);
  }

  const taskSection = renderTaskContextSection(taskContext);
  if (taskSection) {
    sections.push(taskSection);
  }

  return sections.join("\n\n");
}
