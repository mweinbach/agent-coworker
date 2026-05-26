import type { AgentRoleDefinition } from "./roles";

export function filterToolsForRole(
  tools: Record<string, any>,
  role: AgentRoleDefinition,
): Record<string, any> {
  const allowed = new Set(role.allowTools);
  return Object.fromEntries(
    Object.entries(tools).filter(([name, _tool]) => {
      if (allowed.has(name)) return true;
      if (!name.startsWith("mcp__")) return false;
      return !role.readOnly;
    }),
  );
}
