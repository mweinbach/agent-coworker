import { describe, expect, test } from "bun:test";

import { selectDockView, __internal } from "../src/ui/chat/a2ui/A2uiSurfaceDock";
import { recordSurfaceRevision, type ProjectedUiSurface } from "../src/app/a2uiDockReducer";
import { createDefaultA2uiDock } from "../src/app/types";

const catalogId = "https://a2ui.org/specification/v0_9/basic_catalog.json";

function project(partial: Partial<ProjectedUiSurface> = {}): ProjectedUiSurface {
  return {
    type: "uiSurface",
    surfaceId: "s1",
    catalogId,
    version: "v0.9",
    revision: 1,
    deleted: false,
    root: {
      id: "root",
      type: "Column",
      children: [{ id: "h", type: "Heading", props: { text: "A2UI Demo Lab", level: 1 } }],
    },
    dataModel: {},
    ...partial,
  };
}

describe("selectDockView", () => {
  test("returns null when no surface has been focused", () => {
    expect(selectDockView(createDefaultA2uiDock())).toBeNull();
  });

  test("picks the active revision, extracts title, and flags unseen when the last-seen marker is behind", () => {
    let dock = createDefaultA2uiDock();
    dock = recordSurfaceRevision(dock, project({ revision: 1 }), "2026-04-17T00:00:00.000Z");
    dock = recordSurfaceRevision(dock, project({ revision: 2 }), "2026-04-17T00:00:01.000Z");
    const view = selectDockView(dock);
    expect(view).not.toBeNull();
    expect(view!.title).toBe("A2UI Demo Lab");
    expect(view!.activeRevision.revision).toBe(2);
    expect(view!.activeIndex).toBe(1);
    expect(view!.hasUnseen).toBe(true);
  });

  test("does not flag unseen for a deleted latest revision", () => {
    let dock = createDefaultA2uiDock();
    dock = recordSurfaceRevision(dock, project({ revision: 1 }), "2026-04-17T00:00:00.000Z");
    dock = recordSurfaceRevision(dock, project({ revision: 2, deleted: true, root: undefined, dataModel: undefined }), "2026-04-17T00:00:01.000Z");
    const view = selectDockView(dock)!;
    expect(view.activeRevision.deleted).toBe(true);
    expect(view.hasUnseen).toBe(false);
  });

  test("falls back to surfaceId when there's no extractable title", () => {
    let dock = createDefaultA2uiDock();
    dock = recordSurfaceRevision(
      dock,
      project({ root: { id: "root", type: "Column", children: [] } }),
      "2026-04-17T00:00:00.000Z",
    );
    const view = selectDockView(dock)!;
    expect(view.title).toBe("s1");
  });
});

describe("formatRelativeAge", () => {
  const { formatRelativeAge } = __internal;
  const now = Date.parse("2026-04-17T00:10:00.000Z");

  test("returns 'just now' for very fresh timestamps", () => {
    expect(formatRelativeAge(now, "2026-04-17T00:09:58.000Z")).toBe("just now");
  });

  test("uses seconds/minutes/hours/days buckets", () => {
    expect(formatRelativeAge(now, "2026-04-17T00:09:30.000Z")).toBe("30s ago");
    expect(formatRelativeAge(now, "2026-04-17T00:05:00.000Z")).toBe("5m ago");
    expect(formatRelativeAge(now, "2026-04-16T22:10:00.000Z")).toBe("2h ago");
    expect(formatRelativeAge(now, "2026-04-14T00:10:00.000Z")).toBe("3d ago");
  });

  test("returns empty string for invalid timestamps", () => {
    expect(formatRelativeAge(now, "not-a-date")).toBe("");
  });
});
