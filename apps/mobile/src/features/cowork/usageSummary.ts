import { z } from "zod";
import type { SessionUsageSnapshot } from "../../../../../src/session/costTracker";

const usageTotalsSchema: z.ZodType<
  Pick<
    SessionUsageSnapshot,
    "totalPromptTokens" | "totalCompletionTokens" | "estimatedTotalCostUsd"
  >
> = z.object({
  totalPromptTokens: z.number().int().nonnegative(),
  totalCompletionTokens: z.number().int().nonnegative(),
  estimatedTotalCostUsd: z.number().nullable(),
});

export function summarizeLoadedUsage(snapshots: ReadonlyArray<{ sessionUsage?: unknown }>) {
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedCostUsd = 0;
  let sessionsWithUsage = 0;
  let costAvailable = true;
  for (const snapshot of snapshots) {
    const usage = usageTotalsSchema.safeParse(snapshot.sessionUsage);
    if (!usage.success) continue;
    sessionsWithUsage += 1;
    inputTokens += usage.data.totalPromptTokens;
    outputTokens += usage.data.totalCompletionTokens;
    if (usage.data.estimatedTotalCostUsd === null) {
      costAvailable = false;
    } else {
      estimatedCostUsd += usage.data.estimatedTotalCostUsd;
    }
  }
  return {
    inputTokens,
    outputTokens,
    sessionsWithUsage,
    estimatedCostUsd: costAvailable && sessionsWithUsage > 0 ? estimatedCostUsd : null,
  };
}
