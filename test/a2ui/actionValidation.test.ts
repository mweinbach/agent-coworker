import { describe, expect, test } from "bun:test";
import { formatA2uiActionDeliveryText } from "../../src/server/jsonrpc/schema.a2ui";
import type { SessionEvent } from "../../src/server/protocol";
import { A2uiSurfaceManager } from "../../src/server/session/A2uiSurfaceManager";
import type { A2uiEnvelope } from "../../src/shared/a2ui";
import { A2UI_BASIC_CATALOG_ID } from "../../src/shared/a2ui/component";

function seededManager() {
  const events: SessionEvent[] = [];
  const manager = new A2uiSurfaceManager({ sessionId: "sess", emit: (e) => events.push(e) });

  const envelope: A2uiEnvelope = {
    version: "v0.9",
    createSurface: {
      surfaceId: "s1",
      catalogId: A2UI_BASIC_CATALOG_ID,
      root: {
        id: "root",
        type: "Column",
        children: [
          { id: "buy", type: "Button", props: { text: "Buy" } },
          { id: "qty", type: "TextField", props: { label: "Qty" } },
        ],
      },
    },
  };
  manager.applyEnvelope(envelope);
  events.length = 0;
  return { manager, events };
}

describe("A2uiSurfaceManager.validateAction", () => {
  test("accepts a real component id on an active surface", () => {
    const { manager } = seededManager();
    const outcome = manager.validateAction({ surfaceId: "s1", componentId: "buy" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.componentType).toBe("Button");
  });

  test("rejects unknown surface with code unknown_surface", () => {
    const { manager } = seededManager();
    const outcome = manager.validateAction({ surfaceId: "ghost", componentId: "buy" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("unknown_surface");
  });

  test("rejects unknown component with code unknown_component", () => {
    const { manager } = seededManager();
    const outcome = manager.validateAction({ surfaceId: "s1", componentId: "nope" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("unknown_component");
  });

  test("rejects deleted surface with code surface_deleted", () => {
    const { manager } = seededManager();
    manager.applyEnvelope({ version: "v0.9", deleteSurface: { surfaceId: "s1" } });
    const outcome = manager.validateAction({ surfaceId: "s1", componentId: "buy" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("surface_deleted");
  });
});

describe("formatA2uiActionDeliveryText", () => {
  test("includes surface/component/event and optional payload", () => {
    const text = formatA2uiActionDeliveryText({
      surfaceId: "s1",
      componentId: "buy",
      eventType: "click",
      payload: { count: 3 },
    });
    expect(text).toContain('surface "s1"');
    expect(text).toContain("component: buy");
    expect(text).toContain("event: click");
    expect(text).toContain('"count":3');
  });

  test("omits payload line when empty", () => {
    const text = formatA2uiActionDeliveryText({
      surfaceId: "s1",
      componentId: "buy",
      eventType: "click",
    });
    expect(text).not.toContain("payload:");
  });
});
