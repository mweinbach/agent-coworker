import { z } from "zod";

import { nonEmptyTrimmedStringSchema } from "./schema.shared";

/**
 * Schemas for the A2UI Phase 2 action channel.
 *
 * Surface renderers dispatch user interactions (button clicks, form submits,
 * checkbox toggles, etc.) as JSON-RPC requests. The harness validates the
 * action against the current surface state, synthesizes a structured user
 * message for the agent, and acknowledges delivery to the client.
 */

const surfaceActionEventTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe("Opaque event kind; e.g. 'click', 'submit', 'change'. Agents interpret it.");

const surfaceActionPayloadSchema = z
  .record(z.string(), z.unknown())
  .describe("Free-form key/value payload (e.g. current TextField values, checkbox state).");

export const a2uiActionDispatchRequestSchema = z
  .object({
    threadId: nonEmptyTrimmedStringSchema,
    surfaceId: nonEmptyTrimmedStringSchema,
    componentId: nonEmptyTrimmedStringSchema,
    eventType: surfaceActionEventTypeSchema,
    payload: surfaceActionPayloadSchema.optional(),
    /** Monotonic client id so re-dispatches can be deduped (optional). */
    clientMessageId: nonEmptyTrimmedStringSchema.optional(),
  })
  .strict();

export const a2uiActionDispatchResultSchema = z
  .object({
    /** "delivered-as-steer" when the active turn accepted it, "delivered-as-turn" when a new turn was started. */
    delivery: z.enum(["delivered-as-steer", "delivered-as-turn"]),
    /** The turnId the action was folded into (new or existing). */
    turnId: nonEmptyTrimmedStringSchema,
  })
  .strict();

export const jsonRpcA2uiRequestSchemas = {
  "cowork/session/a2ui/action": a2uiActionDispatchRequestSchema,
} as const;

export const jsonRpcA2uiResultSchemas = {
  "cowork/session/a2ui/action": a2uiActionDispatchResultSchema,
} as const;

/**
 * Structured text body of the user/steer message synthesized by the harness
 * when delivering an action to the agent. Kept alongside the schema so both
 * the harness and any test helpers use the same canonical shape.
 */
export function formatA2uiActionDeliveryText(opts: {
  surfaceId: string;
  componentId: string;
  eventType: string;
  payload?: Record<string, unknown>;
}): string {
  const payloadText =
    opts.payload && Object.keys(opts.payload).length > 0
      ? `\npayload: ${JSON.stringify(opts.payload)}`
      : "";
  return [
    `[a2ui.action] The user interacted with surface "${opts.surfaceId}".`,
    `component: ${opts.componentId}`,
    `event: ${opts.eventType}${payloadText}`,
    "",
    "Respond with another a2ui tool call to update the surface (or reply in plain text).",
  ].join("\n");
}
