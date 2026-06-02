import type { AgentProfileSnapshot } from "../../shared/agentProfiles";
import type { AgentRoleDefinition } from "./roles";

export function filterToolsForRole(
  tools: Record<string, any>,
  role: AgentRoleDefinition,
  opts: { allowProfileMcp?: boolean } = {},
): Record<string, any> {
  const allowed = new Set(role.allowTools);
  return Object.fromEntries(
    Object.entries(tools).filter(([name, _tool]) => {
      if (allowed.has(name)) return true;
      if (!name.startsWith("mcp__")) return false;
      return opts.allowProfileMcp === true || !role.readOnly;
    }),
  );
}

export function filterToolsForProfile(
  tools: Record<string, any>,
  profile: AgentProfileSnapshot,
): Record<string, any> {
  const allowedBuiltIns = new Set(profile.allowedBuiltInTools);
  const allowedMcpServers = new Set(profile.allowedMcpServers.map(normalizeMcpServerName));
  return Object.fromEntries(
    Object.entries(tools).filter(([name, _tool]) => {
      const mcpServerName = extractMcpServerName(name);
      if (mcpServerName) {
        return allowedMcpServers.has(normalizeMcpServerName(mcpServerName));
      }
      return allowedBuiltIns.has(name);
    }),
  );
}

function extractMcpServerName(toolName: string): string | null {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice("mcp__".length);
  const separatorIndex = rest.indexOf("__");
  if (separatorIndex <= 0) return null;
  return rest.slice(0, separatorIndex);
}

function normalizeMcpServerName(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9_-]/g, "_");
}
