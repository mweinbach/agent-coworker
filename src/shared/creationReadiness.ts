import { z } from "zod";

import { PROVIDER_NAMES } from "../types";

export const COWORK_RUNTIME_STARTING_MESSAGE =
  "Cowork is still starting. Wait a moment, then retry.";

export const creationKindSchema = z.enum(["chat", "research"]);

export const creationRepairActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("connectProvider"),
      provider: z.enum(PROVIDER_NAMES),
    })
    .strict(),
  z
    .object({
      type: z.literal("openProviderSettings"),
      provider: z.enum(PROVIDER_NAMES),
    })
    .strict(),
  z
    .object({
      type: z.literal("startLmStudio"),
      baseUrl: z.string().url(),
      canAutoStart: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("installCodexRuntime"),
    })
    .strict(),
]);

export const creationReadinessCheckSchema = z
  .object({
    id: z.enum([
      "project_access",
      "provider_connected",
      "model_available",
      "credentials",
      "runtime_ready",
      "research_credentials",
    ]),
    status: z.enum(["ok", "blocked"]),
    message: z.string().trim().min(1),
    repairAction: creationRepairActionSchema.optional(),
  })
  .strict();

export const creationPreflightParamsSchema = z
  .object({
    kind: creationKindSchema,
    cwd: z.string().trim().min(1).optional(),
    provider: z.enum(PROVIDER_NAMES).optional(),
    model: z.string().trim().min(1).optional(),
  })
  .strict();

export const creationPreflightResultSchema = z
  .object({
    ready: z.boolean(),
    checks: z.array(creationReadinessCheckSchema),
  })
  .strict();

export type CreationKind = z.infer<typeof creationKindSchema>;
export type CreationRepairAction = z.infer<typeof creationRepairActionSchema>;
export type CreationReadinessCheck = z.infer<typeof creationReadinessCheckSchema>;
export type CreationPreflightParams = z.infer<typeof creationPreflightParamsSchema>;
export type CreationPreflightResult = z.infer<typeof creationPreflightResultSchema>;
