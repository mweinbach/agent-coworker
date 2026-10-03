import { describe, expect, test } from "bun:test";

import { isInvalidProviderManagedContinuationError } from "../../src/server/session/turnExecution/continuationPolicy";

describe("isInvalidProviderManagedContinuationError", () => {
  test("openai requires a previous-response mention plus an invalidity token", () => {
    expect(
      isInvalidProviderManagedContinuationError(
        "openai",
        new Error("previous_response_id abc not found"),
      ),
    ).toBe(true);
    expect(
      isInvalidProviderManagedContinuationError("openai", "Previous response has expired"),
    ).toBe(true);
    expect(isInvalidProviderManagedContinuationError("openai", "response_id is invalid")).toBe(
      true,
    );
    expect(
      isInvalidProviderManagedContinuationError("openai", "previous_response_id is unavailable"),
    ).toBe(false);
    expect(isInvalidProviderManagedContinuationError("openai", "not found")).toBe(false);
  });

  test("google and codex-cli classify stale continuation handles; other providers stay false", () => {
    expect(
      isInvalidProviderManagedContinuationError(
        "google",
        new Error("previous_interaction_id does not exist"),
      ),
    ).toBe(true);
    expect(
      isInvalidProviderManagedContinuationError("google", "interaction id is invalid_argument"),
    ).toBe(true);
    expect(isInvalidProviderManagedContinuationError("google", "interaction_id missing")).toBe(
      false,
    );

    expect(isInvalidProviderManagedContinuationError("codex-cli", "thread_id xyz not found")).toBe(
      true,
    );
    expect(isInvalidProviderManagedContinuationError("codex-cli", "thread has expired")).toBe(true);
    expect(isInvalidProviderManagedContinuationError("codex-cli", "thread is busy")).toBe(false);

    expect(
      isInvalidProviderManagedContinuationError(
        "anthropic",
        new Error("previous_response_id not found"),
      ),
    ).toBe(false);
    expect(
      isInvalidProviderManagedContinuationError(
        "openai",
        new Error("previous_interaction_id not found"),
      ),
    ).toBe(false);
  });
});
