import type { SessionFeedItem } from "./sessionSnapshot";

export const MAX_TOOL_RETRY_TARGETS = 16;
const MAX_TOOL_ARGS_FINGERPRINT_LENGTH = 32_768;

export type ToolRetryRequest = {
  toolItemIds: string[];
};

export type ToolRetryTarget = {
  itemId: string;
  toolName: string;
  argsFingerprint: string;
};

export type ToolRetryIntent = {
  targets: ToolRetryTarget[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFailedToolItem(item: Extract<SessionFeedItem, { kind: "tool" }>): boolean {
  if (item.state === "output-error" || item.state === "output-denied") return true;
  if (!isRecord(item.result)) return false;
  return item.result.denied === true || item.result.ok === false || "error" in item.result;
}

export function isSuccessfulToolItem(item: Extract<SessionFeedItem, { kind: "tool" }>): boolean {
  return item.state === "output-available" && !isFailedToolItem(item);
}

function canonicalJsonValue(value: unknown, seen: WeakSet<object>): string | null {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (Array.isArray(value)) {
    if (seen.has(value)) return null;
    seen.add(value);
    const entries = value.map((entry) => canonicalJsonValue(entry, seen));
    seen.delete(value);
    return entries.some((entry) => entry === null) ? null : `[${entries.join(",")}]`;
  }
  if (!isRecord(value)) return null;
  if (seen.has(value)) return null;
  seen.add(value);
  const entries: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const encoded = canonicalJsonValue(value[key], seen);
    if (encoded === null) {
      seen.delete(value);
      return null;
    }
    entries.push(`${JSON.stringify(key)}:${encoded}`);
  }
  seen.delete(value);
  return `{${entries.join(",")}}`;
}

export function fingerprintToolArgs(args: unknown): string | null {
  if (args === undefined) return null;
  const fingerprint = canonicalJsonValue(args, new WeakSet<object>());
  if (fingerprint === null || fingerprint.length > MAX_TOOL_ARGS_FINGERPRINT_LENGTH) return null;
  return fingerprint;
}

export function resolveToolRetryIntent(
  feed: SessionFeedItem[],
  request: ToolRetryRequest,
): ToolRetryIntent {
  if (request.toolItemIds.length === 0 || request.toolItemIds.length > MAX_TOOL_RETRY_TARGETS) {
    throw new Error(`Retry must target between 1 and ${MAX_TOOL_RETRY_TARGETS} failed tools.`);
  }
  const uniqueIds = new Set(request.toolItemIds);
  if (uniqueIds.size !== request.toolItemIds.length) {
    throw new Error("Retry targets must be unique.");
  }

  const successfulRetryTargets = new Set(
    feed
      .filter(
        (item): item is Extract<SessionFeedItem, { kind: "tool" }> =>
          item.kind === "tool" && isSuccessfulToolItem(item) && typeof item.retryOf === "string",
      )
      .map((item) => item.retryOf as string),
  );

  const targets = request.toolItemIds.map((itemId): ToolRetryTarget => {
    const item = feed.find(
      (candidate): candidate is Extract<SessionFeedItem, { kind: "tool" }> =>
        candidate.kind === "tool" && candidate.id === itemId,
    );
    if (!item || !isFailedToolItem(item)) {
      throw new Error(`Retry target is not an unresolved failed tool: ${itemId}`);
    }
    if (successfulRetryTargets.has(itemId)) {
      throw new Error(`Retry target is already recovered: ${itemId}`);
    }
    const argsFingerprint = fingerprintToolArgs(item.args);
    if (argsFingerprint === null) {
      throw new Error(`Retry target does not have safely matchable arguments: ${itemId}`);
    }
    return {
      itemId,
      toolName: item.name,
      argsFingerprint,
    };
  });

  return { targets };
}

export function createToolRetryMatcher(intent?: ToolRetryIntent): {
  confirm(toolName: string, args: unknown): string | undefined;
} {
  const remaining = [...(intent?.targets ?? [])];
  return {
    confirm(toolName, args) {
      const argsFingerprint = fingerprintToolArgs(args);
      if (argsFingerprint === null) return undefined;
      const matchIndex = remaining.findIndex(
        (target) => target.toolName === toolName && target.argsFingerprint === argsFingerprint,
      );
      if (matchIndex < 0) return undefined;
      const [matched] = remaining.splice(matchIndex, 1);
      return matched?.itemId;
    },
  };
}
