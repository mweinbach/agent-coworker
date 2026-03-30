import type { ProviderName } from "./wsProtocol";
import { PROVIDER_NAMES } from "./wsProtocol";

export const SETTINGS_PROVIDER_ORDER: readonly ProviderName[] = [
  "codex-cli",
  "opencode-go",
  "google",
  "anthropic",
  "aws-bedrock-proxy",
  "opencode-zen",
  "fireworks",
  "nvidia",
  "together",
  "baseten",
];

const SETTINGS_PROVIDER_PRIORITY = new Map<ProviderName, number>(
  SETTINGS_PROVIDER_ORDER.map((provider, index) => [provider, index]),
);

export function compareProviderNamesForSettings(left: ProviderName, right: ProviderName): number {
  const leftPriority = SETTINGS_PROVIDER_PRIORITY.get(left) ?? SETTINGS_PROVIDER_ORDER.length + PROVIDER_NAMES.indexOf(left);
  const rightPriority =
    SETTINGS_PROVIDER_PRIORITY.get(right) ?? SETTINGS_PROVIDER_ORDER.length + PROVIDER_NAMES.indexOf(right);
  return leftPriority - rightPriority;
}

export function sortProviderEntriesForSettings<T extends { provider: ProviderName }>(entries: readonly T[]): T[] {
  return [...entries].sort((left, right) => compareProviderNamesForSettings(left.provider, right.provider));
}

export function sortProviderNamesForSettings(providers: readonly ProviderName[]): ProviderName[] {
  return [...providers].sort(compareProviderNamesForSettings);
}
