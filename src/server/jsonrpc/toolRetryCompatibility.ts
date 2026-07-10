import type { StartServerSocket } from "../startServer/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripRetryLineage(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripRetryLineage(entry));
  }
  if (!isRecord(value)) return value;

  const projectedTool = value.type === "toolCall";
  const feedTool = value.kind === "tool";
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "retryOf" && (projectedTool || feedTool)) continue;
    next[key] = stripRetryLineage(entry);
  }
  return next;
}

export function projectToolRetryCompatibility(ws: StartServerSocket, payload: unknown): unknown {
  if (ws.data.rpc?.capabilities.toolRetryLineage === true) return payload;
  return stripRetryLineage(payload);
}
