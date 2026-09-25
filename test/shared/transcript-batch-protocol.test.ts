import { describe, expect, test } from "bun:test";

import {
  measureUtf8Bytes,
  TRANSCRIPT_EVENTS_MAX_BYTES,
  TRANSCRIPT_REQUEST_MAX_EVENTS,
  transcriptBatchFitsRequestLimits,
} from "../../src/shared/transcriptBatchProtocol";

describe("transcriptBatchFitsRequestLimits", () => {
  test("rejects empty batches and more than the event cap", () => {
    expect(transcriptBatchFitsRequestLimits("batch-1", [])).toBe(false);
    expect(
      transcriptBatchFitsRequestLimits(
        "batch-1",
        Array.from({ length: TRANSCRIPT_REQUEST_MAX_EVENTS + 1 }, (_, index) => ({ index })),
      ),
    ).toBe(false);
  });

  test("accepts a non-empty batch under the event and byte caps", () => {
    expect(transcriptBatchFitsRequestLimits("batch-1", [{ type: "item", text: "hello" }])).toBe(
      true,
    );
    expect(
      transcriptBatchFitsRequestLimits(
        "batch-1",
        Array.from({ length: TRANSCRIPT_REQUEST_MAX_EVENTS }, (_, index) => ({ index })),
      ),
    ).toBe(true);
  });

  test("rejects an events payload that exceeds the UTF-8 byte cap", () => {
    expect(
      transcriptBatchFitsRequestLimits("batch-1", ["x".repeat(TRANSCRIPT_EVENTS_MAX_BYTES)]),
    ).toBe(false);
  });
});

describe("measureUtf8Bytes", () => {
  test("counts multi-byte characters by UTF-8 size, not string length", () => {
    expect(measureUtf8Bytes("a")).toBe(1);
    expect(measureUtf8Bytes("é")).toBe(2);
    expect(measureUtf8Bytes("🧠")).toBe(4);
  });
});
