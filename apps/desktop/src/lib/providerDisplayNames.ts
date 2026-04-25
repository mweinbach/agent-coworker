import { getDefaultProviderAuthMethods } from "../../../../src/shared/providerAuthMethods";
import type { ProviderName, SessionEvent } from "./wsProtocol";
import { PROVIDER_NAMES } from "./wsProtocol";

type ProviderAuthMethod = Extract<
  SessionEvent,
  { type: "provider_auth_methods" }
>["methods"][string][number];
const EXA_AUTH_METHOD_ID = "exa_api_key";
const PARALLEL_AUTH_METHOD_ID = "parallel_api_key";

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

export function visibleAuthMethods(
  provider: ProviderName,
  methods: ProviderAuthMethod[],
): ProviderAuthMethod[] {
  if (provider === "google") {
    return methods.filter(
      (method) => method.id !== EXA_AUTH_METHOD_ID && method.id !== PARALLEL_AUTH_METHOD_ID,
    );
  }
  if (provider === "codex-cli") {
    return methods.filter((method) => method.id !== "api_key");
  }
  return methods;
}
