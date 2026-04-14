import type { ProviderName, ServerEvent } from "./wsProtocol";
import { PROVIDER_NAMES } from "./wsProtocol";

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
  if (provider === "google") {
    return [
      { id: "api_key", type: "api", label: "API key" },
    ];
  }
  if (provider === "codex-cli") {
    return [
      { id: "oauth_cli", type: "oauth", label: "Sign in with ChatGPT (browser)", oauthMode: "auto" },
      { id: "api_key", type: "api", label: "API key" },
    ];
  }
  if (provider === "bedrock") {
    return [
      { id: "aws_default", type: "api", label: "AWS default credentials" },
      { id: "aws_profile", type: "api", label: "AWS profile" },
      { id: "aws_keys", type: "api", label: "AWS access keys" },
      { id: "api_key", type: "api", label: "Bedrock API key" },
    ];
  }
  if (provider === "lmstudio") {
    return [];
  }
  return [{ id: "api_key", type: "api", label: "API key" }];
}
