import { z } from "zod";

export const nonEmptyTrimmedStringSchema = z.string().trim().min(1);
export const optionalNonEmptyTrimmedStringSchema = nonEmptyTrimmedStringSchema.optional();
export const targetScopeSchema = z.enum(["project", "global"]);
export const workspaceMemoryScopeSchema = z.enum(["workspace", "user"]);
export const anyObjectSchema = z.record(z.string(), z.unknown());

export const legacyEventEnvelope = <T extends z.ZodTypeAny>(eventSchema: T) =>
  z.object({ event: eventSchema }).strict();

export const legacyEventsEnvelope = <T extends z.ZodTypeAny>(eventSchema: T) =>
  z.object({ events: z.array(eventSchema).min(1) }).strict();
