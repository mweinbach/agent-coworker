import { describe, expect, test } from "bun:test";
import { isInvalidGoogleContinuationError } from "../../src/shared/providerContinuation";

describe("google continuation error detection", () => {
  test("requires an interaction-id-specific Google error before retrying continuation", () => {
    expect(
      isInvalidGoogleContinuationError(
        new Error("INVALID_ARGUMENT: previous_interaction_id interaction_id not found"),
      ),
    ).toBe(true);
    expect(isInvalidGoogleContinuationError(new Error("invalid_request: tool schema failed"))).toBe(
      false,
    );
    expect(isInvalidGoogleContinuationError(new Error("INVALID_ARGUMENT: bad attachment"))).toBe(
      false,
    );
  });
});
