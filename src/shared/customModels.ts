import type { ProviderName } from "../types";

export const CUSTOM_MODEL_PROVIDER_NAMES = [
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
  "antigravity",
] as const satisfies readonly ProviderName[];

export type CustomModelProviderName = (typeof CUSTOM_MODEL_PROVIDER_NAMES)[number];

export function resolveCustomModelProviderName(value: unknown): CustomModelProviderName | null {
  if (typeof value !== "string") return null;
  return (CUSTOM_MODEL_PROVIDER_NAMES as readonly string[]).includes(value)
    ? (value as CustomModelProviderName)
    : null;
}

export function supportsCustomModelIds(
  provider: ProviderName,
): provider is CustomModelProviderName {
  return resolveCustomModelProviderName(provider) !== null;
}
