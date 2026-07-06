export type LmStudioUnreachableErrorData = {
  baseUrl: string;
  installed: boolean;
  canAutoStart: boolean;
};

/**
 * Parse the structured `error.data` a rejected `turn/start` carries when the
 * thread's LM Studio server is unreachable (see docs/websocket-protocol.md,
 * `reason: "lmstudio_unreachable"`). Returns null for every other error.
 */
export function parseLmStudioUnreachableError(error: unknown): LmStudioUnreachableErrorData | null {
  const data = (error as { jsonRpcData?: unknown } | null)?.jsonRpcData;
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record.reason !== "lmstudio_unreachable") return null;
  if (typeof record.baseUrl !== "string" || record.baseUrl.length === 0) return null;
  return {
    baseUrl: record.baseUrl,
    installed: record.installed === true,
    canAutoStart: record.canAutoStart === true,
  };
}
