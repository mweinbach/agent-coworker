import type { SessionFeedItem } from "./sessionSnapshot";
import type { ToolInputDigest } from "./toolInputDigest";

export const MAX_TOOL_RETRY_TARGETS = 16;
export const TOOL_RETRY_TURN_ANNOTATION_TYPE = "cowork.toolRetryTurn";

export type ToolRetryRequest = {
  toolItemIds: string[];
};

export type ToolRetryTarget = {
  itemId: string;
  inputDigest: ToolInputDigest;
};

export type ToolRetryIntent = {
  targets: ToolRetryTarget[];
};

export function toolRetryTurnAnnotation(intent: ToolRetryIntent): Record<string, unknown> {
  return {
    type: TOOL_RETRY_TURN_ANNOTATION_TYPE,
    version: 1,
    targetItemIds: intent.targets.map((target) => target.itemId),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFailedToolOutcome(
  toolName: string,
  state: Extract<SessionFeedItem, { kind: "tool" }>["state"],
  result: unknown,
): boolean {
  if (state === "output-error" || state === "output-denied") return true;
  if (isRecord(result)) {
    return result.denied === true || result.ok === false || "error" in result;
  }
  return (
    toolName.toLowerCase() === "skill" &&
    typeof result === "string" &&
    /\bnot found\b/i.test(result)
  );
}

export function isFailedToolItem(item: Extract<SessionFeedItem, { kind: "tool" }>): boolean {
  return isFailedToolOutcome(item.name, item.state, item.result);
}

export function isSuccessfulToolItem(item: Extract<SessionFeedItem, { kind: "tool" }>): boolean {
  return item.state === "output-available" && !isFailedToolItem(item);
}

export function recoveredToolItemIds(feed: SessionFeedItem[]): Set<string> {
  const toolById = new Map<string, Extract<SessionFeedItem, { kind: "tool" }>>();
  for (const item of feed) {
    if (item.kind === "tool") toolById.set(item.id, item);
  }
  const recovered = new Set<string>();
  for (const item of toolById.values()) {
    if (!isSuccessfulToolItem(item) || typeof item.retryOf !== "string") continue;
    const visited = new Set<string>();
    let ancestorId: string | undefined = item.retryOf;
    while (ancestorId && !visited.has(ancestorId)) {
      visited.add(ancestorId);
      const ancestor = toolById.get(ancestorId);
      if (!ancestor || !isFailedToolItem(ancestor)) break;
      recovered.add(ancestorId);
      ancestorId = ancestor.retryOf;
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of toolById.values()) {
      if (
        recovered.has(item.id) ||
        !isFailedToolItem(item) ||
        typeof item.retryOf !== "string" ||
        !recovered.has(item.retryOf)
      ) {
        continue;
      }
      recovered.add(item.id);
      changed = true;
    }
  }
  return recovered;
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

  const recoveredTargets = recoveredToolItemIds(feed);

  const targets = request.toolItemIds.map((itemId): ToolRetryTarget => {
    const item = feed.find(
      (candidate): candidate is Extract<SessionFeedItem, { kind: "tool" }> =>
        candidate.kind === "tool" && candidate.id === itemId,
    );
    if (!item || !isFailedToolItem(item)) {
      throw new Error(`Retry target is not an unresolved failed tool: ${itemId}`);
    }
    if (recoveredTargets.has(itemId)) {
      throw new Error(`Retry target is already recovered: ${itemId}`);
    }
    if (!item.inputDigest) {
      throw new Error(`Retry target does not have complete input digest metadata: ${itemId}`);
    }
    return {
      itemId,
      inputDigest: item.inputDigest,
    };
  });

  return { targets };
}
