import type { ProviderName } from "../types";

const MODEL_PREFERENCE_PROVIDER_NAMES = [
  "google",
  "openai",
  "anthropic",
  "bedrock",
  "baseten",
  "together",
  "fireworks",
  "firepass",
  "nvidia",
  "minimax",
  "opencode-go",
  "opencode-zen",
  "codex-cli",
  "antigravity",
] as const satisfies readonly ProviderName[];

export type ModelPreferenceProviderName = (typeof MODEL_PREFERENCE_PROVIDER_NAMES)[number];

export function resolveModelPreferenceProviderName(
  value: unknown,
): ModelPreferenceProviderName | null {
  if (typeof value !== "string") return null;
  return (MODEL_PREFERENCE_PROVIDER_NAMES as readonly string[]).includes(value)
    ? (value as ModelPreferenceProviderName)
    : null;
}

export function supportsModelPreferences(
  provider: ProviderName,
): provider is ModelPreferenceProviderName {
  return resolveModelPreferenceProviderName(provider) !== null;
}
