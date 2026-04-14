import type { ProviderName, ServerEvent } from "./wsProtocol";
import { PROVIDER_NAMES } from "./wsProtocol";
import { getDefaultProviderAuthMethods } from "../../../../src/shared/providerAuthMethods";

type ProviderAuthMethod = Extract<ServerEvent, { type: "provider_auth_methods" }>["methods"][string][number];

const DISPLAY_NAMES: Partial<Record<ProviderName, string>> = {
  google: "Google",
  openai: "OpenAI",
  anthropic: "Anthropic",
  bedrock: "Amazon Bedrock",
  baseten: "Baseten",
  together: "Together AI",
  fireworks: "Fireworks AI",
  nvidia: "NVIDIA",
  lmstudio: "LM Studio",
  "opencode-go": "OpenCode Go",
  "opencode-zen": "OpenCode Zen",
  "codex-cli": "ChatGPT Subscription",
};

export function displayProviderName(provider: ProviderName): string {
  return DISPLAY_NAMES[provider] ?? provider;
}

export function isProviderNameString(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

export function fallbackAuthMethods(provider: ProviderName): ProviderAuthMethod[] {
  if (provider === "lmstudio") {
    return [];
  }
  return getDefaultProviderAuthMethods(provider);
}
