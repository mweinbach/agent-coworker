import { describe, expect, test } from "bun:test";

import {
  continuationMatchesTarget,
  openAiContinuationStateSchema,
  supportsOpenAiContinuation,
} from "../../src/shared/openaiContinuation";
import {
  buildRequestFingerprint,
  isCodexAppServerContinuationState,
  isGoogleContinuationState,
  providerContinuationStateSchema,
  supportsProviderManagedContinuationProvider,
} from "../../src/shared/providerContinuation";

const UPDATED_AT = "2026-08-27T10:00:00.000Z";

describe("provider continuation fingerprints", () => {
  test("is stable across object key order and strips apiKey/signal", () => {
    const toolsA = [{ name: "bash", schema: { type: "object" } }];
    const toolsB = [{ schema: { type: "object" }, name: "bash" }];
    const left = buildRequestFingerprint({
      modelId: "gpt-5.4",
      system: "be careful",
      tools: toolsA,
      streamOptions: {
        temperature: 0.2,
        apiKey: "not-a-real-api-key",
        signal: { aborted: false },
        maxTokens: 128,
      },
    });
    const right = buildRequestFingerprint({
      system: "be careful",
      modelId: "gpt-5.4",
      tools: toolsB,
      streamOptions: {
        maxTokens: 128,
        signal: { aborted: true },
        temperature: 0.2,
        apiKey: "another-not-a-real-api-key",
      },
    });

    expect(left).toBe(right);
    expect(left).not.toContain("apiKey");
    expect(left).not.toContain("signal");
    expect(left).not.toContain("not-a-real-api-key");
  });

  test("changes when model, system, tools, or remaining stream options change", () => {
    const base = {
      modelId: "gpt-5.4",
      system: "be careful",
      tools: [{ name: "bash" }],
      streamOptions: { temperature: 0.2 },
    };
    const baseline = buildRequestFingerprint(base);

    expect(buildRequestFingerprint({ ...base, modelId: "gpt-5.4-mini" })).not.toBe(baseline);
    expect(buildRequestFingerprint({ ...base, system: "be brief" })).not.toBe(baseline);
    expect(buildRequestFingerprint({ ...base, tools: [{ name: "read" }] })).not.toBe(baseline);
    expect(buildRequestFingerprint({ ...base, streamOptions: { temperature: 0.4 } })).not.toBe(
      baseline,
    );
  });
});

describe("provider continuation schema gates", () => {
  test("accepts canonical openai, google, and codex-cli states", () => {
    expect(
      providerContinuationStateSchema.parse({
        provider: "openai",
        model: "gpt-5.4",
        responseId: "resp_1",
        updatedAt: UPDATED_AT,
        accountId: "acct_1",
        requestFingerprint: "fp-1",
      }),
    ).toMatchObject({ provider: "openai", responseId: "resp_1" });
    expect(
      providerContinuationStateSchema.parse({
        provider: "google",
        model: "gemini-3-flash-preview",
        interactionId: "ix_1",
        updatedAt: UPDATED_AT,
      }),
    ).toMatchObject({ provider: "google", interactionId: "ix_1" });
    expect(
      providerContinuationStateSchema.parse({
        provider: "codex-cli",
        model: "gpt-5.3-codex",
        threadId: "thread_1",
        updatedAt: UPDATED_AT,
      }),
    ).toMatchObject({ provider: "codex-cli", threadId: "thread_1" });
  });

  test("rejects extra keys, blank ids, and datetimes without an offset", () => {
    expect(
      providerContinuationStateSchema.safeParse({
        provider: "openai",
        model: "gpt-5.4",
        responseId: "resp_1",
        updatedAt: UPDATED_AT,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      providerContinuationStateSchema.safeParse({
        provider: "google",
        model: "   ",
        interactionId: "ix_1",
        updatedAt: UPDATED_AT,
      }).success,
    ).toBe(false);
    expect(
      providerContinuationStateSchema.safeParse({
        provider: "codex-cli",
        model: "gpt-5.3-codex",
        threadId: "",
        updatedAt: UPDATED_AT,
      }).success,
    ).toBe(false);
    expect(
      providerContinuationStateSchema.safeParse({
        provider: "openai",
        model: "gpt-5.4",
        responseId: "resp_1",
        updatedAt: "2026-08-27T10:00:00.000",
      }).success,
    ).toBe(false);
    expect(
      openAiContinuationStateSchema.safeParse({
        provider: "openai",
        model: "gpt-5.4",
        responseId: "resp_1",
        updatedAt: UPDATED_AT,
        requestFingerprint: "   ",
      }).success,
    ).toBe(false);
  });

  test("type guards and provider support fail closed", () => {
    expect(supportsOpenAiContinuation("openai")).toBe(true);
    expect(supportsOpenAiContinuation("google")).toBe(false);
    expect(supportsProviderManagedContinuationProvider("openai")).toBe(true);
    expect(supportsProviderManagedContinuationProvider("google")).toBe(true);
    expect(supportsProviderManagedContinuationProvider("codex-cli")).toBe(true);
    expect(supportsProviderManagedContinuationProvider("anthropic")).toBe(false);
    expect(supportsProviderManagedContinuationProvider(null)).toBe(false);

    expect(
      isGoogleContinuationState({
        provider: "google",
        model: "gemini-3-flash-preview",
        interactionId: "ix_1",
        updatedAt: UPDATED_AT,
      }),
    ).toBe(true);
    expect(
      isGoogleContinuationState({
        provider: "openai",
        model: "gpt-5.4",
        responseId: "resp_1",
        updatedAt: UPDATED_AT,
      }),
    ).toBe(false);
    expect(
      isCodexAppServerContinuationState({
        provider: "codex-cli",
        model: "gpt-5.3-codex",
        threadId: "thread_1",
        updatedAt: UPDATED_AT,
      }),
    ).toBe(true);
    expect(isCodexAppServerContinuationState(null)).toBe(false);
  });

  test("continuationMatchesTarget requires provider and model", () => {
    const target = { provider: "openai" as const, model: "gpt-5.4", accountId: "acct_1" };
    expect(continuationMatchesTarget(null, target)).toBe(false);
    expect(continuationMatchesTarget(undefined, target)).toBe(false);
    expect(continuationMatchesTarget({ provider: "google", model: "gpt-5.4" }, target)).toBe(false);
    expect(continuationMatchesTarget({ provider: "openai", model: "gpt-5.4-mini" }, target)).toBe(
      false,
    );
    expect(continuationMatchesTarget({ provider: "openai", model: "gpt-5.4" }, target)).toBe(true);
  });
});
