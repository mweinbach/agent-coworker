import type { PartialTurnError } from "../../../runtime/types";
import type { SessionCostTracker, TurnUsage } from "../../../session/costTracker";
import type { ProviderName } from "../../../types";
import type { SessionEvent } from "../../protocol";

function mergeTurnUsage(
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
    ...(typeof total.estimatedCostUsd === "number" &&
    Number.isFinite(total.estimatedCostUsd) &&
    typeof next.estimatedCostUsd === "number" &&
    Number.isFinite(next.estimatedCostUsd)
      ? { estimatedCostUsd: total.estimatedCostUsd + next.estimatedCostUsd }
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
  mergeTurnUsage: (usage: TurnUsage | undefined, requestUsages?: readonly TurnUsage[]) => void;
  persistAggregatedUsage: () => void;
};

export function createTurnUsageAggregator(
  options: TurnUsageAggregatorOptions,
): TurnUsageAggregator {
  let aggregatedUsage: TurnUsage | undefined;
  let aggregatedRequestUsages: TurnUsage[] | null = [];
  let persistedAggregatedUsage = false;
  const usageAccountedErrors = new WeakSet<object>();

  const mergeUsage = (usage: TurnUsage | undefined, requestUsages?: readonly TurnUsage[]) => {
    if (!usage) return;
    aggregatedUsage = mergeTurnUsage(aggregatedUsage, usage);
    if (aggregatedRequestUsages !== null) {
      if (requestUsages?.length) {
        aggregatedRequestUsages.push(...requestUsages);
      } else {
        aggregatedRequestUsages = null;
      }
    }
  };

  const mergeUsageFromError = (source: unknown) => {
    if (!source || typeof source !== "object") return;
    const { usage, requestUsages } = source as PartialTurnError;
    if (!usage) return;
    if (usageAccountedErrors.has(source)) return;
    usageAccountedErrors.add(source);
    mergeUsage(usage, requestUsages);
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
        requestUsages: aggregatedRequestUsages,
      });
      recordedUsage = { ...aggregatedUsage };
      if (entry.estimatedCostUsd !== null) {
        recordedUsage.estimatedCostUsd = entry.estimatedCostUsd;
      } else {
        delete recordedUsage.estimatedCostUsd;
      }
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
    mergeTurnUsage: mergeUsage,
    persistAggregatedUsage,
  };
}
