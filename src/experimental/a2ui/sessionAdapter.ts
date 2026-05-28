import type { SessionEvent } from "../../server/protocol";
import type { SessionSnapshot } from "../../shared/sessionSnapshot";
import type { A2uiComponent, A2uiSurfaceState, A2uiSurfacesById } from "./index";
import { A2uiSurfaceManager } from "./SurfaceManager";

type ExperimentalA2uiManager = {
  applyUnknown: A2uiSurfaceManager["applyUnknown"];
  validateAction: A2uiSurfaceManager["validateAction"];
  hydrate: (surfaces: unknown) => void;
  reset: A2uiSurfaceManager["reset"];
};

export type ExperimentalA2uiManagerFactory = (deps: {
  sessionId: string;
  emit: (evt: SessionEvent) => void;
  log?: (line: string) => void;
}) => ExperimentalA2uiManager;

export const createExperimentalA2uiSurfaceManager: ExperimentalA2uiManagerFactory = (deps) => {
  const manager = new A2uiSurfaceManager(deps);
  return {
    applyUnknown: (value, meta) => manager.applyUnknown(value, meta),
    validateAction: (opts) => manager.validateAction(opts),
    hydrate: (surfaces) => manager.hydrate(surfaces as A2uiSurfacesById | undefined),
    reset: () => manager.reset(),
  };
};

export function deriveA2uiSurfacesFromSnapshot(
  snapshot: SessionSnapshot | null | undefined,
): A2uiSurfacesById | undefined {
  if (!snapshot) return undefined;

  const surfaces: Record<string, A2uiSurfaceState> = {};
  for (const item of snapshot.feed) {
    if (item.kind !== "ui_surface") continue;
    const existing = surfaces[item.surfaceId];
    if (existing && existing.revision > item.revision) {
      continue;
    }
    surfaces[item.surfaceId] = {
      surfaceId: item.surfaceId,
      catalogId: item.catalogId,
      ...(item.theme ? { theme: structuredClone(item.theme) } : {}),
      ...(item.root ? { root: structuredClone(item.root) as A2uiComponent } : {}),
      ...(item.dataModel !== undefined ? { dataModel: structuredClone(item.dataModel) } : {}),
      revision: item.revision,
      updatedAt: item.ts,
      deleted: item.deleted,
    };
  }

  return Object.keys(surfaces).length > 0 ? surfaces : undefined;
}
