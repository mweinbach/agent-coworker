import { z } from "zod";

import { nonEmptyTrimmedStringSchema } from "../server/jsonrpc/schema.shared";
import { agentReasoningEffortSchema, agentTargetPathsSchema } from "../shared/agents";

/** Wall-clock ceiling for a single `agent()` call. */
const WORKFLOW_DEFAULT_AGENT_TIMEOUT_MS = 600_000;
const WORKFLOW_MAX_AGENT_TIMEOUT_MS = 3_600_000;

export const workflowMetaSchema = z
  .object({
    name: nonEmptyTrimmedStringSchema.max(80),
    description: nonEmptyTrimmedStringSchema.max(500),
    phases: z.array(nonEmptyTrimmedStringSchema).min(1).max(32),
  })
  .strict();

const workflowAgentOptionsSchema = z
  .object({
    label: nonEmptyTrimmedStringSchema.max(120).optional(),
    phase: nonEmptyTrimmedStringSchema.optional(),
    schema: z.record(z.string(), z.unknown()).optional(),
    model: nonEmptyTrimmedStringSchema.optional(),
    effort: agentReasoningEffortSchema.optional(),
    isolation: z.enum(["none", "brief"]).optional(),
    briefing: z.string().trim().min(1).max(20_000).optional(),
    agentType: nonEmptyTrimmedStringSchema.optional(),
    targetPaths: agentTargetPathsSchema.optional(),
    onError: z.enum(["fail", "null"]).default("fail"),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(WORKFLOW_MAX_AGENT_TIMEOUT_MS)
      .default(WORKFLOW_DEFAULT_AGENT_TIMEOUT_MS),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.isolation === "brief" && !value.briefing) {
      ctx.addIssue({
        code: "custom",
        path: ["briefing"],
        message: 'briefing is required when isolation is "brief"',
      });
    }
  });

export const workflowAgentCallSchema = z
  .object({
    prompt: z.string().trim().min(1).max(20_000),
    opts: workflowAgentOptionsSchema,
  })
  .strict();

/**
 * Messages the sandboxed worker may send to the host. The worker is a trust
 * boundary, so every inbound message is parsed rather than cast.
 */
export const workflowHostMessageSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("meta"), callId: z.number().int().min(0), meta: z.unknown() }).strict(),
  z
    .object({
      t: z.literal("agent"),
      callId: z.number().int().min(0),
      // A JSON string carrying `{ prompt, opts }`. Parsed and validated with
      // `workflowAgentCallSchema` once it reaches the host.
      payload: z.string(),
    })
    .strict(),
  z.object({ t: z.literal("phase"), title: z.string() }).strict(),
  z.object({ t: z.literal("log"), message: z.string() }).strict(),
  z.object({ t: z.literal("done"), result: z.unknown() }).strict(),
  z.object({ t: z.literal("error"), message: z.string(), stack: z.string().optional() }).strict(),
]);
