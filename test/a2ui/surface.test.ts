import { describe, expect, test } from "bun:test";
import { A2UI_BASIC_CATALOG_ID } from "../../src/shared/a2ui/component";
import type { A2uiEnvelope } from "../../src/shared/a2ui/protocol";
import {
  type A2uiSurfaceState,
  type A2uiSurfacesById,
  applyEnvelope,
  createEmptySurfaces,
} from "../../src/shared/a2ui/surface";

const NOW = "2026-01-01T00:00:00.000Z";

function createSurface(surfaceId = "s1"): A2uiEnvelope {
  return {
    version: "v0.9",
    createSurface: {
      surfaceId,
      catalogId: A2UI_BASIC_CATALOG_ID,
      theme: { primaryColor: "#000" },
      root: {
        id: "root",
        type: "Column",
        children: [
          { id: "title", type: "Heading", props: { text: "Hello" } },
          { id: "body", type: "Text", props: { text: { path: "/message" } } },
        ],
      },
      dataModel: { message: "Welcome" },
    },
  };
}

function getSurface(surfaces: A2uiSurfacesById, id: string): A2uiSurfaceState {
  const state = surfaces[id];
  if (!state) throw new Error(`missing surface ${id}`);
  return state;
}

describe("applyEnvelope", () => {
  test("createSurface seeds a new surface", () => {
    const result = applyEnvelope(createEmptySurfaces(), createSurface(), NOW);
    expect(result.change).toBe("created");
    const state = getSurface(result.surfaces, "s1");
    expect(state.catalogId).toBe(A2UI_BASIC_CATALOG_ID);
    expect(state.root?.type).toBe("Column");
    expect(state.dataModel).toEqual({ message: "Welcome" });
    expect(state.revision).toBe(1);
    expect(state.deleted).toBe(false);
  });

  test("createSurface for an existing id reports 'updated'", () => {
    const first = applyEnvelope(createEmptySurfaces(), createSurface(), NOW);
    const second = applyEnvelope(first.surfaces, createSurface(), NOW);
    expect(second.change).toBe("updated");
    expect(getSurface(second.surfaces, "s1").revision).toBe(2);
  });

  test("updateComponents replaces components by id", () => {
    const base = applyEnvelope(createEmptySurfaces(), createSurface(), NOW).surfaces;
    const patched = applyEnvelope(
      base,
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "s1",
          components: [{ id: "title", type: "Heading", props: { text: "Updated" } }],
        },
      },
      NOW,
    );
    expect(patched.change).toBe("updated");
    const state = getSurface(patched.surfaces, "s1");
    const title = state.root?.children?.find((c) => c.id === "title");
    expect(title?.props?.text).toBe("Updated");
    const body = state.root?.children?.find((c) => c.id === "body");
    // Body unchanged
    expect(body?.props).toEqual({ text: { path: "/message" } });
    expect(state.revision).toBe(2);
  });

  test("updateComponents with deleteIds removes nodes", () => {
    const base = applyEnvelope(createEmptySurfaces(), createSurface(), NOW).surfaces;
    const patched = applyEnvelope(
      base,
      {
        version: "v0.9",
        updateComponents: { surfaceId: "s1", deleteIds: ["body"] },
      },
      NOW,
    );
    const state = getSurface(patched.surfaces, "s1");
    expect(state.root?.children?.map((c) => c.id)).toEqual(["title"]);
  });

  test("updateComponents clears the surface root when deleteIds removes the root component", () => {
    const base = applyEnvelope(createEmptySurfaces(), createSurface(), NOW).surfaces;
    const patched = applyEnvelope(
      base,
      {
        version: "v0.9",
        updateComponents: { surfaceId: "s1", deleteIds: ["root"] },
      },
      NOW,
    );
    const state = getSurface(patched.surfaces, "s1");
    expect(state.root).toBeUndefined();
  });

  test("updateDataModel patches a path", () => {
    const base = applyEnvelope(createEmptySurfaces(), createSurface(), NOW).surfaces;
    const patched = applyEnvelope(
      base,
      {
        version: "v0.9",
        updateDataModel: { surfaceId: "s1", path: "/message", value: "Hi there" },
      },
      NOW,
    );
    const state = getSurface(patched.surfaces, "s1");
    expect((state.dataModel as Record<string, unknown>).message).toBe("Hi there");
  });

  test("updateDataModel with delete removes a key", () => {
    const base = applyEnvelope(createEmptySurfaces(), createSurface(), NOW).surfaces;
    const patched = applyEnvelope(
      base,
      {
        version: "v0.9",
        updateDataModel: { surfaceId: "s1", path: "/message", value: null, delete: true },
      },
      NOW,
    );
    const state = getSurface(patched.surfaces, "s1");
    expect(state.dataModel).toEqual({});
  });

  test("deleteSurface marks surface as deleted", () => {
    const base = applyEnvelope(createEmptySurfaces(), createSurface(), NOW).surfaces;
    const removed = applyEnvelope(
      base,
      { version: "v0.9", deleteSurface: { surfaceId: "s1" } },
      NOW,
    );
    expect(removed.change).toBe("deleted");
    expect(getSurface(removed.surfaces, "s1").deleted).toBe(true);
  });

  test("updateComponents on unknown surface is a noop with warning", () => {
    const result = applyEnvelope(
      createEmptySurfaces(),
      {
        version: "v0.9",
        updateComponents: { surfaceId: "nope", deleteIds: ["a"] },
      },
      NOW,
    );
    expect(result.change).toBe("noop");
    expect(result.warning).toContain("nope");
  });

  test("input surfaces map is not mutated", () => {
    const base = applyEnvelope(createEmptySurfaces(), createSurface(), NOW).surfaces;
    const snapshot = structuredClone(base);
    applyEnvelope(
      base,
      {
        version: "v0.9",
        updateDataModel: { surfaceId: "s1", path: "/message", value: "changed" },
      },
      NOW,
    );
    expect(base).toEqual(snapshot);
  });
});
