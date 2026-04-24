import { describe, expect, test } from "bun:test";

import {
  focusSurface,
  latestRevision,
  markSurfaceSeen,
  type ProjectedUiSurface,
  recordSurfaceRevision,
  revisionByNumber,
  setActiveRevision,
  setExpanded,
} from "../src/app/a2uiDockReducer";
import {
  type A2uiThreadDock,
  createDefaultA2uiDock,
  MAX_A2UI_REVISIONS_PER_SURFACE,
} from "../src/app/types";

const catalogId = "https://a2ui.org/specification/v0_9/basic_catalog.json";

function makeProjected(partial: Partial<ProjectedUiSurface> = {}): ProjectedUiSurface {
  return {
    type: "uiSurface",
    surfaceId: "s1",
    catalogId,
    version: "v0.9",
    revision: 1,
    deleted: false,
    root: { id: "root", type: "Column", children: [] },
    dataModel: { greeting: "hi" },
    ...partial,
  };
}

describe("a2uiDockReducer", () => {
  test("records the first revision and focuses the surface", () => {
    const dock = recordSurfaceRevision(
      createDefaultA2uiDock(),
      makeProjected(),
      "2026-04-17T00:00:00.000Z",
    );
    expect(dock.focusedSurfaceId).toBe("s1");
    expect(dock.revisionsBySurfaceId.s1).toHaveLength(1);
    expect(dock.revisionsBySurfaceId.s1![0]!.revision).toBe(1);
    expect(dock.activeRevisionBySurfaceId.s1).toBe(1);
    expect(dock.lastSeenRevisionBySurfaceId.s1).toBeUndefined();
  });

  test("appending a second revision advances active to the new latest", () => {
    let dock = createDefaultA2uiDock();
    dock = recordSurfaceRevision(dock, makeProjected({ revision: 1 }), "2026-04-17T00:00:00.000Z");
    dock = recordSurfaceRevision(dock, makeProjected({ revision: 2 }), "2026-04-17T00:00:01.000Z");
    expect(dock.revisionsBySurfaceId.s1).toHaveLength(2);
    expect(dock.activeRevisionBySurfaceId.s1).toBe(2);
  });

  test("a repeated revision with the same number is deduped not duplicated", () => {
    let dock = createDefaultA2uiDock();
    dock = recordSurfaceRevision(dock, makeProjected({ revision: 1 }), "2026-04-17T00:00:00.000Z");
    dock = recordSurfaceRevision(dock, makeProjected({ revision: 1 }), "2026-04-17T00:00:00.500Z");
    expect(dock.revisionsBySurfaceId.s1).toHaveLength(1);
  });

  test("respects user scrub-back: new revisions don't yank active forward", () => {
    let dock = createDefaultA2uiDock();
    dock = recordSurfaceRevision(dock, makeProjected({ revision: 1 }), "2026-04-17T00:00:00.000Z");
    dock = recordSurfaceRevision(dock, makeProjected({ revision: 2 }), "2026-04-17T00:00:01.000Z");
    // User scrubs back to revision 1.
    dock = setActiveRevision(dock, "s1", 1);
    dock = recordSurfaceRevision(dock, makeProjected({ revision: 3 }), "2026-04-17T00:00:02.000Z");
    expect(dock.activeRevisionBySurfaceId.s1).toBe(1);
    expect(dock.revisionsBySurfaceId.s1).toHaveLength(3);
  });

  test("caps revision history per surface", () => {
    let dock = createDefaultA2uiDock();
    for (let i = 1; i <= MAX_A2UI_REVISIONS_PER_SURFACE + 5; i++) {
      dock = recordSurfaceRevision(
        dock,
        makeProjected({ revision: i }),
        `2026-04-17T00:00:${String(i).padStart(2, "0")}.000Z`,
      );
    }
    expect(dock.revisionsBySurfaceId.s1).toHaveLength(MAX_A2UI_REVISIONS_PER_SURFACE);
    // Oldest revisions are dropped.
    expect(dock.revisionsBySurfaceId.s1![0]!.revision).toBe(6);
  });

  test("markSurfaceSeen advances but never rewinds the marker", () => {
    let dock: A2uiThreadDock = createDefaultA2uiDock();
    dock = markSurfaceSeen(dock, "s1", 3);
    dock = markSurfaceSeen(dock, "s1", 1);
    expect(dock.lastSeenRevisionBySurfaceId.s1).toBe(3);
  });

  test("setExpanded is idempotent when the flag is unchanged", () => {
    const dock = createDefaultA2uiDock();
    expect(setExpanded(dock, false)).toBe(dock);
    const opened = setExpanded(dock, true);
    expect(opened).not.toBe(dock);
    expect(opened.expanded).toBe(true);
  });

  test("focusSurface is idempotent when focus is unchanged", () => {
    const dock = focusSurface(createDefaultA2uiDock(), "s1");
    expect(focusSurface(dock, "s1")).toBe(dock);
  });

  test("latestRevision returns null when empty and last item otherwise", () => {
    expect(latestRevision([])).toBeNull();
    const revs = recordSurfaceRevision(
      recordSurfaceRevision(
        createDefaultA2uiDock(),
        makeProjected({ revision: 1 }),
        "2026-04-17T00:00:00.000Z",
      ),
      makeProjected({ revision: 2 }),
      "2026-04-17T00:00:01.000Z",
    ).revisionsBySurfaceId.s1!;
    expect(latestRevision(revs)!.revision).toBe(2);
  });

  test("revisionByNumber looks up the right entry", () => {
    const dock = recordSurfaceRevision(
      recordSurfaceRevision(
        createDefaultA2uiDock(),
        makeProjected({ revision: 1 }),
        "2026-04-17T00:00:00.000Z",
      ),
      makeProjected({ revision: 2 }),
      "2026-04-17T00:00:01.000Z",
    );
    expect(revisionByNumber(dock.revisionsBySurfaceId.s1!, 2)!.revision).toBe(2);
    expect(revisionByNumber(dock.revisionsBySurfaceId.s1!, 99)).toBeNull();
  });

  test("coalesces successive revisions that share a toolCallId", () => {
    let dock = createDefaultA2uiDock();
    dock = recordSurfaceRevision(
      dock,
      makeProjected({
        revision: 1,
        toolCallId: "tc1",
        reason: "Render",
        changeKind: "createSurface",
      }),
      "2026-04-17T00:00:00.000Z",
    );
    dock = recordSurfaceRevision(
      dock,
      makeProjected({
        revision: 2,
        toolCallId: "tc1",
        reason: "Render",
        changeKind: "updateComponents",
      }),
      "2026-04-17T00:00:00.010Z",
    );
    dock = recordSurfaceRevision(
      dock,
      makeProjected({
        revision: 3,
        toolCallId: "tc1",
        reason: "Render",
        changeKind: "updateDataModel",
      }),
      "2026-04-17T00:00:00.020Z",
    );
    expect(dock.revisionsBySurfaceId.s1).toHaveLength(1);
    expect(dock.revisionsBySurfaceId.s1![0]!.revision).toBe(3);
    expect(dock.revisionsBySurfaceId.s1![0]!.changeKind).toBe("updateDataModel");
  });

  test("still coalesces revisions from the same toolCallId outside the reason time window", () => {
    let dock = createDefaultA2uiDock();
    dock = recordSurfaceRevision(
      dock,
      makeProjected({
        revision: 1,
        toolCallId: "tc1",
        reason: "Render",
        changeKind: "createSurface",
      }),
      "2026-04-17T00:00:00.000Z",
    );
    dock = recordSurfaceRevision(
      dock,
      makeProjected({
        revision: 2,
        toolCallId: "tc1",
        reason: "Render",
        changeKind: "updateDataModel",
      }),
      "2026-04-17T00:00:05.000Z",
    );
    expect(dock.revisionsBySurfaceId.s1).toHaveLength(1);
    expect(dock.revisionsBySurfaceId.s1![0]!.revision).toBe(2);
  });

  test("does not coalesce revisions from different tool calls", () => {
    let dock = createDefaultA2uiDock();
    dock = recordSurfaceRevision(
      dock,
      makeProjected({ revision: 1, toolCallId: "tc1", changeKind: "createSurface" }),
      "2026-04-17T00:00:00.000Z",
    );
    dock = recordSurfaceRevision(
      dock,
      makeProjected({ revision: 2, toolCallId: "tc2", changeKind: "updateDataModel" }),
      "2026-04-17T00:00:00.050Z",
    );
    expect(dock.revisionsBySurfaceId.s1).toHaveLength(2);
  });

  test("coalesces identical reasons inside the time window when toolCallId is absent", () => {
    let dock = createDefaultA2uiDock();
    dock = recordSurfaceRevision(
      dock,
      makeProjected({ revision: 1, reason: "boost energy", changeKind: "updateDataModel" }),
      "2026-04-17T00:00:00.000Z",
    );
    dock = recordSurfaceRevision(
      dock,
      makeProjected({ revision: 2, reason: "boost energy", changeKind: "updateDataModel" }),
      "2026-04-17T00:00:00.500Z",
    );
    expect(dock.revisionsBySurfaceId.s1).toHaveLength(1);
    expect(dock.revisionsBySurfaceId.s1![0]!.revision).toBe(2);
  });

  test("records reason + changeKind on the revision snapshot", () => {
    const dock = recordSurfaceRevision(
      createDefaultA2uiDock(),
      makeProjected({ revision: 4, reason: "hero rebuild", changeKind: "updateComponents" }),
      "2026-04-17T00:00:00.000Z",
    );
    const rev = dock.revisionsBySurfaceId.s1![0]!;
    expect(rev.reason).toBe("hero rebuild");
    expect(rev.changeKind).toBe("updateComponents");
  });
});
