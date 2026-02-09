import type { ProviderName } from "./wsProtocol";
import { PROVIDER_NAMES } from "./wsProtocol";
import { availableModelsForProvider } from "@cowork/providers";

export const UI_DISABLED_PROVIDERS = new Set<ProviderName>(["gemini-cli"]);

export const MODEL_CHOICES: Record<ProviderName, readonly string[]> = Object.fromEntries(
  PROVIDER_NAMES.map((provider) => [provider, availableModelsForProvider(provider)])
) as Record<ProviderName, readonly string[]>;

