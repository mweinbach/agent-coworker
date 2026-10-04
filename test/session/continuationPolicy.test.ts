import { describe, expect, test } from "bun:test";

import { isInvalidProviderManagedContinuationError } from "../../src/server/session/turnExecution/continuationPolicy";

describe("isInvalidProviderManagedContinuationError", () => {
  test.each([
    ["openai", new Error("previous_response_id abc not found"), true],
    ["openai", "Previous response has expired", true],
    ["openai", "response_id is invalid", true],
    ["openai", "previous_response_id is unavailable", false],
    ["openai", "not found", false],
    ["openai", new Error("previous_interaction_id not found"), false],
    ["google", new Error("previous_interaction_id does not exist"), true],
    ["google", "interaction id is invalid_argument", true],
    ["google", "interaction_id missing", false],
    ["codex-cli", "thread_id xyz not found", true],
    ["codex-cli", "thread has expired", true],
    ["codex-cli", "thread is busy", false],
    ["anthropic", new Error("previous_response_id not found"), false],
  ] as const)("classifies %s continuation error %p as %s", (provider, error, expected) => {
    expect(isInvalidProviderManagedContinuationError(provider, error)).toBe(expected);
  });
});
