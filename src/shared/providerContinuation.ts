import { z } from "zod";

import {
  OPENAI_CONTINUATION_PROVIDER_NAMES,
  openAiContinuationStateSchema,
  supportsOpenAiContinuation,
  type OpenAiContinuationProvider,
  type OpenAiContinuationState,
} from "./openaiContinuation";

export const PROVIDER_MANAGED_CONTINUATION_PROVIDER_NAMES = [
  ...OPENAI_CONTINUATION_PROVIDER_NAMES,
  "google",
] as const;
export type ProviderManagedContinuationProvider =
  | OpenAiContinuationProvider
  | "google";

export type GoogleContinuationState = {
  provider: "google";
  model: string;
  interactionId: string;
  updatedAt: string;
};

export type ProviderContinuationState =
  | OpenAiContinuationState
  | GoogleContinuationState;

export const googleContinuationStateSchema = z.object({
  provider: z.literal("google"),
  model: z.string().trim().min(1),
  interactionId: z.string().trim().min(1),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const providerContinuationStateSchema = z.discriminatedUnion("provider", [
  openAiContinuationStateSchema,
  googleContinuationStateSchema,
]);

export function supportsProviderManagedContinuationProvider(
  provider: unknown,
): provider is ProviderManagedContinuationProvider {
  return provider === "google" || supportsOpenAiContinuation(provider);
}

export function isGoogleContinuationState(
  state: ProviderContinuationState | null | undefined,
): state is GoogleContinuationState {
  return state?.provider === "google";
}

