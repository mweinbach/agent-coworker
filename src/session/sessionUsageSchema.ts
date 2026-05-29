import { z } from "zod";

import { PROVIDER_NAMES } from "../types";
import type {
  BudgetStatus,
  ModelUsageSummary,
  SessionUsageSnapshot,
  TurnCostEntry,
  TurnUsage,
  UsageCostBreakdown,
} from "./costTracker";
import type { ModelPricing } from "./pricing";

const providerNameSchema = z.enum(PROVIDER_NAMES);
const isoTimestampSchema = z.string().datetime({ offset: true });

const modelPricingSchema: z.ZodType<ModelPricing> = z
  .object({
    inputPerMillion: z.number(),
    outputPerMillion: z.number(),
    cachedInputPerMillion: z.number().optional(),
    cacheWriteInputPerMillion: z.number().optional(),
    longContextThresholdTokens: z.number().int().nonnegative().optional(),
    longContextInputPerMillion: z.number().optional(),
    longContextOutputPerMillion: z.number().optional(),
    longContextCachedInputPerMillion: z.number().optional(),
  })
  .strict();

const usageCostBreakdownSchema: z.ZodType<UsageCostBreakdown> = z
  .object({
    inputCostUsd: z.number(),
    cachedInputCostUsd: z.number(),
    cacheWriteInputCostUsd: z.number(),
    outputCostUsd: z.number(),
    otherCostUsd: z.number(),
  })
  .strict();

export const turnUsageSchema: z.ZodType<TurnUsage> = z
  .object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    cachedPromptTokens: z.number().int().nonnegative().optional(),
    cacheWritePromptTokens: z.number().int().nonnegative().optional(),
    reasoningOutputTokens: z.number().int().nonnegative().optional(),
    estimatedCostUsd: z.number().optional(),
  })
  .strict();

const turnCostEntrySchema: z.ZodType<TurnCostEntry> = z
  .object({
    turnId: z.string().trim().min(1),
    turnIndex: z.number().int().nonnegative(),
    timestamp: isoTimestampSchema,
    provider: providerNameSchema,
    model: z.string().trim().min(1),
    usage: turnUsageSchema,
    estimatedCostUsd: z.number().nullable(),
    costBreakdown: usageCostBreakdownSchema.nullable().optional(),
    pricing: modelPricingSchema.nullable(),
  })
  .strict();

const modelUsageSummarySchema: z.ZodType<ModelUsageSummary> = z
  .object({
    provider: providerNameSchema,
    model: z.string().trim().min(1),
    turns: z.number().int().nonnegative(),
    totalPromptTokens: z.number().int().nonnegative(),
    totalCompletionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    totalCachedPromptTokens: z.number().int().nonnegative().optional(),
    totalCacheWritePromptTokens: z.number().int().nonnegative().optional(),
    totalReasoningOutputTokens: z.number().int().nonnegative().optional(),
    estimatedCostUsd: z.number().nullable(),
    costBreakdown: usageCostBreakdownSchema.optional(),
  })
  .strict();

const budgetStatusSchema: z.ZodType<BudgetStatus> = z
  .object({
    configured: z.boolean(),
    warnAtUsd: z.number().nullable(),
    stopAtUsd: z.number().nullable(),
    warningTriggered: z.boolean(),
    stopTriggered: z.boolean(),
    currentCostUsd: z.number().nullable(),
  })
  .strict();

export const sessionUsageSnapshotSchema: z.ZodType<SessionUsageSnapshot> = z
  .object({
    sessionId: z.string().trim().min(1),
    totalTurns: z.number().int().nonnegative(),
    totalPromptTokens: z.number().int().nonnegative(),
    totalCompletionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    totalCachedPromptTokens: z.number().int().nonnegative().optional(),
    totalCacheWritePromptTokens: z.number().int().nonnegative().optional(),
    totalReasoningOutputTokens: z.number().int().nonnegative().optional(),
    estimatedTotalCostUsd: z.number().nullable(),
    costBreakdown: usageCostBreakdownSchema.optional(),
    costTrackingAvailable: z.boolean(),
    byModel: z.array(modelUsageSummarySchema),
    turns: z.array(turnCostEntrySchema),
    budgetStatus: budgetStatusSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
