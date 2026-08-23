import { describe, expect, test } from "bun:test";

import { isInvalidProviderManagedContinuationError } from "../../src/server/session/turnExecution/continuationPolicy";

describe("isInvalidProviderManagedContinuationError", () => {
  test("classifies OpenAI previous-response failures as invalid continuation", () => {
    expect(
      isInvalidProviderManagedContinuationError(
        "openai",
        new Error("previous_response_id not found"),
      ),
    ).toBe(true);
    expect(
      isInvalidProviderManagedContinuationError("openai", "Previous response is invalid"),
    ).toBe(true);
    expect(isInvalidProviderManagedContinuationError("openai", "response_id expired")).toBe(true);
    expect(
      isInvalidProviderManagedContinuationError("openai", "unknown previous_response_id"),
    ).toBe(true);
  });

  test("rejects OpenAI errors that are not continuation-handle failures", () => {
    expect(isInvalidProviderManagedContinuationError("openai", "network timeout")).toBe(false);
    expect(isInvalidProviderManagedContinuationError("openai", "previous_response_id")).toBe(false);
    expect(isInvalidProviderManagedContinuationError("openai", "not found")).toBe(false);
  });

  test("classifies Google interaction-handle failures as invalid continuation", () => {
    expect(isInvalidProviderManagedContinuationError("google", "interaction_id not found")).toBe(
      true,
    );
    expect(
      isInvalidProviderManagedContinuationError(
        "google",
        new Error("previous_interaction_id is invalid_argument"),
      ),
    ).toBe(true);
    expect(isInvalidProviderManagedContinuationError("google", "thread_id not found")).toBe(false);
    expect(isInvalidProviderManagedContinuationError("google", "network timeout")).toBe(false);
  });

  test("classifies Codex thread-handle failures as invalid continuation", () => {
    expect(isInvalidProviderManagedContinuationError("codex-cli", "thread_id not found")).toBe(
      true,
    );
    expect(isInvalidProviderManagedContinuationError("codex-cli", "thread id expired")).toBe(true);
    expect(isInvalidProviderManagedContinuationError("codex-cli", "unknown thread")).toBe(true);
    expect(
      isInvalidProviderManagedContinuationError("codex-cli", "previous_response_id not found"),
    ).toBe(false);
  });

  test("does not treat other providers as owning a managed continuation", () => {
    expect(
      isInvalidProviderManagedContinuationError("anthropic", "previous_response_id not found"),
    ).toBe(false);
    expect(isInvalidProviderManagedContinuationError("google-vertex", "thread_id not found")).toBe(
      false,
    );
    expect(isInvalidProviderManagedContinuationError(undefined, "thread_id not found")).toBe(false);
  });
});
