import { describe, expect, test } from "bun:test";
import {
  measureUtf8Bytes,
  TRANSCRIPT_EVENTS_MAX_BYTES,
  TRANSCRIPT_REQUEST_MAX_EVENTS,
  transcriptBatchFitsRequestLimits,
} from "../../src/shared/transcriptBatchProtocol";

describe("transcriptBatchProtocol", () => {
  test("enforces non-empty event count and UTF-8 byte caps", () => {
    expect(transcriptBatchFitsRequestLimits("batch-1", [])).toBe(false);
    expect(
      transcriptBatchFitsRequestLimits(
        "batch-1",
        Array.from({ length: TRANSCRIPT_REQUEST_MAX_EVENTS + 1 }, (_, index) => ({ index })),
      ),
    ).toBe(false);
    expect(transcriptBatchFitsRequestLimits("batch-1", [{ type: "item", text: "hello" }])).toBe(
      true,
    );
    expect(
      transcriptBatchFitsRequestLimits(
        "batch-1",
        Array.from({ length: TRANSCRIPT_REQUEST_MAX_EVENTS }, (_, index) => ({ index })),
      ),
    ).toBe(true);
    expect(
      transcriptBatchFitsRequestLimits("batch-1", ["x".repeat(TRANSCRIPT_EVENTS_MAX_BYTES)]),
    ).toBe(false);
  });

  test("counts multi-byte characters by UTF-8 size, not string length", () => {
    expect(measureUtf8Bytes("a")).toBe(1);
    expect(measureUtf8Bytes("\u00e9")).toBe(2);
    expect(measureUtf8Bytes("\ud83e\udde0")).toBe(4);
  });
});
