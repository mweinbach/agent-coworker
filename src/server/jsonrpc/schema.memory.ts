import { z } from "zod";

import {
  legacyEventEnvelope,
  nonEmptyTrimmedStringSchema,
  workspaceMemoryScopeSchema,
} from "./schema.shared";

export const memoryListEventSchema = z.object({
  type: z.literal("memory_list"),
  memories: z.array(z.unknown()),
}).passthrough();

export const jsonRpcMemoryRequestSchemas = {
  "cowork/memory/list": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    scope: workspaceMemoryScopeSchema.optional(),
  }).strict(),
  "cowork/memory/upsert": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    scope: workspaceMemoryScopeSchema,
    id: z.string().optional(),
    content: z.string(),
  }).strict(),
  "cowork/memory/delete": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    scope: workspaceMemoryScopeSchema,
    id: nonEmptyTrimmedStringSchema,
  }).strict(),
} as const;

export const jsonRpcMemoryResultSchemas = {
  "cowork/memory/list": legacyEventEnvelope(memoryListEventSchema),
  "cowork/memory/upsert": legacyEventEnvelope(memoryListEventSchema),
  "cowork/memory/delete": legacyEventEnvelope(memoryListEventSchema),
} as const;
