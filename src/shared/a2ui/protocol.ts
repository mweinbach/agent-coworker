import { z } from "zod";

/**
 * A2UI protocol v0.9 envelope schemas.
 *
 * Reference: https://github.com/google/A2UI/blob/main/specification/v0_9/docs/a2ui_protocol.md
 *
 * The v0.9 protocol is a stream of JSON envelopes emitted by the agent. Each envelope
 * carries `version: "v0.9"` and exactly one of four operations:
 *
 *   - `createSurface`     — create a new named UI surface
 *   - `updateComponents`  — upsert/delete components under a surface by component id
 *   - `updateDataModel`   — mutate the surface's JSON data model at a json-pointer path
 *   - `deleteSurface`     — remove a surface
 *
 * Our implementation supports v0.9 only; incoming envelopes with other versions are
 * rejected with a clear error so the agent can correct.
 */

export const A2UI_PROTOCOL_VERSION = "v0.9" as const;

/** Maximum serialized size (in bytes) we accept for a single envelope. */
export const A2UI_MAX_ENVELOPE_BYTES = 128 * 1024;

const surfaceIdSchema = z
  .string()
  .trim()
  .min(1, "surfaceId is required")
  .max(200, "surfaceId is too long");

const catalogIdSchema = z
  .string()
  .trim()
  .min(1, "catalogId is required")
  .max(2048, "catalogId is too long");

const themeSchema = z.record(z.string(), z.unknown());

const jsonValueSchema: z.ZodType<unknown> = z.unknown();

/**
 * A single "component" in the A2UI tree. We keep this permissive at the
 * envelope layer so that agents can ship arbitrary catalog components; the
 * desktop renderer validates and rejects anything outside our basic-catalog
 * subset.
 */
export const a2uiComponentSchema: z.ZodType<A2uiComponent> = z.lazy(() =>
  z
    .object({
      id: z.string().trim().min(1).max(200),
      type: z.string().trim().min(1).max(200),
      props: z.record(z.string(), z.unknown()).optional(),
      children: z.array(a2uiComponentSchema).optional(),
      /** Pass-through for catalog-specific fields we don't yet model. */
    })
    .passthrough(),
);

export type A2uiComponent = {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  children?: A2uiComponent[];
  [key: string]: unknown;
};

const createSurfaceSchema = z
  .object({
    surfaceId: surfaceIdSchema,
    catalogId: catalogIdSchema,
    theme: themeSchema.optional(),
    /** Optional initial root component. */
    root: a2uiComponentSchema.optional(),
    /** Optional initial data model. */
    dataModel: jsonValueSchema.optional(),
    /** Hint that the server should echo client-side data model changes back. */
    sendDataModel: z.boolean().optional(),
  })
  .strict();

const updateComponentsSchema = z
  .object({
    surfaceId: surfaceIdSchema,
    /**
     * New or replacement root. When provided, replaces the existing tree.
     * Either `root` or `components` (keyed updates) must be provided.
     */
    root: a2uiComponentSchema.optional(),
    /** Upsert one or more components. Each must carry an `id`. */
    components: z.array(a2uiComponentSchema).optional(),
    /** Delete components by id. */
    deleteIds: z.array(z.string().trim().min(1)).optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.root) || (value.components?.length ?? 0) > 0 || (value.deleteIds?.length ?? 0) > 0,
    "updateComponents must provide root, components, or deleteIds",
  );

const updateDataModelSchema = z
  .object({
    surfaceId: surfaceIdSchema,
    /**
     * JSON-pointer-style path (e.g. `/user/name`). Empty string targets the
     * whole model.
     */
    path: z.string().max(2048),
    /** New value to set at `path`. Use `null` to clear. */
    value: jsonValueSchema,
    /** Delete the node at `path` instead of setting a value. */
    delete: z.boolean().optional(),
  })
  .strict();

const deleteSurfaceSchema = z
  .object({
    surfaceId: surfaceIdSchema,
  })
  .strict();

/**
 * A2UI v0.9 envelope. Exactly one of the four operations is set.
 */
