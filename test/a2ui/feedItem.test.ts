import { describe, expect, test } from "bun:test";
import { type ProjectedItem, projectedItemSchema } from "../../src/shared/projectedItems";
import { type SessionFeedItem, sessionFeedItemSchema } from "../../src/shared/sessionSnapshot";

describe("SessionFeedItem ui_surface variant", () => {
  test("parses a valid ui_surface feed item", () => {
    const item: SessionFeedItem = {
      id: "ui-s1",
      kind: "ui_surface",
      ts: "2026-01-01T00:00:00.000Z",
      surfaceId: "s1",
      catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json",
      version: "v0.9",
      revision: 2,
      deleted: false,
      theme: { primaryColor: "#000" },
      root: { id: "root", type: "Column" },
      dataModel: { message: "hello" },
    };
    const parsed = sessionFeedItemSchema.safeParse(item);
    expect(parsed.success).toBe(true);
  });

  test("rejects missing required fields", () => {
    const bad = {
      id: "ui-s1",
      kind: "ui_surface",
      ts: "2026-01-01T00:00:00.000Z",
      surfaceId: "",
      catalogId: "",
      version: "v0.9",
      revision: 0,
      deleted: false,
    };
    const parsed = sessionFeedItemSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });
});

describe("ProjectedItem uiSurface variant", () => {
  test("parses a valid uiSurface projection", () => {
    const item: ProjectedItem = {
      id: "ui-s1",
      type: "uiSurface",
      surfaceId: "s1",
      catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json",
      version: "v0.9",
      revision: 1,
      deleted: false,
      root: { id: "root", type: "Column" },
    };
    expect(projectedItemSchema.safeParse(item).success).toBe(true);
  });
});
