import { PROVIDER_SPECS } from "../../../../src/generated/providerSpecs";
import { getDefaultProviderAuthMethods } from "../../../../src/shared/providerAuthMethods";
import type { ProviderName, SessionEvent } from "./wsProtocol";
import { PROVIDER_NAMES } from "./wsProtocol";

type ProviderAuthMethod = Extract<
  SessionEvent,
  { type: "provider_auth_methods" }
>["methods"][string][number];
const EXA_AUTH_METHOD_ID = "exa_api_key";
const PARALLEL_AUTH_METHOD_ID = "parallel_api_key";

// Desktop branding overrides on top of `displayName` from config/providers.json.
const DESKTOP_DISPLAY_NAME_OVERRIDES: Partial<Record<ProviderName, string>> = {
  "codex-cli": "ChatGPT Subscription",
};

export function displayProviderName(provider: ProviderName): string {
  return (
    DESKTOP_DISPLAY_NAME_OVERRIDES[provider] ?? PROVIDER_SPECS[provider]?.displayName ?? provider
  );
}

export function isProviderNameString(value: unknown): value is ProviderName {
  return typeof value === "string" && (PROVIDER_NAMES as readonly string[]).includes(value);
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
