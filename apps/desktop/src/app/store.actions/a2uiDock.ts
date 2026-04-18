import type { AppStoreActions, StoreGet, StoreSet } from "../store.helpers";
import {
  focusSurface,
  markSurfaceSeen,
  setActiveRevision,
  setExpanded,
} from "../a2uiDockReducer";
import { createDefaultA2uiDock } from "../types";

type A2uiDockActionKeys =
  | "setA2uiDockExpanded"
  | "focusA2uiSurface"
  | "setA2uiActiveRevision"
  | "markA2uiSurfaceSeen";

export function createA2uiDockActions(
  set: StoreSet,
  _get: StoreGet,
): Pick<AppStoreActions, A2uiDockActionKeys> {
  return {
    setA2uiDockExpanded: (threadId, expanded) => {
      set((s) => {
        const runtime = s.threadRuntimeById[threadId];
        if (!runtime) return {};
        const currentDock = runtime.a2uiDock ?? createDefaultA2uiDock();
        const nextDock = setExpanded(currentDock, expanded);
        if (nextDock === runtime.a2uiDock) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: { ...runtime, a2uiDock: nextDock },
          },
        };
      });
    },

    focusA2uiSurface: (threadId, surfaceId) => {
      set((s) => {
        const runtime = s.threadRuntimeById[threadId];
        if (!runtime) return {};
        const currentDock = runtime.a2uiDock ?? createDefaultA2uiDock();
        const nextDock = focusSurface(currentDock, surfaceId);
        if (nextDock === runtime.a2uiDock) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: { ...runtime, a2uiDock: nextDock },
          },
        };
      });
    },

    setA2uiActiveRevision: (threadId, surfaceId, revision) => {
      set((s) => {
        const runtime = s.threadRuntimeById[threadId];
        if (!runtime) return {};
        const currentDock = runtime.a2uiDock ?? createDefaultA2uiDock();
        const nextDock = setActiveRevision(currentDock, surfaceId, revision);
        if (nextDock === runtime.a2uiDock) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: { ...runtime, a2uiDock: nextDock },
          },
        };
      });
    },

    markA2uiSurfaceSeen: (threadId, surfaceId, revision) => {
      set((s) => {
        const runtime = s.threadRuntimeById[threadId];
        if (!runtime) return {};
        const currentDock = runtime.a2uiDock ?? createDefaultA2uiDock();
        const nextDock = markSurfaceSeen(currentDock, surfaceId, revision);
        if (nextDock === runtime.a2uiDock) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: { ...runtime, a2uiDock: nextDock },
          },
        };
      });
    },
  };
}
