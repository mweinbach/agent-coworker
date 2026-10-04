import { describe, expect, test } from "bun:test";

import { normalizeGoogleStreamEvent } from "../../../src/runtime/googleNative/stream/normalize";

describe("normalizeGoogleStreamEvent", () => {
  test("aliases interaction lifecycle events", () => {
    expect(normalizeGoogleStreamEvent({ event_type: "interaction.start" })).toEqual({
      kind: "interaction_start",
      eventType: "interaction.start",
    });
    expect(normalizeGoogleStreamEvent({ event_type: "interaction.created" })).toEqual({
      kind: "interaction_start",
      eventType: "interaction.created",
    });
    expect(normalizeGoogleStreamEvent({ event_type: "interaction.complete" })).toEqual({
      kind: "interaction_complete",
      eventType: "interaction.complete",
    });
    expect(normalizeGoogleStreamEvent({ event_type: "interaction.completed" })).toEqual({
      kind: "interaction_complete",
      eventType: "interaction.completed",
    });
    expect(normalizeGoogleStreamEvent({ event_type: "interaction.status_update" })).toEqual({
      kind: "interaction_status",
      eventType: "interaction.status_update",
    });
    expect(normalizeGoogleStreamEvent({ event_type: "error" })).toEqual({
      kind: "error",
      eventType: "error",
    });
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

    expect(normalizeGoogleStreamEvent({ event_type: "content.stop" })).toEqual({
      kind: "content",
      eventType: "content.stop",
      content: null,
      delta: null,
    });
    expect(normalizeGoogleStreamEvent({ event_type: "step.delta" })).toMatchObject({
      kind: "content",
      eventType: "step.delta",
    });
    expect(normalizeGoogleStreamEvent({ event_type: "step.stop" })).toMatchObject({
      kind: "content",
      eventType: "step.stop",
    });
    expect(normalizeGoogleStreamEvent({ event_type: "content.start" })).toMatchObject({
      kind: "content",
      eventType: "content.start",
    });
  });

  test("treats missing, blank, and unknown event types as unknown", () => {
    expect(normalizeGoogleStreamEvent({})).toEqual({ kind: "unknown", eventType: "unknown" });
    expect(normalizeGoogleStreamEvent({ event_type: "   " })).toEqual({
      kind: "unknown",
      eventType: "unknown",
    });
    expect(normalizeGoogleStreamEvent({ event_type: "interaction.started" })).toEqual({
      kind: "unknown",
      eventType: "interaction.started",
    });
    expect(normalizeGoogleStreamEvent({ event_type: 12 })).toEqual({
      kind: "unknown",
      eventType: "unknown",
    });
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
