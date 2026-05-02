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
export type ProviderManagedContinuationProvider = OpenAiContinuationProvider | "codex-cli" | "google";

export type GoogleContinuationState = {
  provider: "google";
  model: string;
  interactionId: string;
  updatedAt: string;
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

export function isCodexAppServerContinuationState(
  state: ProviderContinuationState | null | undefined,
): state is CodexAppServerContinuationState {
  return state?.provider === "codex-cli" && "threadId" in state;
}
