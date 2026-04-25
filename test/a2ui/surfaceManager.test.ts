import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../../src/server/protocol";
import { A2uiSurfaceManager } from "../../src/server/session/A2uiSurfaceManager";
import type { A2uiEnvelope } from "../../src/shared/a2ui";
import { A2UI_BASIC_CATALOG_ID } from "../../src/shared/a2ui/component";

function createManager() {
  const events: SessionEvent[] = [];
  const logs: string[] = [];
  const manager = new A2uiSurfaceManager({
    sessionId: "sess-1",
    emit: (evt) => events.push(evt),
    log: (line) => logs.push(line),
  });
  return { manager, events, logs };
}

function createEnvelope(surfaceId = "s1", message = "hi"): A2uiEnvelope {
  return {
    version: "v0.9",
    createSurface: {
      surfaceId,
      catalogId: A2UI_BASIC_CATALOG_ID,
      root: { id: "root", type: "Column" },
      dataModel: { message },
    },
  };
}

describe("A2uiSurfaceManager", () => {
  test("emits a resolved a2ui_surface event after createSurface", () => {
    const { manager, events } = createManager();
    const result = manager.applyEnvelope(createEnvelope());
    expect(result.ok).toBe(true);
    expect(result.change).toBe("created");
    expect(events).toHaveLength(1);
    const evt = events[0] as Extract<SessionEvent, { type: "a2ui_surface" }>;
    expect(evt.type).toBe("a2ui_surface");
    expect(evt.surfaceId).toBe("s1");
    expect(evt.revision).toBe(1);
    expect(evt.deleted).toBe(false);
    expect(evt.version).toBe("v0.9");
  });

  test("parses raw JSON strings via applyUnknown", () => {
    const { manager } = createManager();
    const result = manager.applyUnknown(JSON.stringify(createEnvelope()));
    expect(result.ok).toBe(true);
  });

  test("rejects invalid envelopes gracefully", () => {
    const { manager, events } = createManager();
    const result = manager.applyUnknown({ version: "v0.9" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("exactly one");
    expect(events).toHaveLength(0);
  });

  test("sends delete events on reset", () => {
    const { manager, events } = createManager();
    manager.applyEnvelope(createEnvelope("a"));
    manager.applyEnvelope(createEnvelope("b"));
    events.length = 0;
    manager.reset();
    expect(events.every((e) => e.type === "a2ui_surface")).toBe(true);
    expect(events).toHaveLength(2);
    for (const evt of events as Array<Extract<SessionEvent, { type: "a2ui_surface" }>>) {
      expect(evt.deleted).toBe(true);
    }
  });

  test("updates existing surfaces with updateComponents", () => {
    const { manager, events } = createManager();
    manager.applyEnvelope(createEnvelope());
    events.length = 0;
    const res = manager.applyEnvelope({
      version: "v0.9",
      updateComponents: {
        surfaceId: "s1",
        components: [{ id: "root", type: "Row" }],
      },
    });
    expect(res.ok).toBe(true);
    expect(res.change).toBe("updated");
    const evt = events[0] as Extract<SessionEvent, { type: "a2ui_surface" }>;
    expect(evt.revision).toBe(2);
    const rootRecord = evt.root as Record<string, unknown>;
    expect(rootRecord.type).toBe("Row");
  });

  test("reports noop for updates against unknown surfaces", () => {
    const { manager, events } = createManager();
    const res = manager.applyEnvelope({
      version: "v0.9",
      updateComponents: { surfaceId: "ghost", deleteIds: ["x"] },
    });
    expect(res.ok).toBe(false);
    expect(res.change).toBe("noop");
    expect(res.error).toContain("ghost");
    expect(events).toHaveLength(0);
  });

  test("eviction removes the oldest retained surface while still emitting a delete event", () => {
    const { manager, events } = createManager();
    for (let index = 1; index <= 16; index += 1) {
      const result = manager.applyEnvelope(
        createEnvelope(`s${index}`),
        `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      );
      expect(result.ok).toBe(true);
    }

    const result = manager.applyEnvelope(createEnvelope("s17"), "2026-01-01T00:00:17.000Z");

    expect(result.ok).toBe(true);
    expect(Object.keys(manager.getSurfaces())).toHaveLength(16);
    expect(manager.getSurfaces()).not.toHaveProperty("s1");
    expect(manager.getSurfaces()).toHaveProperty("s17");

    const deleteEvent = events.findLast(
      (event) => event.type === "a2ui_surface" && event.surfaceId === "s1",
    );
    expect(deleteEvent).toBeTruthy();
    expect((deleteEvent as Extract<SessionEvent, { type: "a2ui_surface" }>).deleted).toBe(true);
  });

  test("prunes deleted tombstones before creating a new surface at the cap", () => {
    const { manager } = createManager();

    manager.hydrate(
      Object.fromEntries(
        Array.from({ length: 16 }, (_, offset) => {
          const surfaceId = `s${offset + 1}`;
          return [
            surfaceId,
            {
              surfaceId,
              catalogId: A2UI_BASIC_CATALOG_ID,
              revision: 2,
              updatedAt: `2026-01-01T00:00:${String(offset + 1).padStart(2, "0")}.000Z`,
              deleted: true,
            },
          ];
        }),
      ),
    );

    const result = manager.applyEnvelope(createEnvelope("s17"));

    expect(result.ok).toBe(true);
    expect(Object.keys(manager.getSurfaces()).length).toBeLessThanOrEqual(16);
    expect(manager.getSurfaces()).toHaveProperty("s17");
  });

  test("does not evict another surface when updating an existing one at the cap", () => {
    const { manager, events } = createManager();
    for (let index = 1; index <= 16; index += 1) {
      const result = manager.applyEnvelope(
        createEnvelope(`s${index}`),
        `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      );
      expect(result.ok).toBe(true);
    }
    events.length = 0;

    const result = manager.applyEnvelope(
      {
        version: "v0.9",
        updateDataModel: {
          surfaceId: "s16",
          path: "/message",
          value: "updated",
        },
      },
      "2026-01-01T00:01:00.000Z",
    );

    expect(result.ok).toBe(true);
    expect(Object.keys(manager.getSurfaces())).toHaveLength(16);
    expect(manager.getSurfaces()).toHaveProperty("s1");
    expect(manager.getSurfaces()).toHaveProperty("s16");
    expect(
      events.find(
        (event) => event.type === "a2ui_surface" && event.surfaceId === "s1" && event.deleted,
      ),
    ).toBeUndefined();
  });

  test("does not evict another surface before deleting an existing one at the cap", () => {
    const { manager, events } = createManager();
    for (let index = 1; index <= 16; index += 1) {
      const result = manager.applyEnvelope(
        createEnvelope(`s${index}`),
        `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      );
      expect(result.ok).toBe(true);
    }
    events.length = 0;

    const result = manager.applyEnvelope(
      {
        version: "v0.9",
        deleteSurface: {
          surfaceId: "s16",
        },
      },
      "2026-01-01T00:01:00.000Z",
    );

    expect(result.ok).toBe(true);
    expect(Object.keys(manager.getSurfaces())).toHaveLength(16);
    expect(manager.getSurfaces()).toHaveProperty("s1");
    expect(manager.getSurfaces().s16?.deleted).toBe(true);
    expect(
      events.find(
        (event) => event.type === "a2ui_surface" && event.surfaceId === "s1" && event.deleted,
      ),
    ).toBeUndefined();
  });

  test("keeps the previous surface when an oversized update is rejected", () => {
    const { manager, events } = createManager();
    manager.applyEnvelope(createEnvelope("s1"));
    events.length = 0;

    const result = manager.applyEnvelope(
      {
        version: "v0.9",
        updateDataModel: {
          surfaceId: "s1",
          path: "/message",
          value: "x".repeat(300_000),
        },
      },
      "2026-01-01T00:01:00.000Z",
    );

    expect(result.ok).toBe(false);
    expect(manager.getSurfaces().s1?.revision).toBe(1);
    expect((manager.getSurfaces().s1?.dataModel as { message: string }).message).toBe("hi");
    expect(manager.validateAction({ surfaceId: "s1", componentId: "root" }).ok).toBe(true);
    expect(events).toHaveLength(0);
  });

  test("does not evict another surface when an oversized create is rejected at the cap", () => {
    const { manager, events } = createManager();
    for (let index = 1; index <= 16; index += 1) {
      const result = manager.applyEnvelope(
        createEnvelope(`s${index}`),
        `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      );
      expect(result.ok).toBe(true);
    }
    events.length = 0;

    const result = manager.applyEnvelope(
      createEnvelope("s17", "x".repeat(300_000)),
      "2026-01-01T00:01:00.000Z",
    );

    expect(result.ok).toBe(false);
    expect(Object.keys(manager.getSurfaces())).toHaveLength(16);
    expect(manager.getSurfaces()).toHaveProperty("s1");
    expect(manager.getSurfaces()).not.toHaveProperty("s17");
    expect(
      events.find(
        (event) => event.type === "a2ui_surface" && event.surfaceId === "s1" && event.deleted,
      ),
    ).toBeUndefined();
  });
});
