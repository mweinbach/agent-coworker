import { describe, test, expect } from "bun:test";

import { A2uiSurfaceManager } from "../../src/server/session/A2uiSurfaceManager";
import type { ServerEvent } from "../../src/server/protocol";
import { A2UI_BASIC_CATALOG_ID } from "../../src/shared/a2ui/component";
import type { A2uiEnvelope } from "../../src/shared/a2ui";

function createManager() {
  const events: ServerEvent[] = [];
  const logs: string[] = [];
  const manager = new A2uiSurfaceManager({
    sessionId: "sess-1",
    emit: (evt) => events.push(evt),
    log: (line) => logs.push(line),
  });
  return { manager, events, logs };
}

function createEnvelope(surfaceId = "s1"): A2uiEnvelope {
  return {
    version: "v0.9",
    createSurface: {
      surfaceId,
      catalogId: A2UI_BASIC_CATALOG_ID,
      root: { id: "root", type: "Column" },
      dataModel: { message: "hi" },
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
    const evt = events[0] as Extract<ServerEvent, { type: "a2ui_surface" }>;
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
    for (const evt of events as Array<Extract<ServerEvent, { type: "a2ui_surface" }>>) {
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
    const evt = events[0] as Extract<ServerEvent, { type: "a2ui_surface" }>;
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
      const result = manager.applyEnvelope(createEnvelope(`s${index}`), `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`);
      expect(result.ok).toBe(true);
    }

    const result = manager.applyEnvelope(createEnvelope("s17"), "2026-01-01T00:00:17.000Z");

    expect(result.ok).toBe(true);
    expect(Object.keys(manager.getSurfaces())).toHaveLength(16);
    expect(manager.getSurfaces()).not.toHaveProperty("s1");
    expect(manager.getSurfaces()).toHaveProperty("s17");

    const deleteEvent = events.findLast((event) => event.type === "a2ui_surface" && event.surfaceId === "s1");
    expect(deleteEvent).toBeTruthy();
    expect((deleteEvent as Extract<ServerEvent, { type: "a2ui_surface" }>).deleted).toBe(true);
  });
});
