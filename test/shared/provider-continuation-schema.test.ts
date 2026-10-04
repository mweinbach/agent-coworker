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
    ).toEqual({ provider: "codex-cli", model: "gpt-5.2", threadId: "thr_1", updatedAt });
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
    for (const invalid of [
      { provider: "openai", model: "gpt-5.2", responseId: "   ", updatedAt },
      { provider: "google", model: "gemini-3", interactionId: "ix_1", updatedAt: "Monday" },
      {
        provider: "google",
        model: "gemini-3",
        interactionId: "ix_1",
        threadId: "thr_1",
        updatedAt,
      },
      {
        provider: "codex-cli",
        model: "gpt-5.2",
        threadId: "thr_1",
        responseId: "resp_1",
        updatedAt,
      },
      { provider: "openai", model: "gpt-5.2", responseId: "resp_1", updatedAt, extra: true },
    ]) {
      expect(providerContinuationStateSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("supportsProviderManagedContinuationProvider", () => {
  test("allows only the providers that persist continuation state", () => {
    for (const p of ["openai", "google", "codex-cli"]) {
      expect(supportsProviderManagedContinuationProvider(p)).toBe(true);
    }
    for (const p of ["anthropic", ""]) {
      expect(supportsProviderManagedContinuationProvider(p)).toBe(false);
    }
  });
});

describe("buildRequestFingerprint", () => {
  test("omits apiKey and signal so persisted fingerprints cannot leak credentials", () => {
    const base = { modelId: "gpt-5.2", system: "sys", tools: [{ name: "read" }] };
    const withoutSecrets = buildRequestFingerprint({ ...base, streamOptions: { temperature: 0 } });
    const withSecrets = buildRequestFingerprint({
      ...base,
      streamOptions: { temperature: 0, apiKey: "not-a-real-api-key", signal: { aborted: false } },
    });
    expect(withSecrets).toBe(withoutSecrets);
    expect(withSecrets).not.toContain("not-a-real-api-key");
  });
});
