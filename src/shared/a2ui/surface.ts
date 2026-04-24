import { setByPointer, splitPointer } from "./expressions";
import { type A2uiComponent, type A2uiEnvelope, envelopeKind, envelopeSurfaceId } from "./protocol";

/**
 * Canonical resolved state for a single A2UI surface. Server + client both
 * fold envelopes into this shape using {@link applyEnvelope}.
 */
export type A2uiSurfaceState = {
  surfaceId: string;
  catalogId: string;
  theme?: Record<string, unknown>;
  root?: A2uiComponent;
  dataModel?: unknown;
  sendDataModel?: boolean;
  /** Monotonically increases each time an envelope is folded in. */
  revision: number;
  /** ISO timestamp of the last fold. */
  updatedAt: string;
  /** `true` after a deleteSurface envelope; the state may still be kept for UX. */
  deleted: boolean;
};

export type A2uiSurfacesById = Readonly<Record<string, A2uiSurfaceState>>;

export function createEmptySurfaces(): A2uiSurfacesById {
  return {};
}

export type ApplyEnvelopeResult = {
  surfaces: A2uiSurfacesById;
  change: "created" | "updated" | "deleted" | "noop";
  surfaceId: string;
  /** If the envelope referenced an unknown surface, contains a user-visible warning. */
  warning?: string;
};

function shallowCloneComponent(component: A2uiComponent): A2uiComponent {
  return {
    ...component,
    ...(component.props ? { props: { ...component.props } } : {}),
    ...(component.children ? { children: component.children.map(shallowCloneComponent) } : {}),
  };
}

/**
 * Walk the tree rooted at `node` and replace any component whose `id` is in
 * `updatesById` with the provided version (deep-merging props and replacing
 * children). Returns a new tree if any node changed; otherwise returns the
 * input.
 *
 * Also drops any component whose id is in `deleteIds`.
 */
function replaceInTree(
  node: A2uiComponent,
  updatesById: Map<string, A2uiComponent>,
  deleteIds: Set<string>,
): A2uiComponent | null {
  if (deleteIds.has(node.id)) return null;

  let next: A2uiComponent = node;
  const override = updatesById.get(node.id);
  if (override) {
    next = {
      ...node,
      ...override,
      props: { ...(node.props ?? {}), ...(override.props ?? {}) },
      children: override.children ?? node.children,
    };
  }

  if (next.children && next.children.length > 0) {
    const mapped: A2uiComponent[] = [];
    for (const child of next.children) {
      const replaced = replaceInTree(child, updatesById, deleteIds);
      if (replaced) mapped.push(replaced);
    }
    next = { ...next, children: mapped };
  }
  return shallowCloneComponent(next);
}

/**
 * Pure reducer: apply a parsed A2UI envelope to the surfaces map and return
 * the new map. Never mutates the input.
 */
export function applyEnvelope(
  surfaces: A2uiSurfacesById,
  envelope: A2uiEnvelope,
  nowIso: string = new Date().toISOString(),
): ApplyEnvelopeResult {
  const surfaceId = envelopeSurfaceId(envelope);
  const kind = envelopeKind(envelope);
  const existing = surfaces[surfaceId];

  if (kind === "createSurface") {
    const cs = envelope.createSurface;
    if (!cs) {
      return { surfaces, change: "noop", surfaceId, warning: "Missing createSurface payload" };
    }
    const state: A2uiSurfaceState = {
      surfaceId,
      catalogId: cs.catalogId,
      ...(cs.theme ? { theme: { ...cs.theme } } : {}),
      ...(cs.root ? { root: shallowCloneComponent(cs.root) } : {}),
      ...(cs.dataModel !== undefined ? { dataModel: cs.dataModel } : {}),
      ...(cs.sendDataModel === true ? { sendDataModel: true } : {}),
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: nowIso,
      deleted: false,
    };
    return {
      surfaces: { ...surfaces, [surfaceId]: state },
      change: existing ? "updated" : "created",
      surfaceId,
    };
  }

  if (kind === "updateComponents") {
    if (!existing || existing.deleted) {
      return {
        surfaces,
        change: "noop",
        surfaceId,
        warning: `updateComponents targets unknown surface ${JSON.stringify(surfaceId)}`,
      };
    }
    const uc = envelope.updateComponents;
    if (!uc) {
      return { surfaces, change: "noop", surfaceId, warning: "Missing updateComponents payload" };
    }
    let root: A2uiComponent | undefined = existing.root;
    if (uc.root) {
      root = shallowCloneComponent(uc.root);
    }

    if (root) {
      const updatesById = new Map<string, A2uiComponent>();
      for (const comp of uc.components ?? []) {
        updatesById.set(comp.id, comp);
      }
      const deleteIds = new Set<string>(uc.deleteIds ?? []);
      if (updatesById.size > 0 || deleteIds.size > 0) {
        const rebuilt = replaceInTree(root, updatesById, deleteIds);
        if (rebuilt !== null) {
          root = rebuilt;
        } else {
          root = undefined;
        }
      }
    } else if ((uc.components?.length ?? 0) > 0) {
      // No existing root; synthesize one from the first component if the agent
      // forgot the initial createSurface root.
      const components = uc.components ?? [];
      const [first, ...rest] = components;
      if (!first) {
        return { surfaces, change: "noop", surfaceId, warning: "Missing update component root" };
      }
      root = shallowCloneComponent(first);
      if (rest.length > 0) {
        root.children = [...(root.children ?? []), ...rest.map(shallowCloneComponent)];
      }
    }

    const next: A2uiSurfaceState = {
      ...existing,
      root,
      revision: existing.revision + 1,
      updatedAt: nowIso,
      deleted: false,
    };
    return {
      surfaces: { ...surfaces, [surfaceId]: next },
      change: "updated",
      surfaceId,
    };
  }

  if (kind === "updateDataModel") {
    if (!existing || existing.deleted) {
      return {
        surfaces,
        change: "noop",
        surfaceId,
        warning: `updateDataModel targets unknown surface ${JSON.stringify(surfaceId)}`,
      };
    }
    const udm = envelope.updateDataModel;
    if (!udm) {
      return { surfaces, change: "noop", surfaceId, warning: "Missing updateDataModel payload" };
    }
    const tokens = splitPointer(udm.path);
    const nextModel = setByPointer(
      existing.dataModel ?? {},
      tokens,
      udm.value,
      udm.delete === true,
    );
    const next: A2uiSurfaceState = {
      ...existing,
      dataModel: nextModel,
      revision: existing.revision + 1,
      updatedAt: nowIso,
    };
    return {
      surfaces: { ...surfaces, [surfaceId]: next },
      change: "updated",
      surfaceId,
    };
  }

  // deleteSurface
  if (!existing) {
    return {
      surfaces,
      change: "noop",
      surfaceId,
      warning: `deleteSurface targets unknown surface ${JSON.stringify(surfaceId)}`,
    };
  }
  const next: A2uiSurfaceState = {
    ...existing,
    deleted: true,
    revision: existing.revision + 1,
    updatedAt: nowIso,
  };
  return {
    surfaces: { ...surfaces, [surfaceId]: next },
    change: "deleted",
    surfaceId,
  };
}

export function toSerializable(state: A2uiSurfaceState): A2uiSurfaceState {
  return structuredClone(state);
}
