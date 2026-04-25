import {
  A2UI_PROTOCOL_VERSION,
  type A2uiEnvelope,
  type A2uiEnvelopeKind,
  type A2uiSurfaceState,
  type A2uiSurfacesById,
  type ApplyEnvelopeResult,
  applyEnvelope,
  createEmptySurfaces,
  envelopeKind,
  envelopeSurfaceId,
  parseA2uiEnvelope,
} from "../../shared/a2ui";
import type { SessionEvent } from "../protocol";

/**
 * Upper bound on distinct surfaces held per session. When exceeded, the
 * oldest-updated (non-deleted) surface is forcibly deleted with a log line.
 * Keeps memory bounded against misbehaving agents.
 */
const MAX_SURFACES_PER_SESSION = 16;

/**
 * Maximum size (bytes) of the serialized resolved surface we will persist.
 * Larger surfaces are rejected with a structured error.
 */
const MAX_RESOLVED_SURFACE_BYTES = 256 * 1024;

export type A2uiApplyResult = {
  ok: boolean;
  error?: string;
  warning?: string;
  surfaceId?: string;
  change?: ApplyEnvelopeResult["change"];
};

/** Metadata that rides with an envelope so emitted events can carry it. */
export type A2uiApplyMeta = {
  reason?: string;
  toolCallId?: string;
};

/**
 * Validation outcome for a client-originated action (Phase 2).
 */
export type A2uiActionValidation =
  | { ok: true; surfaceId: string; componentId: string; componentType: string }
  | { ok: false; error: string; code: "unknown_surface" | "surface_deleted" | "unknown_component" };

type OverflowEvictionPlan = {
  surfaces: A2uiSurfacesById;
  evicted?: A2uiSurfaceState;
};

