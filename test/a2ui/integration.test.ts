import { describe, expect, test } from "bun:test";
import { createConversationProjection } from "../../src/server/projection/conversationProjection";
import type { SessionEvent } from "../../src/server/protocol";
import { A2uiSurfaceManager } from "../../src/server/session/A2uiSurfaceManager";
import type { ProjectedItem } from "../../src/shared/projectedItems";
import {
  applyProjectedItemCompleted,
  applyProjectedItemStarted,
} from "../../src/shared/projectedItems";
import type { SessionFeedItem } from "../../src/shared/sessionSnapshot";
import { createA2uiTool } from "../../src/tools/a2ui";
import type { ToolContext } from "../../src/tools/context";
import type { AgentConfig } from "../../src/types";

/**
 * Drives the full A2UI path that the harness wires up in production:
 *   agent → a2ui tool → ToolContext.applyA2uiEnvelope → A2uiSurfaceManager →
 *     SessionEvent "a2ui_surface" → conversationProjection → uiSurface ProjectedItem →
 *     session feed (SessionFeedItem.kind === "ui_surface")
 *
 * Any one of those hops being broken would show up in this test.
 */
describe("A2UI end-to-end (manager → projection → feed)", () => {
  test("rendering a surface through the tool lands a ui_surface feed item", async () => {
    const events: SessionEvent[] = [];
    const manager = new A2uiSurfaceManager({
      sessionId: "sess-1",
      emit: (evt) => events.push(evt),
    });

    let feed: SessionFeedItem[] = [];
    const projection = createConversationProjection({
      sink: {
        emitTurnStarted: () => {},
        emitTurnCompleted: () => {},
        emitItemStarted: (_turnId, item: ProjectedItem) => {
          feed = applyProjectedItemStarted(feed, item, "2026-01-01T00:00:00.000Z");
        },
        emitReasoningDelta: () => {},
        emitAgentMessageDelta: () => {},
        emitItemCompleted: (_turnId, item: ProjectedItem) => {
          feed = applyProjectedItemCompleted(feed, item, "2026-01-01T00:00:00.000Z");
        },
      },
    });

    const ctx: ToolContext = {
      config: {
        provider: "google",
        model: "gemini-3-flash-preview",
        workingDirectory: "/tmp",
        enableA2ui: true,
      } as unknown as AgentConfig,
      log: () => {},
      askUser: async () => "",
      approveCommand: async () => true,
      applyA2uiEnvelope: (envelope) => manager.applyUnknown(envelope),
    };

    const tool = createA2uiTool(ctx);

    await tool.execute({
      envelopes: [
        {
          version: "v0.9",
          createSurface: {
            surfaceId: "greeter",
            catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json",
            root: {
              id: "root",
              type: "Column",
              children: [{ id: "title", type: "Heading", props: { text: "Hello" } }],
            },
            dataModel: { message: "Welcome" },
          },
        },
      ],
    });

    // Server event should fire exactly once
    expect(events).toHaveLength(1);
    const evt = events[0] as Extract<SessionEvent, { type: "a2ui_surface" }>;
    expect(evt.type).toBe("a2ui_surface");

    // Feed the event into the projection the way the live server does
    projection.handle(evt);

    const surfaceItems = feed.filter((item) => item.kind === "ui_surface");
    expect(surfaceItems).toHaveLength(1);
    const surfaceItem = surfaceItems[0]! as Extract<SessionFeedItem, { kind: "ui_surface" }>;
    expect(surfaceItem.surfaceId).toBe("greeter");
    expect(surfaceItem.revision).toBe(1);
    expect(surfaceItem.deleted).toBe(false);

    // Each revision now appends a new feed item so the transcript shows the
    // full update history (clients coalesce at render time).
    await tool.execute({
      envelopes: [
        {
          version: "v0.9",
          updateDataModel: { surfaceId: "greeter", path: "/message", value: "Hi there" },
        },
      ],
    });
    projection.handle(events.at(-1)!);

    const surfaces = feed.filter((item) => item.kind === "ui_surface");
    expect(surfaces).toHaveLength(2);
    const updated = surfaces[surfaces.length - 1]! as Extract<
      SessionFeedItem,
      { kind: "ui_surface" }
    >;
    expect(updated.revision).toBe(2);
    expect((updated.dataModel as Record<string, unknown>).message).toBe("Hi there");

    // deleteSurface also appends — it becomes a tombstone in the transcript.
    await tool.execute({
      envelopes: [{ version: "v0.9", deleteSurface: { surfaceId: "greeter" } }],
    });
    projection.handle(events.at(-1)!);

    const finalSurfaces = feed.filter((item) => item.kind === "ui_surface");
    expect(finalSurfaces).toHaveLength(3);
    const tombstone = finalSurfaces[finalSurfaces.length - 1]! as Extract<
      SessionFeedItem,
      { kind: "ui_surface" }
    >;
    expect(tombstone.deleted).toBe(true);
  });
});
