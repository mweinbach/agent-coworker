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