function findComponentType(root: unknown, componentId: string, depth = 0): string | null {
  if (depth > 64) return null;
  if (!root || typeof root !== "object") return null;
  const record = root as Record<string, unknown>;
  if (record.id === componentId && typeof record.type === "string") {
    return record.type;
  }
  const children = record.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findComponentType(child, componentId, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export type A2uiSurfaceManagerDeps = {
  sessionId: string;
  emit: (evt: SessionEvent) => void;
  log?: (line: string) => void;
};

/**
 * Per-session state machine that folds incoming A2UI envelopes into
 * resolved surfaces and broadcasts a matching `a2ui_surface` SessionEvent.
 *
 * The manager is intentionally synchronous — it lives inside the active turn
 * and is invoked from the `a2ui` tool. All state is held in memory; surfaces
 * persist for the lifetime of the session and are cleared on `reset`.
 */
export class A2uiSurfaceManager {
  private surfaces: A2uiSurfacesById = createEmptySurfaces();

  constructor(private readonly deps: A2uiSurfaceManagerDeps) {}

  getSurfaces(): A2uiSurfacesById {
    return this.surfaces;
  }

  /** Replace the entire surfaces map (used when hydrating from persistence). */
  hydrate(surfaces: A2uiSurfacesById | undefined): void {
    this.surfaces = surfaces ? { ...surfaces } : createEmptySurfaces();
  }

  reset(): void {
    // Emit deletion events for any still-active surfaces so clients can
    // flush their local renderers.
    const now = new Date().toISOString();
    for (const [_surfaceId, state] of Object.entries(this.surfaces)) {
      if (state.deleted) continue;
      this.deps.emit(
        this.resolvedEvent(
          { ...state, deleted: true, updatedAt: now },
          { changeKind: "deleteSurface" },
        ),
      );
    }
    this.surfaces = createEmptySurfaces();
  }

  /**
   * Apply a single envelope. Returns a structured result that the tool
   * layer can fold into the tool's return value. Optional `meta` gets
   * attached to the emitted SessionEvent so clients can surface a reason
   * and coalesce revisions that share a tool call.
   */
  applyEnvelope(
    envelope: A2uiEnvelope,
    now = new Date().toISOString(),
    meta: A2uiApplyMeta = {},
  ): A2uiApplyResult {
    const kind = envelopeKind(envelope);
    const incomingSurfaceId = envelopeSurfaceId(envelope);
    const overflowPlan =
      kind === "createSurface" && !this.surfaces[incomingSurfaceId]
        ? this.planOverflowEviction(this.surfaces, now)
        : { surfaces: this.surfaces };
    const result = applyEnvelope(overflowPlan.surfaces, envelope, now);

    const surfaceId = result.surfaceId;
    const state = result.surfaces[surfaceId];

    if (result.change === "noop" || !state) {
      return {
        ok: false,
        error: result.warning ?? "envelope had no effect",
        surfaceId,
        ...(result.change ? { change: result.change } : {}),
      };
    }

    const serialized = safeSerializedLength(state);
    if (serialized > MAX_RESOLVED_SURFACE_BYTES) {
      this.deps.log?.(
        `[a2ui] rejected surface ${surfaceId}: resolved state ${serialized}B exceeds ${MAX_RESOLVED_SURFACE_BYTES}B cap`,
      );
      return {
        ok: false,
        error: `resolved surface exceeds ${MAX_RESOLVED_SURFACE_BYTES} bytes`,
        surfaceId,
      };
    }

    this.surfaces = { ...result.surfaces };
    if (overflowPlan.evicted) {
      this.deps.log?.(
        `[a2ui] evicting oldest surface ${overflowPlan.evicted.surfaceId} to stay under cap (${MAX_SURFACES_PER_SESSION})`,
      );
      this.deps.emit(this.resolvedEvent(overflowPlan.evicted, { changeKind: "deleteSurface" }));
    }
    this.deps.emit(this.resolvedEvent(state, { ...meta, changeKind: kind }));

    return {
      ok: true,
      surfaceId,
      change: result.change,
      ...(result.warning ? { warning: result.warning } : {}),
    };
  }

  /** Apply multiple envelopes and aggregate per-envelope results. */
  applyEnvelopes(envelopes: readonly A2uiEnvelope[], meta: A2uiApplyMeta = {}): A2uiApplyResult[] {
    const now = new Date().toISOString();
    return envelopes.map((envelope) => this.applyEnvelope(envelope, now, meta));
  }

  /** Apply a loosely-typed value (JSON string or object) after parsing. */
  applyUnknown(value: unknown, meta: A2uiApplyMeta = {}): A2uiApplyResult {
    const parsed = parseA2uiEnvelope(value);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    return this.applyEnvelope(parsed.envelope, undefined, meta);
  }

  /**
   * Validate that `surfaceId` / `componentId` refers to a component currently
   * rendered in a non-deleted surface. Used by the client→server action
   * channel to reject stale or spoofed events.
   */
  validateAction(opts: { surfaceId: string; componentId: string }): A2uiActionValidation {
    const surface = this.surfaces[opts.surfaceId];
    if (!surface) {
      return {
        ok: false,
        code: "unknown_surface",
        error: `surface ${JSON.stringify(opts.surfaceId)} is not active`,
      };
    }
    if (surface.deleted) {
      return {
        ok: false,
        code: "surface_deleted",
        error: `surface ${JSON.stringify(opts.surfaceId)} has been deleted`,
      };
    }
    const componentType = findComponentType(surface.root, opts.componentId);
    if (!componentType) {
      return {
        ok: false,
        code: "unknown_component",
        error: `component ${JSON.stringify(opts.componentId)} is not present in surface ${JSON.stringify(opts.surfaceId)}`,
      };
    }
    return {
      ok: true,
      surfaceId: opts.surfaceId,
      componentId: opts.componentId,
      componentType,
    };
  }

  private resolvedEvent(
    state: A2uiSurfaceState,
    meta: A2uiApplyMeta & { changeKind?: A2uiEnvelopeKind } = {},
  ): SessionEvent {
    return {
      type: "a2ui_surface",
      sessionId: this.deps.sessionId,
      surfaceId: state.surfaceId,
      catalogId: state.catalogId,
      version: A2UI_PROTOCOL_VERSION,
      revision: state.revision,
      deleted: state.deleted,
      ...(state.theme ? { theme: { ...state.theme } } : {}),
      ...(state.root ? { root: state.root as unknown as Record<string, unknown> } : {}),
      ...(state.dataModel !== undefined ? { dataModel: state.dataModel } : {}),
      updatedAt: state.updatedAt,
      ...(meta.changeKind ? { changeKind: meta.changeKind } : {}),
      ...(meta.reason ? { reason: meta.reason } : {}),
      ...(meta.toolCallId ? { toolCallId: meta.toolCallId } : {}),
    };
  }

  private planOverflowEviction(surfaces: A2uiSurfacesById, now: string): OverflowEvictionPlan {
    const ids = Object.keys(surfaces);
    if (ids.length < MAX_SURFACES_PER_SESSION) {
      return { surfaces };
    }

    const deletedIds = ids
      .map((id) => surfaces[id])
      .filter((state): state is A2uiSurfaceState => Boolean(state))
      .filter((state) => state.deleted)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .map((state) => state.surfaceId);
    let nextSurfaces = surfaces;
    if (deletedIds.length > 0) {
      nextSurfaces = { ...surfaces };
      while (
        Object.keys(nextSurfaces).length >= MAX_SURFACES_PER_SESSION &&
        deletedIds.length > 0
      ) {
        const deletedSurfaceId = deletedIds.shift();
        if (!deletedSurfaceId) break;
        const { [deletedSurfaceId]: _pruned, ...rest } = nextSurfaces;
        nextSurfaces = rest;
      }
      if (Object.keys(nextSurfaces).length < MAX_SURFACES_PER_SESSION) {
        return { surfaces: nextSurfaces };
      }
    }

    // Evict oldest non-deleted surface.
    const sorted = Object.keys(nextSurfaces)
      .map((id) => nextSurfaces[id])
      .filter((state): state is A2uiSurfaceState => Boolean(state))
      .filter((state) => !state.deleted)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const victim = sorted[0];
    if (!victim) return { surfaces: nextSurfaces };

    const evicted: A2uiSurfaceState = {
      ...victim,
      deleted: true,
      revision: victim.revision + 1,
      updatedAt: now,
    };
    const { [victim.surfaceId]: _evicted, ...rest } = nextSurfaces;
    return {
      surfaces: rest,
      evicted,
    };
  }
}

function safeSerializedLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export { envelopeSurfaceId };
