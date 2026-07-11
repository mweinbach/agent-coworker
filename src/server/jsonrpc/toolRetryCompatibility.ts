import type { StartServerSocket } from "../startServer/types";

const OMIT = Symbol("omit-tool-retry-compatibility-value");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolRetryAnnotation(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.type === "cowork.toolRetryTurn" || value.type === "cowork.toolRetryMetadata")
  );
}

function isToolRetryTurnAnnotation(value: unknown): boolean {
  return isRecord(value) && value.type === "cowork.toolRetryTurn";
}

function isHiddenRetryTurnMessage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const projectedUserMessage = value.type === "userMessage";
  const feedUserMessage = value.kind === "message" && value.role === "user";
  return (
    (projectedUserMessage || feedUserMessage) &&
    Array.isArray(value.annotations) &&
    value.annotations.some(isToolRetryTurnAnnotation)
  );
}

function stripRetryLineage(value: unknown): unknown | typeof OMIT {
  if (isHiddenRetryTurnMessage(value)) return OMIT;
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const projected = stripRetryLineage(entry);
      return projected === OMIT ? [] : [projected];
    });
  }
  if (!isRecord(value)) return value;

  const projectedTool = value.type === "toolCall";
  const feedTool = value.kind === "tool";
  const projectedUserMessage = value.type === "userMessage";
  const feedMessage = value.kind === "message";
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "retryOf" || key === "inputDigest") && (projectedTool || feedTool)) continue;
    if (key === "annotations" && (projectedUserMessage || feedMessage) && Array.isArray(entry)) {
      const annotations = entry.filter((annotation) => !isToolRetryAnnotation(annotation));
      if (annotations.length > 0)
        next[key] = annotations.map((annotation) => stripRetryLineage(annotation));
      continue;
    }
    const projected = stripRetryLineage(entry);
    if (projected === OMIT) return OMIT;
    next[key] = projected;
  }
  return next;
}

export function projectToolRetryCompatibility(
  ws: StartServerSocket,
  payload: unknown,
): unknown | null {
  if (ws.data.rpc?.capabilities.toolRetryLineage === true) return payload;
  const projected = stripRetryLineage(payload);
  return projected === OMIT ? null : projected;
}