export const a2uiEnvelopeSchema = z
  .object({
    version: z.literal(A2UI_PROTOCOL_VERSION),
    createSurface: createSurfaceSchema.optional(),
    updateComponents: updateComponentsSchema.optional(),
    updateDataModel: updateDataModelSchema.optional(),
    deleteSurface: deleteSurfaceSchema.optional(),
  })
  .strict()
  .refine((value) => {
    const operations = [
      value.createSurface,
      value.updateComponents,
      value.updateDataModel,
      value.deleteSurface,
    ].filter((entry) => entry !== undefined);
    return operations.length === 1;
  }, "envelope must carry exactly one of createSurface | updateComponents | updateDataModel | deleteSurface");

export type A2uiCreateSurface = z.infer<typeof createSurfaceSchema>;
export type A2uiUpdateComponents = z.infer<typeof updateComponentsSchema>;
export type A2uiUpdateDataModel = z.infer<typeof updateDataModelSchema>;
export type A2uiDeleteSurface = z.infer<typeof deleteSurfaceSchema>;
export type A2uiEnvelope = z.infer<typeof a2uiEnvelopeSchema>;

export type A2uiEnvelopeKind =
  | "createSurface"
  | "updateComponents"
  | "updateDataModel"
  | "deleteSurface";

export function envelopeKind(envelope: A2uiEnvelope): A2uiEnvelopeKind {
  if (envelope.createSurface) return "createSurface";
  if (envelope.updateComponents) return "updateComponents";
  if (envelope.updateDataModel) return "updateDataModel";
  if (envelope.deleteSurface) return "deleteSurface";
  // Schema invariant: refine() guarantees exactly one operation.
  throw new Error("Invalid A2UI envelope: no operation set");
}

export function envelopeSurfaceId(envelope: A2uiEnvelope): string {
  if (envelope.createSurface) return envelope.createSurface.surfaceId;
  if (envelope.updateComponents) return envelope.updateComponents.surfaceId;
  if (envelope.updateDataModel) return envelope.updateDataModel.surfaceId;
  if (envelope.deleteSurface) return envelope.deleteSurface.surfaceId;
  throw new Error("Invalid A2UI envelope: no operation set");
}

export type ParsedEnvelope =
  | { ok: true; envelope: A2uiEnvelope }
  | { ok: false; error: string };

function serializedEnvelopeBytes(value: unknown): number | null {
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    return new TextEncoder().encode(serialized).length;
  } catch {
    return null;
  }
}

/**
 * Parse an unknown value into an A2UI v0.9 envelope. Returns a discriminated
 * union so callers can render a user-visible error without throwing.
 */
export function parseA2uiEnvelope(value: unknown): ParsedEnvelope {
  if (typeof value === "string") {
    const bytes = serializedEnvelopeBytes(value);
    if (bytes !== null && bytes > A2UI_MAX_ENVELOPE_BYTES) {
      return { ok: false, error: `envelope exceeds ${A2UI_MAX_ENVELOPE_BYTES} bytes` };
    }
    try {
      value = JSON.parse(value);
    } catch (error) {
      return { ok: false, error: `envelope is not valid JSON: ${(error as Error).message}` };
    }
  }

  if (
    value !== null &&
    typeof value === "object" &&
    "version" in (value as Record<string, unknown>) &&
    (value as Record<string, unknown>).version !== A2UI_PROTOCOL_VERSION
  ) {
    const observed = (value as Record<string, unknown>).version;
    return {
      ok: false,
      error: `unsupported A2UI version: expected ${A2UI_PROTOCOL_VERSION}, got ${JSON.stringify(observed)}`,
    };
  }

  const bytes = serializedEnvelopeBytes(value);
  if (bytes !== null && bytes > A2UI_MAX_ENVELOPE_BYTES) {
    return { ok: false, error: `envelope exceeds ${A2UI_MAX_ENVELOPE_BYTES} bytes` };
  }

  const parsed = a2uiEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? issue.path.join(".") : "envelope";
    const message = issue?.message ?? "envelope failed schema validation";
    return { ok: false, error: `${path}: ${message}` };
  }

  return { ok: true, envelope: parsed.data };
}
