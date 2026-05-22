import type { SessionCostTracker, TurnUsage } from "../../../session/costTracker";
import type { ProviderName } from "../../../types";
import type { SessionEvent } from "../../protocol";

export function mergeTurnUsage(
  total: TurnUsage | undefined,
  next: TurnUsage | undefined,
): TurnUsage | undefined {
  if (!total) return next;
  if (!next) return total;

  return {
    promptTokens: total.promptTokens + next.promptTokens,
    completionTokens: total.completionTokens + next.completionTokens,
    totalTokens: total.totalTokens + next.totalTokens,
    ...(typeof total.cachedPromptTokens === "number" || typeof next.cachedPromptTokens === "number"
      ? { cachedPromptTokens: (total.cachedPromptTokens ?? 0) + (next.cachedPromptTokens ?? 0) }
      : {}),
    ...(typeof total.cacheWritePromptTokens === "number" ||
    typeof next.cacheWritePromptTokens === "number"
      ? {
          cacheWritePromptTokens:
            (total.cacheWritePromptTokens ?? 0) + (next.cacheWritePromptTokens ?? 0),
        }
      : {}),
    ...(typeof total.reasoningOutputTokens === "number" ||
    typeof next.reasoningOutputTokens === "number"
      ? {
          reasoningOutputTokens:
            (total.reasoningOutputTokens ?? 0) + (next.reasoningOutputTokens ?? 0),
        }
      : {}),
    ...(typeof total.estimatedCostUsd === "number" || typeof next.estimatedCostUsd === "number"
      ? { estimatedCostUsd: (total.estimatedCostUsd ?? 0) + (next.estimatedCostUsd ?? 0) }
      : {}),
  };
}

type TurnUsageAggregatorOptions = {
  turnId: string;
  sessionId: string;
  provider: ProviderName;
  model: string;
  costTracker?: SessionCostTracker;
  emit: (event: SessionEvent) => void;
};

export type TurnUsageAggregator = {
  mergeUsageFromError: (source: unknown) => void;
  mergeTurnUsage: (usage: TurnUsage | undefined) => void;
  persistAggregatedUsage: () => void;
};

export function createTurnUsageAggregator(
  options: TurnUsageAggregatorOptions,
): TurnUsageAggregator {
  let aggregatedUsage: TurnUsage | undefined;
  let persistedAggregatedUsage = false;
  const usageAccountedErrors = new WeakSet<object>();

  const mergeUsageFromError = (source: unknown) => {
    if (!source || typeof source !== "object") return;
    const usage = (source as { usage?: TurnUsage }).usage;
    if (!usage) return;
    if (usageAccountedErrors.has(source)) return;
    usageAccountedErrors.add(source);
    aggregatedUsage = mergeTurnUsage(aggregatedUsage, usage);
  };

  const persistAggregatedUsage = () => {
    if (persistedAggregatedUsage || !aggregatedUsage) {
      return;
    }

    persistedAggregatedUsage = true;
    let recordedUsage = aggregatedUsage;
    const tracker = options.costTracker;
    if (tracker) {
      const entry = tracker.recordTurn({
        turnId: options.turnId,
        provider: options.provider,
        model: options.model,
        usage: aggregatedUsage,
      });
      recordedUsage =
        entry.estimatedCostUsd !== null
          ? { ...aggregatedUsage, estimatedCostUsd: entry.estimatedCostUsd }
          : aggregatedUsage;
    }
    options.emit({
      type: "turn_usage",
      sessionId: options.sessionId,
      turnId: options.turnId,
      usage: recordedUsage,
    });

    if (tracker) {
      options.emit({
        type: "session_usage",
        sessionId: options.sessionId,
        usage: tracker.getCompactSnapshot(),
      });
    }
  };

  return {
    mergeUsageFromError,
    mergeTurnUsage: (usage) => {
      aggregatedUsage = mergeTurnUsage(aggregatedUsage, usage);
    },
    persistAggregatedUsage,
  };
}
