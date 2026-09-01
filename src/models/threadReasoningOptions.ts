import { reasoningConfigForProviderModel } from "../providers/catalog";
import { isGoogleThinkingLevel } from "../shared/googleThinking";
import type {
  CatalogReasoningEffort,
  OpenAiCompatibleProviderOptionsByProvider,
} from "../shared/openaiCompatibleOptions";
import { isOpenAiReasoningEffort } from "../shared/openaiCompatibleOptions";
import type { AgentConfig, ProviderName } from "../types";
import { parseChildModelRef } from "./childModelRouting";
import { getDiscoveredModelMetadataSync } from "./metadata";

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

function assertModelReasoningEffort(
  provider: "openai" | "codex-cli" | "google",
  model: string,
  thinking: CatalogReasoningEffort,
  home?: string,
): void {
  // Runtime discovery can advertise choices newer than the bundled catalog.
  // An unknown/custom model without a declared list keeps syntax-only validation.
  const availableEfforts =
    getDiscoveredModelMetadataSync(provider, model, { home })?.supportedReasoningEfforts ??
    reasoningConfigForProviderModel(provider, model)?.availableEfforts;
  if (availableEfforts && !availableEfforts.includes(thinking)) {
    throw new Error(
      `Unsupported reasoning effort for ${provider}:${model}: ${thinking}. Supported efforts: ${availableEfforts.join(", ")}`,
    );
  }
}

export function buildThreadReasoningOptionsPatch(input: {
  provider: ProviderName;
  model: string;
  thinking?: string;
  current?: AgentConfig["providerOptions"];
  home?: string;
}): OpenAiCompatibleProviderOptionsByProvider | undefined {
  const thinking = input.thinking?.trim();
  if (!thinking) return undefined;

  if (input.provider === "openai" || input.provider === "codex-cli") {
    if (!isOpenAiReasoningEffort(thinking)) {
      throw new Error(`Unsupported reasoning effort for ${input.provider}: ${thinking}`);
    }
    assertModelReasoningEffort(input.provider, input.model, thinking, input.home);
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
    assertModelReasoningEffort(input.provider, input.model, thinking, input.home);
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
