import { describe, expect, test } from "bun:test";
import { normalizeGoogleStreamEvent } from "../../../src/runtime/googleNative/stream/normalize";

describe("normalizeGoogleStreamEvent", () => {
  test("aliases interaction lifecycle events", () => {
    for (const [eventType, kind] of [
      ["interaction.start", "interaction_start"],
      ["interaction.created", "interaction_start"],
      ["interaction.complete", "interaction_complete"],
      ["interaction.completed", "interaction_complete"],
      ["interaction.status_update", "interaction_status"],
      ["error", "error"],
    ] as const) {
      expect(normalizeGoogleStreamEvent({ event_type: eventType })).toEqual({ kind, eventType });
    }
  });

  test("maps content and step variants and prefers record-shaped payloads", () => {
    expect(
      normalizeGoogleStreamEvent({
        event_type: "content.delta",
        index: 2,
        content: { type: "text", text: "hi" },
        delta: { type: "text", text: "!" },
      }),
    ).toEqual({
      kind: "content",
      eventType: "content.delta",
      index: 2,
      content: { type: "text", text: "hi" },
      delta: { type: "text", text: "!" },
    });

    expect(
      normalizeGoogleStreamEvent({
        event_type: "step.start",
        step: { type: "model_output" },
        delta: "not-a-record",
      }),
    ).toEqual({
      kind: "content",
      eventType: "step.start",
      content: { type: "model_output" },
      delta: null,
    });

    for (const eventType of ["content.stop", "step.delta", "step.stop", "content.start"] as const) {
      expect(normalizeGoogleStreamEvent({ event_type: eventType })).toEqual({
        kind: "content",
        eventType,
        content: null,
        delta: null,
      });
    }
  });

  test("treats missing, blank, and unknown event types as unknown", () => {
    for (const [raw, eventType] of [
      [{}, "unknown"],
      [{ event_type: "   " }, "unknown"],
      [{ event_type: "interaction.started" }, "interaction.started"],
      [{ event_type: 12 }, "unknown"],
    ] as const) {
      expect(normalizeGoogleStreamEvent(raw)).toEqual({ kind: "unknown", eventType });
    }
  });

  test("does not treat non-number index values as stream indexes", () => {
    expect(
      normalizeGoogleStreamEvent({
        event_type: "content.start",
        index: "0",
        content: { type: "text" },
      }),
    ).toEqual({
      kind: "content",
      eventType: "content.start",
      content: { type: "text" },
      delta: null,
    });
  });
});
