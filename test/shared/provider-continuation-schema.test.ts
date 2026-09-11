import { describe, expect, test } from "bun:test";

import {
  buildRequestFingerprint,
  providerContinuationStateSchema,
  supportsProviderManagedContinuationProvider,
} from "../../src/shared/providerContinuation";

const updatedAt = "2026-09-07T10:00:00.000Z";

describe("providerContinuationStateSchema", () => {
  test("accepts the OpenAI, Codex, and Google continuation shapes and trims ids", () => {
    expect(
      providerContinuationStateSchema.parse({
        provider: "openai",
        model: "  gpt-5.2  ",
        responseId: "  resp_1  ",
        updatedAt,
        accountId: " acct_1 ",
      }),
    ).toEqual({
      provider: "openai",
      model: "gpt-5.2",
      responseId: "resp_1",
      updatedAt,
      accountId: "acct_1",
    });
    expect(
      providerContinuationStateSchema.parse({
        provider: "codex-cli",
        model: "gpt-5.2",
        threadId: "thr_1",
        updatedAt,
      }),
    ).toEqual({
      provider: "codex-cli",
      model: "gpt-5.2",
      threadId: "thr_1",
      updatedAt,
    });
    expect(
      providerContinuationStateSchema.parse({
        provider: "google",
        model: "gemini-3",
        interactionId: "ix_1",
        updatedAt,
        requestFingerprint: "fp_1",
      }),
    ).toEqual({
      provider: "google",
      model: "gemini-3",
      interactionId: "ix_1",
      updatedAt,
      requestFingerprint: "fp_1",
    });
  });

  test("rejects blank ids, bad timestamps, extras, and cross-provider fields", () => {
    expect(
      providerContinuationStateSchema.safeParse({
        provider: "openai",
        model: "gpt-5.2",
        responseId: "   ",
        updatedAt,
      }).success,
    ).toBe(false);
    expect(
      providerContinuationStateSchema.safeParse({
        provider: "google",
        model: "gemini-3",
        interactionId: "ix_1",
        updatedAt: "Monday",
      }).success,
    ).toBe(false);
    expect(
      providerContinuationStateSchema.safeParse({
        provider: "google",
        model: "gemini-3",
        interactionId: "ix_1",
        threadId: "thr_1",
        updatedAt,
      }).success,
    ).toBe(false);
    expect(
      providerContinuationStateSchema.safeParse({
        provider: "codex-cli",
        model: "gpt-5.2",
        threadId: "thr_1",
        responseId: "resp_1",
        updatedAt,
      }).success,
    ).toBe(false);
    expect(
      providerContinuationStateSchema.safeParse({
        provider: "openai",
        model: "gpt-5.2",
        responseId: "resp_1",
        updatedAt,
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe("supportsProviderManagedContinuationProvider", () => {
  test("allows only the providers that persist continuation state", () => {
    expect(supportsProviderManagedContinuationProvider("openai")).toBe(true);
    expect(supportsProviderManagedContinuationProvider("google")).toBe(true);
    expect(supportsProviderManagedContinuationProvider("codex-cli")).toBe(true);
    expect(supportsProviderManagedContinuationProvider("anthropic")).toBe(false);
    expect(supportsProviderManagedContinuationProvider("")).toBe(false);
  });
});

describe("buildRequestFingerprint", () => {
  test("omits apiKey and signal so persisted fingerprints cannot leak credentials", () => {
    const withoutSecrets = buildRequestFingerprint({
      modelId: "gpt-5.2",
      system: "sys",
      tools: [{ name: "read" }],
      streamOptions: { temperature: 0 },
    });
    const withSecrets = buildRequestFingerprint({
      modelId: "gpt-5.2",
      system: "sys",
      tools: [{ name: "read" }],
      streamOptions: { temperature: 0, apiKey: "not-a-real-api-key", signal: { aborted: false } },
    });
    expect(withSecrets).toBe(withoutSecrets);
    expect(withSecrets).not.toContain("not-a-real-api-key");
  });
});
