import path from "node:path";

import type { AgentConfig, HarnessContextState } from "./types";
import {
  deriveActiveWorkspaceContext,
  renderActiveWorkspaceContextSection,
} from "./workspace/context";
import { renderHarnessContextSection } from "./sessionContext/renderHarnessContextSection";

const MCP_NAMESPACING_TOKEN = "`mcp__{serverName}__{toolName}`";

export function stripStaticMcpNamespacingGuidance(system: string): string {
  return system
    .split("\n")
    .filter((line) => !line.includes(MCP_NAMESPACING_TOKEN))
    .join("\n");
}

function withTrailingSeparator(dir: string): string {
  return dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
}

function rewriteLegacyProjectPathGuidance(
  system: string,
  config: AgentConfig | null | undefined,
): string {
  if (!config) return system;

  const context = deriveActiveWorkspaceContext(config);
  if (context.workingDirectoryRelation === "same as workspace root") {
    return system;
  }

  return system
    .replaceAll(
      "(`.agent/` in the current working directory)",
      `(\`${withTrailingSeparator(context.projectCoworkDir)}\`)`,
    )
    .replaceAll(
      "(`.cowork/` in the current working directory)",
      `(\`${withTrailingSeparator(context.projectCoworkDir)}\`)`,
    )
    .replaceAll(
      "`.agent/skills/`",
      `\`${withTrailingSeparator(path.join(context.projectCoworkDir, "skills"))}\``,
    )
    .replaceAll(
      "`.cowork/skills/`",
      `\`${withTrailingSeparator(path.join(context.projectCoworkDir, "skills"))}\``,
    )
    .replaceAll("`.agent/AGENT.md`", `\`${path.join(context.projectCoworkDir, "AGENT.md")}\``)
    .replaceAll("`.cowork/AGENT.md`", `\`${path.join(context.projectCoworkDir, "AGENT.md")}\``)
    .replaceAll(
      "`.agent/memory/`",
      `\`${withTrailingSeparator(path.join(context.projectCoworkDir, "memory"))}\``,
    )
    .replaceAll(
      "`.cowork/memory/`",
      `\`${withTrailingSeparator(path.join(context.projectCoworkDir, "memory"))}\``,
    )
    .replaceAll(
      "`.agent/mcp-servers.json`",
      `\`${path.join(context.projectCoworkDir, "mcp-servers.json")}\``,
    )
    .replaceAll(
      "`.cowork/mcp-servers.json`",
      `\`${path.join(context.projectCoworkDir, "mcp-servers.json")}\``,
    )
    .replaceAll("`.agent/config.json`", `\`${path.join(context.projectCoworkDir, "config.json")}\``)
    .replaceAll("`.cowork/config.json`", `\`${path.join(context.projectCoworkDir, "config.json")}\``)
    .replaceAll(
      "`.agent/skills/{name}/SKILL.md`",
      `\`${path.join(context.projectCoworkDir, "skills", "{name}", "SKILL.md")}\``,
    )
    .replaceAll(
      "`.cowork/skills/{name}/SKILL.md`",
      `\`${path.join(context.projectCoworkDir, "skills", "{name}", "SKILL.md")}\``,
    );
}

export function buildTurnSystemPrompt(
  system: string,
  config: AgentConfig | null | undefined,
  mcpToolNames: string[],
  harnessContext?: HarnessContextState | null,
): string {
  const sections = [
    rewriteLegacyProjectPathGuidance(stripStaticMcpNamespacingGuidance(system), config),
  ];

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

  return sections.join("\n\n");
}
