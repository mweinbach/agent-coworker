import { isGoogleThinkingLevel } from "../shared/googleThinking";
import type { OpenAiCompatibleProviderOptionsByProvider } from "../shared/openaiCompatibleOptions";
import { isOpenAiReasoningEffort } from "../shared/openaiCompatibleOptions";
import type { AgentConfig, ProviderName } from "../types";
import { parseChildModelRef } from "./childModelRouting";

export type ThreadModelSelection = {
  provider?: ProviderName;
  model?: string;
};

export function parseThreadModelSelection(
  raw: string | undefined,
  defaultProvider: ProviderName,
  opts: { home?: string } = {},
): ThreadModelSelection {
  const trimmed = raw?.trim();
  if (!trimmed) return {};
  const parsed = parseChildModelRef(trimmed, defaultProvider, "thread model", opts);
  return parsed.explicitProvider
    ? { provider: parsed.provider, model: parsed.modelId }
    : { model: parsed.modelId };
}

export function buildThreadReasoningOptionsPatch(input: {
  provider: ProviderName;
  model: string;
  thinking?: string;
  current?: AgentConfig["providerOptions"];
}): OpenAiCompatibleProviderOptionsByProvider | undefined {
  const thinking = input.thinking?.trim();
  if (!thinking) return undefined;

  if (input.provider === "openai" || input.provider === "codex-cli") {
    if (!isOpenAiReasoningEffort(thinking)) {
      throw new Error(`Unsupported reasoning effort for ${input.provider}: ${thinking}`);
    }
    const currentForProvider = input.current?.[input.provider] ?? {};
    return {
      [input.provider]: {
        ...currentForProvider,
        reasoningEffort: thinking,
      },
    };
  }

  if (input.provider === "google") {
    if (!isGoogleThinkingLevel(thinking)) {
      throw new Error(`Unsupported Google thinking level: ${thinking}`);
    }
    const currentGoogle = input.current?.google ?? {};
    return {
      google: {
        ...currentGoogle,
        thinkingConfig: {
          ...(currentGoogle.thinkingConfig ?? {}),
          thinkingLevel: thinking,
        },
      },
    };
  }

  throw new Error(`Reasoning/thinking overrides are not supported for provider ${input.provider}`);
}
