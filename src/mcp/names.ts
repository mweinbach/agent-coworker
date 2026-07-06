export function normalizeMcpNamePart(name: string): string {
  const normalized = name.trim().replace(/[^A-Za-z0-9-]+/g, "_");
  return normalized || "_";
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeMcpNamePart(serverName)}__${normalizeMcpNamePart(toolName)}`;
}
