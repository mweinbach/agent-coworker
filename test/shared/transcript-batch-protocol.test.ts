import { describe, expect, test } from "bun:test";

import {
  measureTranscriptBatchBudgetBytes,
  measureTranscriptEventsBytes,
  measureTranscriptRequestBytes,
  TRANSCRIPT_EVENTS_MAX_BYTES,
  TRANSCRIPT_REQUEST_BODY_MAX_BYTES,
  TRANSCRIPT_REQUEST_ENVELOPE_RESERVE_BYTES,
  TRANSCRIPT_REQUEST_MAX_EVENTS,
  transcriptBatchFitsRequestLimits,
} from "../../src/shared/transcriptBatchProtocol";

describe("transcript batch request limits", () => {
  test("rejects empty batches and event-count overflow", () => {
    expect(transcriptBatchFitsRequestLimits("batch-1", [])).toBe(false);
    expect(
      transcriptBatchFitsRequestLimits(
        "batch-1",
        Array.from({ length: TRANSCRIPT_REQUEST_MAX_EVENTS }, (_, index) => ({ index })),
      ),
    ).toBe(true);
    expect(
      transcriptBatchFitsRequestLimits(
        "batch-1",
        Array.from({ length: TRANSCRIPT_REQUEST_MAX_EVENTS + 1 }, (_, index) => ({ index })),
      ),
    ).toBe(false);
  });

  test("fails closed when events fit but the envelope exceeds the body cap", () => {
    const events = [{ type: "item/completed", id: "small" }];
    expect(measureTranscriptEventsBytes(events)).toBeLessThan(TRANSCRIPT_EVENTS_MAX_BYTES);
    expect(transcriptBatchFitsRequestLimits("batch-1", events)).toBe(true);

    const oversizedBatchId = "b".repeat(
      TRANSCRIPT_REQUEST_BODY_MAX_BYTES - measureTranscriptEventsBytes(events),
    );
    expect(measureTranscriptEventsBytes(events)).toBeLessThanOrEqual(TRANSCRIPT_EVENTS_MAX_BYTES);
    expect(measureTranscriptRequestBytes(oversizedBatchId, events)).toBeGreaterThan(
      TRANSCRIPT_REQUEST_BODY_MAX_BYTES,
    );
    expect(transcriptBatchFitsRequestLimits(oversizedBatchId, events)).toBe(false);
  });

  test("budget uses the larger of request bytes and events plus envelope reserve", () => {
    const events = [{ type: "item/started", id: "n1" }];
    const smallBatchId = "batch-1";
    const eventsBytes = measureTranscriptEventsBytes(events);
    const smallRequestBytes = measureTranscriptRequestBytes(smallBatchId, events);
    expect(smallRequestBytes).toBeLessThan(eventsBytes + TRANSCRIPT_REQUEST_ENVELOPE_RESERVE_BYTES);
    expect(measureTranscriptBatchBudgetBytes(smallBatchId, events)).toBe(
      eventsBytes + TRANSCRIPT_REQUEST_ENVELOPE_RESERVE_BYTES,
    );

    const largeBatchId = "n".repeat(20_000);
    const largeRequestBytes = measureTranscriptRequestBytes(largeBatchId, events);
    expect(largeRequestBytes).toBeGreaterThan(
      eventsBytes + TRANSCRIPT_REQUEST_ENVELOPE_RESERVE_BYTES,
    );
    expect(measureTranscriptBatchBudgetBytes(largeBatchId, events)).toBe(largeRequestBytes);
  });
});
