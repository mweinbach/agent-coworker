import { z } from "zod";

import { A2UI_PROTOCOL_VERSION, describeSupportedComponents } from "../shared/a2ui";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

/**
 * Envelope input schema. We keep this intentionally permissive so that agents
 * can experiment with the full v0.9 envelope shape — validation happens in
 * the shared kernel (`parseA2uiEnvelope`) when the envelope is applied.
 */
const envelopeValueSchema = z
  .union([z.record(z.string(), z.unknown()), z.string()])
  .describe(
    'Single A2UI envelope. Either an object like { version: "v0.9", createSurface: {...} } ' +
      "or a JSON-encoded string of the same.",
  );

const a2uiInputSchema = z
  .object({
    envelopes: z
      .array(envelopeValueSchema)
      .min(1)
      .describe("Ordered list of A2UI v0.9 envelopes to apply."),
    reason: z
      .string()
      .optional()
      .describe(
        "Optional free-form note explaining why these envelopes were sent. Shown in tool traces.",
      ),
  })
  .strict();

const A2UI_TOOL_DESCRIPTION = `Render or update generative UI surfaces using the A2UI v${A2UI_PROTOCOL_VERSION} streaming protocol.

Each call accepts one or more A2UI envelopes. Exactly one operation per envelope:
  - createSurface     → create a new UI surface with a component tree + data model.
  - updateComponents  → upsert/replace/delete components inside an existing surface by id.
  - updateDataModel   → mutate the surface's JSON data model at a JSON-pointer path.
  - deleteSurface     → remove a surface entirely.

Envelopes must carry "version": "${A2UI_PROTOCOL_VERSION}".

The desktop renderer currently supports the v0.9 basic catalog (https://a2ui.org/specification/v0_9/basic_catalog.json)
with these component types: ${describeSupportedComponents()}. Other catalogs still render, but unknown
component types will show a diagnostic fallback card.

Example (minimal createSurface):
  {
    "version": "${A2UI_PROTOCOL_VERSION}",
    "createSurface": {
      "surfaceId": "greeter",
      "catalogId": "https://a2ui.org/specification/v0_9/basic_catalog.json",
      "root": {
        "id": "root",
        "type": "Column",
        "children": [
          { "id": "title", "type": "Heading", "props": { "text": "Hi there" } },
          { "id": "body",  "type": "Text",    "props": { "text": { "path": "/message" } } }
        ]
      },
      "dataModel": { "message": "Welcome to A2UI." }
    }
  }

Security rules (enforced by the client):
  - Text values always render as plain text. HTML tags are NOT parsed.
  - Image URLs must be http(s). Other schemes are ignored.
  - In supported clients, interactions (button clicks, form submits) are delivered
    back to the agent through A2UI action events. Design surfaces so the agent can
    react with follow-up a2ui tool calls or normal assistant text after user input.`;

export function createA2uiTool(ctx: ToolContext) {
  return defineTool({
    description: A2UI_TOOL_DESCRIPTION,
    inputSchema: a2uiInputSchema,
    execute: async (input: z.infer<typeof a2uiInputSchema>, options?: { toolCallId?: string }) => {
      if (!ctx.applyA2uiEnvelope) {
        throw new Error(
          "A2UI is not enabled for this session. Enable `featureFlags.workspace.a2ui` for this workspace.",
        );
      }
      if (input.reason) {
        ctx.log(
          `tool> a2ui ${JSON.stringify({ count: input.envelopes.length, reason: input.reason })}`,
        );
      } else {
        ctx.log(`tool> a2ui ${JSON.stringify({ count: input.envelopes.length })}`);
      }

      const meta =
        input.reason || options?.toolCallId
          ? {
              ...(input.reason ? { reason: input.reason } : {}),
              ...(options?.toolCallId ? { toolCallId: options.toolCallId } : {}),
            }
          : undefined;
      const results = input.envelopes.map((envelope, index) => {
        const applied = ctx.applyA2uiEnvelope!(envelope, meta);
        return {
          index,
          ok: applied.ok,
          ...(applied.surfaceId ? { surfaceId: applied.surfaceId } : {}),
          ...(applied.change ? { change: applied.change } : {}),
          ...(applied.error ? { error: applied.error } : {}),
          ...(applied.warning ? { warning: applied.warning } : {}),
        };
      });

      const summary = {
        applied: results.filter((entry) => entry.ok).length,
        failed: results.filter((entry) => !entry.ok).length,
        results,
      };
      ctx.log(`tool< a2ui ${JSON.stringify(summary)}`);
      return summary;
    },
  });
}
