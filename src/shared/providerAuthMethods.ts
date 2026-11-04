import { PROVIDER_SPECS } from "../generated/providerSpecs";
import type { ProviderName } from "../types";

type ProviderAuthMethodType = "api" | "oauth";
type ProviderAuthFieldKind = "text" | "password";

type ProviderAuthMethodField = {
  id: string;
  label: string;
  kind: ProviderAuthFieldKind;
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
};

export type ProviderAuthMethod = {
  id: string;
  type: ProviderAuthMethodType;
  label: string;
  oauthMode?: "auto" | "code";
  fields?: ProviderAuthMethodField[];
};

type StaticProviderAuthMethod = (typeof PROVIDER_SPECS)[ProviderName]["authMethods"][number];

function cloneProviderAuthMethod(method: StaticProviderAuthMethod): ProviderAuthMethod {
  const { fields, ...rest } = method;
  return { ...rest, ...(fields ? { fields: fields.map((field) => ({ ...field })) } : {}) };
}

/** Static auth methods from `config/providers.json` (fresh mutable copies). */
export function getDefaultProviderAuthMethods(provider: ProviderName): ProviderAuthMethod[] {
  return PROVIDER_SPECS[provider].authMethods.map(cloneProviderAuthMethod);
}
