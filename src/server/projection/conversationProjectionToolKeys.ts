export function toolTurnNameKey(turnId: string, name: string): string {
  return `${turnId}:${name}`;
}

export function toolSyntheticApprovalKey(turnId: string, approvalId: string): string {
  return `${turnId}:approval:${approvalId}`;
}

export function toolNameFromApproval(toolCall: unknown): string {
  if (toolCall && typeof toolCall === "object" && !Array.isArray(toolCall)) {
    const record = toolCall as Record<string, unknown>;
    const name =
      typeof record.name === "string"
        ? record.name
        : typeof record.toolName === "string"
          ? record.toolName
          : typeof record.functionName === "string"
            ? record.functionName
            : null;
    if (name?.trim()) return name.trim();
  }
  return "tool";
}

export function toolArgsFromApproval(toolCall: unknown): unknown {
  if (toolCall && typeof toolCall === "object" && !Array.isArray(toolCall)) {
    const record = toolCall as Record<string, unknown>;
    if (record.arguments !== undefined) return record.arguments;
    if (record.input !== undefined) return record.input;
  }
  return toolCall;
}

export function shouldReuseLatestToolItemByName(name: string): boolean {
  return name !== "nativeWebSearch" && name !== "nativeUrlContext";
}

export function incompleteToolStreamError(error?: unknown): Record<string, unknown> {
  return {
    error: error ?? "Turn failed before the tool call completed.",
  };
}
