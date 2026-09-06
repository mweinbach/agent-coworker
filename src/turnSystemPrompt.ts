import { renderHarnessContextSection } from "./sessionContext/renderHarnessContextSection";
import { renderReferencedPluginsSection } from "./sessionContext/renderReferencedPluginsSection";
import { renderTaskContextSection } from "./sessionContext/renderTaskContextSection";
import type { TaskContextSnapshot } from "./shared/tasks";
import type { AgentConfig, HarnessContextState, ReferencedPluginContext } from "./types";
import { renderActiveWorkspaceContextSection } from "./workspace/context";

export function buildTurnSystemPrompt(
  system: string,
  config: AgentConfig | null | undefined,
  mcpToolsEnabled: boolean,
  harnessContext?: HarnessContextState | null,
  referencedPlugins?: ReferencedPluginContext[] | null,
  taskContext?: TaskContextSnapshot | null,
): string {
  const sections = [system];

  const workspaceSection = renderActiveWorkspaceContextSection(config);
  if (workspaceSection) {
    sections.push(workspaceSection);
  }

  if (mcpToolsEnabled) {
    sections.push(
      [
        "## Active MCP Tools",
        "MCP tools are deferred. Use `toolSearch` to discover tools by capability, server, or exact name and load their input schemas.",
        `Call a discovered tool with \`${config?.toolCalling?.deferredToolSearch ? "toolCall" : "mcpCall"}\`, passing its exact \`mcp__{serverName}__{toolName}\` name and schema-shaped arguments.`,
        "The catalog is live: servers connected or changed during this conversation are available on the next search or call. Search again if a tool is unavailable or its schema has changed.",
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
