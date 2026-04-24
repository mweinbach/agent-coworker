import { describe, expect, test } from "bun:test";

import { createConversationProjection } from "../../src/server/projection/conversationProjection";
import type { ProjectedItem } from "../../src/shared/projectedItems";

function createProjection() {
  const started: Array<[string | null, ProjectedItem]> = [];
  const completed: Array<[string | null, ProjectedItem]> = [];
  const projection = createConversationProjection({
    sink: {
      emitTurnStarted: () => {},
      emitTurnCompleted: () => {},
      emitItemStarted: (turnId, item) => started.push([turnId, item]),
      emitReasoningDelta: () => {},
      emitAgentMessageDelta: () => {},
      emitItemCompleted: (turnId, item) => completed.push([turnId, item]),
    },
  });
  return { projection, started, completed };
}

describe("conversationProjection a2ui_surface", () => {
  test("emits a uiSurface ProjectedItem keyed by surfaceId and revision", () => {
    const { projection, started, completed } = createProjection();
    projection.handle({
      type: "a2ui_surface",
      sessionId: "sess",
      surfaceId: "s1",
      catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json",
      version: "v0.9",
      revision: 1,
      deleted: false,
      root: { id: "root", type: "Column" },
      dataModel: { message: "hi" },
      updatedAt: "2026-01-01T00:00:00.000Z",
      changeKind: "createSurface",
      reason: "initial render",
    });

    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    const [turnId, item] = started[0]!;
    expect(turnId).toBeNull();
    if (item.type !== "uiSurface") throw new Error(`expected uiSurface, got ${item.type}`);
    expect(item.surfaceId).toBe("s1");
    expect(item.revision).toBe(1);
    expect(item.deleted).toBe(false);
    expect(item.changeKind).toBe("createSurface");
    expect(item.reason).toBe("initial render");
    // Stable id per (surfaceId, revision) — enables per-revision history rows.
    expect(item.id).toContain("s1");
    expect(item.id).toContain("1");
  });

  test("subsequent revisions produce distinct projected item ids", () => {
    const { projection, started } = createProjection();
    const baseEvent = {
      type: "a2ui_surface" as const,
      sessionId: "sess",
      surfaceId: "s1",
      catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json",
      version: "v0.9" as const,
      deleted: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    projection.handle({ ...baseEvent, revision: 1 });
    projection.handle({ ...baseEvent, revision: 2 });
    projection.handle({ ...baseEvent, revision: 3, deleted: true });
    const ids = started.map(([, item]) => item.id);
    expect(new Set(ids).size).toBe(3);
  });
});
