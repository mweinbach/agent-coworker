import { z } from "zod";

export const OPENAI_CONTINUATION_PROVIDER_NAMES = ["openai", "codex-cli"] as const;
export type OpenAiContinuationProvider = (typeof OPENAI_CONTINUATION_PROVIDER_NAMES)[number];

export type OpenAiContinuationState = {
  provider: OpenAiContinuationProvider;
  model: string;
  responseId: string;
  updatedAt: string;
  accountId?: string;
};

export const openAiContinuationStateSchema = z
  .object({
    provider: z.enum(OPENAI_CONTINUATION_PROVIDER_NAMES),
    model: z.string().trim().min(1),
    responseId: z.string().trim().min(1),
    updatedAt: z.string().datetime({ offset: true }),
    accountId: z.string().trim().min(1).optional(),
  })
  .strict();

export function supportsOpenAiContinuation(
  provider: unknown,
): provider is OpenAiContinuationProvider {
  return (
    typeof provider === "string" &&
    (OPENAI_CONTINUATION_PROVIDER_NAMES as readonly string[]).includes(provider)
  );
}

export function continuationMatchesTarget(
  state: { provider?: unknown; model?: unknown; accountId?: unknown } | null | undefined,
  target: { provider: OpenAiContinuationProvider; model: string; accountId?: string },
): state is OpenAiContinuationState {
  if (!state) return false;
  if (state.provider !== target.provider) return false;
  if (state.model !== target.model) return false;
  if (
    target.provider === "codex-cli" &&
    state.accountId &&
    target.accountId &&
    state.accountId !== target.accountId
  ) {
    return false;
  }
  return true;
}
