import { describe, expect, test } from "bun:test";

import {
  applyProjectedCompletion,
  applyProjectedStart,
  createMobileFeedState,
} from "../../apps/mobile/src/features/cowork/snapshotReducer";

describe("mobile snapshotReducer ui_surface integration (Phase 3)", () => {
  test("upserts a ui_surface feed item from a uiSurface projected item", () => {
    let state = createMobileFeedState();
    const now = "2026-03-01T00:00:00.000Z";
    state = applyProjectedStart(
      state,
      {
        id: "uiSurface:s1",
        type: "uiSurface",
        surfaceId: "s1",
        catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json",
        version: "v0.9",
        revision: 1,
        deleted: false,
        root: { id: "root", type: "Column" },
      } as never,
      now,
      1,
    );
    state = applyProjectedCompletion(
      state,
      {
        id: "uiSurface:s1",
        type: "uiSurface",
        surfaceId: "s1",
        catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json",
        version: "v0.9",
        revision: 2,
        deleted: false,
        root: { id: "root", type: "Column" },
        dataModel: { message: "hi" },
      } as never,
      now,
      2,
    );
    expect(state.feed).toHaveLength(1);
    const item = state.feed[0]!;
    expect(item.kind).toBe("ui_surface");
    if (item.kind === "ui_surface") {
      expect(item.surfaceId).toBe("s1");
      expect(item.revision).toBe(2);
      expect(item.dataModel).toEqual({ message: "hi" });
    }
  });

  test("a subsequent completion with deleted=true updates the item in place", () => {
    let state = createMobileFeedState();
    const now = "2026-03-01T00:00:00.000Z";
    state = applyProjectedStart(
      state,
      {
        id: "uiSurface:s1",
        type: "uiSurface",
        surfaceId: "s1",
        catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json",
        version: "v0.9",
        revision: 1,
        deleted: false,
      } as never,
      now,
      1,
    );
    state = applyProjectedCompletion(
      state,
      {
        id: "uiSurface:s1",
        type: "uiSurface",
        surfaceId: "s1",
        catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json",
        version: "v0.9",
        revision: 2,
        deleted: true,
      } as never,
      now,
      2,
    );
    expect(state.feed).toHaveLength(1);
    const item = state.feed[0]!;
    expect(item.kind).toBe("ui_surface");
    if (item.kind === "ui_surface") {
      expect(item.deleted).toBe(true);
    }
  });
});
