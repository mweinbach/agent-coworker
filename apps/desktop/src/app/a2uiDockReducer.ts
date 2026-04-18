import {
  MAX_A2UI_REVISIONS_PER_SURFACE,
  type A2uiSurfaceRevision,
  type A2uiThreadDock,
  type FeedItem,
} from "./types";

export type ProjectedUiSurface = {
  type: "uiSurface";
  surfaceId: string;
  catalogId: string;
  version: "v0.9";
  revision: number;
  deleted: boolean;
  theme?: Record<string, unknown>;
  root?: Record<string, unknown>;
  dataModel?: unknown;
};

function toRevision(item: ProjectedUiSurface, ts: string): A2uiSurfaceRevision {
  return {
    revision: item.revision,
    ts,
    catalogId: item.catalogId,
    version: item.version,
    deleted: item.deleted,
    ...(item.theme !== undefined ? { theme: item.theme } : {}),
    ...(item.root !== undefined ? { root: item.root } : {}),
    ...(item.dataModel !== undefined ? { dataModel: item.dataModel } : {}),
  };
}

/**
 * Append a new revision to the dock state for a surface. When a revision
 * number already exists we replace it (the item arrived as both `started` and
 * `completed`). Keeps revisions capped at MAX_A2UI_REVISIONS_PER_SURFACE.
 *
 * Auto-focuses the surface if the dock has no focus yet, or if the incoming
 * revision is a new one (so a mid-stream update brings the dock to the most
 * recent surface). Never steals focus from the user's picked surface when the
 * event is just a repeated revision.
 */
export function recordSurfaceRevision(
  dock: A2uiThreadDock,
  item: ProjectedUiSurface,
  ts: string,
): A2uiThreadDock {
  const existing = dock.revisionsBySurfaceId[item.surfaceId] ?? [];
  const newRev = toRevision(item, ts);
  const hadSameRevision = existing.some((r) => r.revision === item.revision);

  let merged: A2uiSurfaceRevision[];
  if (hadSameRevision) {
    merged = existing.map((r) => (r.revision === item.revision ? newRev : r));
  } else {
    const appended = [...existing, newRev];
    appended.sort((a, b) => a.revision - b.revision);
    merged = appended.slice(-MAX_A2UI_REVISIONS_PER_SURFACE);
  }

  const shouldFocus = !dock.focusedSurfaceId || !hadSameRevision;
  // Active revision: sticky at the latest unless the user has scrubbed back.
  const existingActive = dock.activeRevisionBySurfaceId[item.surfaceId];
  const wasAtLatest = existingActive === undefined || existingActive === (existing[existing.length - 1]?.revision ?? -1);
  const nextActive = wasAtLatest ? item.revision : existingActive;

  return {
    ...dock,
    revisionsBySurfaceId: {
      ...dock.revisionsBySurfaceId,
      [item.surfaceId]: merged,
    },
    focusedSurfaceId: shouldFocus ? item.surfaceId : dock.focusedSurfaceId,
    activeRevisionBySurfaceId: {
      ...dock.activeRevisionBySurfaceId,
      [item.surfaceId]: nextActive,
    },
    // Deliberately don't touch lastSeenRevisionBySurfaceId here — the pulse
    // indicator stays active until the user opens/views this surface.
  };
}

export function focusSurface(
  dock: A2uiThreadDock,
  surfaceId: string | null,
): A2uiThreadDock {
  if (dock.focusedSurfaceId === surfaceId) return dock;
  return { ...dock, focusedSurfaceId: surfaceId };
}

export function setExpanded(dock: A2uiThreadDock, expanded: boolean): A2uiThreadDock {
  if (dock.expanded === expanded) return dock;
  return { ...dock, expanded };
}

export function setActiveRevision(
  dock: A2uiThreadDock,
  surfaceId: string,
  revision: number,
): A2uiThreadDock {
  if (dock.activeRevisionBySurfaceId[surfaceId] === revision) return dock;
  return {
    ...dock,
    activeRevisionBySurfaceId: {
      ...dock.activeRevisionBySurfaceId,
      [surfaceId]: revision,
    },
  };
}

export function markSurfaceSeen(
  dock: A2uiThreadDock,
  surfaceId: string,
  revision: number,
): A2uiThreadDock {
  const current = dock.lastSeenRevisionBySurfaceId[surfaceId];
  if (current !== undefined && current >= revision) return dock;
  return {
    ...dock,
    lastSeenRevisionBySurfaceId: {
      ...dock.lastSeenRevisionBySurfaceId,
      [surfaceId]: revision,
    },
  };
}

/**
 * Seed a dock from a snapshot feed. The server only keeps the latest revision
 * per surface in the feed, so post-hydration the dock starts with one revision
 * per surface — subsequent live updates append to the history from there.
 *
 * An existing dock is passed through when the surface is already being tracked
 * at the same or newer revision, so we never accidentally rewind local state.
 */
export function seedDockFromFeed(
  previous: A2uiThreadDock,
  feed: readonly FeedItem[],
  fallbackTs: string,
): A2uiThreadDock {
  let dock = previous;
  for (const item of feed) {
    if (item.kind !== "ui_surface") continue;
    const existingRevs = dock.revisionsBySurfaceId[item.surfaceId] ?? [];
    const existingMaxRev = existingRevs.length ? existingRevs[existingRevs.length - 1]!.revision : -1;
    if (item.revision <= existingMaxRev) continue;
    const projected: ProjectedUiSurface = {
      type: "uiSurface",
      surfaceId: item.surfaceId,
      catalogId: item.catalogId,
      version: item.version,
      revision: item.revision,
      deleted: item.deleted,
      ...(item.theme !== undefined ? { theme: item.theme } : {}),
      ...(item.root !== undefined ? { root: item.root } : {}),
      ...(item.dataModel !== undefined ? { dataModel: item.dataModel } : {}),
    };
    dock = recordSurfaceRevision(dock, projected, item.ts ?? fallbackTs);
  }
  return dock;
}

export function latestRevision(revisions: readonly A2uiSurfaceRevision[]): A2uiSurfaceRevision | null {
  return revisions.length === 0 ? null : revisions[revisions.length - 1]!;
}

export function revisionByNumber(
  revisions: readonly A2uiSurfaceRevision[],
  revision: number,
): A2uiSurfaceRevision | null {
  return revisions.find((r) => r.revision === revision) ?? null;
}
