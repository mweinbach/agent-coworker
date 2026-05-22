import { z } from "zod";

import {
  OPENAI_CONTINUATION_PROVIDER_NAMES,
  type OpenAiContinuationProvider,
  type OpenAiContinuationState,
  openAiContinuationStateSchema,
  supportsOpenAiContinuation,
} from "./openaiContinuation";

export const PROVIDER_MANAGED_CONTINUATION_PROVIDER_NAMES = [
  ...OPENAI_CONTINUATION_PROVIDER_NAMES,
  "codex-cli",
  "google",
] as const;
export type ProviderManagedContinuationProvider =
  | OpenAiContinuationProvider
  | "codex-cli"
  | "google";

export type GoogleContinuationState = {
  provider: "google";
  model: string;
  interactionId: string;
  updatedAt: string;
  requestFingerprint?: string;
};

export type CodexAppServerContinuationState = {
  provider: "codex-cli";
  model: string;
  threadId: string;
  updatedAt: string;
};

export type ProviderContinuationState =
  | OpenAiContinuationState
  | GoogleContinuationState
  | CodexAppServerContinuationState;

export const googleContinuationStateSchema = z
  .object({
    provider: z.literal("google"),
    model: z.string().trim().min(1),
    interactionId: z.string().trim().min(1),
    updatedAt: z.string().datetime({ offset: true }),
    requestFingerprint: z.string().trim().min(1).optional(),
  })
  .strict();

export const codexAppServerContinuationStateSchema = z
  .object({
    provider: z.literal("codex-cli"),
    model: z.string().trim().min(1),
    threadId: z.string().trim().min(1),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const providerContinuationStateSchema = z.union([
  openAiContinuationStateSchema,
  codexAppServerContinuationStateSchema,
  googleContinuationStateSchema,
]);

export function supportsProviderManagedContinuationProvider(
  provider: unknown,
): provider is ProviderManagedContinuationProvider {
  return provider === "codex-cli" || provider === "google" || supportsOpenAiContinuation(provider);
}

export function isGoogleContinuationState(
  state: ProviderContinuationState | null | undefined,
): state is GoogleContinuationState {
  return state?.provider === "google";
}

export function isInvalidGoogleContinuationError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const normalized = text.toLowerCase();
  const mentionsInteractionId =
    normalized.includes("interaction_id") ||
    normalized.includes("interaction id") ||
    normalized.includes("previous_interaction_id") ||
    normalized.includes("previous interaction");
  if (!mentionsInteractionId) return false;

  return (
    normalized.includes("not found") ||
    normalized.includes("invalid") ||
    normalized.includes("invalid_argument") ||
    normalized.includes("invalid argument") ||
    normalized.includes("invalid_request") ||
    normalized.includes("expired") ||
    normalized.includes("unknown") ||
    normalized.includes("does not exist")
  );
}

export function isCodexAppServerContinuationState(
  state: ProviderContinuationState | null | undefined,
): state is CodexAppServerContinuationState {
  return state?.provider === "codex-cli" && "threadId" in state;
}

export function stableFingerprintStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableFingerprintStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableFingerprintStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function buildRequestFingerprint(input: {
  modelId: string;
  system: string;
  tools: Array<Record<string, unknown>>;
  streamOptions: Record<string, unknown>;
}): string {
  const { apiKey: _apiKey, signal: _signal, ...safeStreamOptions } = input.streamOptions;
  return stableFingerprintStringify({
    modelId: input.modelId,
    system: input.system,
    tools: input.tools,
    streamOptions: safeStreamOptions,
  });
}
