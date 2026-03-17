import type { AgentRoleDefinition } from "./roles";

function isReadOnlyMcpTool(tool: unknown): boolean {
  if (typeof tool !== "object" || tool === null) return false;
  const annotations = (tool as { annotations?: unknown }).annotations;
  if (typeof annotations !== "object" || annotations === null) return false;
  return (annotations as { readOnlyHint?: unknown }).readOnlyHint === true;
}

export function filterToolsForRole(tools: Record<string, any>, role: AgentRoleDefinition): Record<string, any> {
  const allowed = new Set(role.allowTools);
  return Object.fromEntries(
    Object.entries(tools).filter(([name, tool]) => {
      if (allowed.has(name)) return true;
      if (!name.startsWith("mcp__")) return false;
      return role.readOnly ? isReadOnlyMcpTool(tool) : true;
    }),
  );
}
