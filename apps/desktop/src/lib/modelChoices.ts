import type { ProviderName } from "./wsProtocol";
import { PROVIDER_NAMES } from "./wsProtocol";
import { availableModelsForProvider } from "@cowork/providers/catalog";

export const UI_DISABLED_PROVIDERS = new Set<ProviderName>();

export const MODEL_CHOICES: Record<ProviderName, readonly string[]> = Object.fromEntries(
  PROVIDER_NAMES.map((provider) => [provider, availableModelsForProvider(provider)])
) as Record<ProviderName, readonly string[]>;

export function modelOptionsForProvider(provider: ProviderName, currentModel?: string | null): readonly string[] {
  const base = MODEL_CHOICES[provider] ?? [];
  const normalized = typeof currentModel === "string" ? currentModel.trim() : "";
  if (!normalized) return base;
  if (base.includes(normalized)) return base;
  return [normalized, ...base];
}
