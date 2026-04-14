import type { ProviderName } from "../types";

export type ProviderAuthMethodType = "api" | "oauth";
export type ProviderAuthFieldKind = "text" | "password";

export type ProviderAuthMethodField = {
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

const bedrockRegionField: ProviderAuthMethodField = {
  id: "region",
  label: "AWS region",
  kind: "text",
  placeholder: "us-east-1",
};

const bedrockProfileField: ProviderAuthMethodField = {
  id: "profile",
  label: "AWS profile",
  kind: "text",
  required: true,
  placeholder: "default",
};

const bedrockAccessKeyIdField: ProviderAuthMethodField = {
  id: "accessKeyId",
  label: "Access key ID",
  kind: "text",
  required: true,
  placeholder: "AKIA...",
};

const bedrockSecretAccessKeyField: ProviderAuthMethodField = {
  id: "secretAccessKey",
  label: "Secret access key",
  kind: "password",
  required: true,
  secret: true,
};

const bedrockSessionTokenField: ProviderAuthMethodField = {
  id: "sessionToken",
  label: "Session token",
  kind: "password",
  secret: true,
};

const bedrockApiKeyField: ProviderAuthMethodField = {
  id: "apiKey",
  label: "Bedrock API key",
  kind: "password",
  required: true,
  secret: true,
};

const DEFAULT_PROVIDER_AUTH_METHODS: Record<ProviderName, ProviderAuthMethod[]> = {
  google: [
    { id: "api_key", type: "api", label: "API key" },
    { id: "exa_api_key", type: "api", label: "Exa API key (web search)" },
  ],
  openai: [{ id: "api_key", type: "api", label: "API key" }],
  anthropic: [{ id: "api_key", type: "api", label: "API key" }],
  bedrock: [
    {
      id: "aws_default",
      type: "api",
      label: "AWS default credentials",
      fields: [bedrockRegionField],
    },
    {
      id: "aws_profile",
      type: "api",
      label: "AWS profile",
      fields: [bedrockProfileField, bedrockRegionField],
    },
    {
      id: "aws_keys",
      type: "api",
      label: "AWS access keys",
      fields: [
        bedrockAccessKeyIdField,
        bedrockSecretAccessKeyField,
        bedrockSessionTokenField,
        { ...bedrockRegionField, required: true },
      ],
    },
    {
      id: "api_key",
      type: "api",
      label: "Bedrock API key",
      fields: [
        bedrockApiKeyField,
        { ...bedrockRegionField, required: true },
      ],
    },
  ],
  baseten: [{ id: "api_key", type: "api", label: "API key" }],
  together: [{ id: "api_key", type: "api", label: "API key" }],
  fireworks: [{ id: "api_key", type: "api", label: "API key" }],
  nvidia: [{ id: "api_key", type: "api", label: "API key" }],
  lmstudio: [{ id: "api_key", type: "api", label: "API token (optional)" }],
  "opencode-go": [{ id: "api_key", type: "api", label: "API key" }],
  "opencode-zen": [{ id: "api_key", type: "api", label: "API key" }],
  "codex-cli": [
    { id: "oauth_cli", type: "oauth", label: "Sign in with ChatGPT (browser)", oauthMode: "auto" },
    { id: "api_key", type: "api", label: "API key" },
  ],
};

function cloneProviderAuthMethod(method: ProviderAuthMethod): ProviderAuthMethod {
  return {
    ...method,
    ...(method.fields ? { fields: method.fields.map((field) => ({ ...field })) } : {}),
  };
}

export function getDefaultProviderAuthMethods(provider: ProviderName): ProviderAuthMethod[] {
  return DEFAULT_PROVIDER_AUTH_METHODS[provider].map(cloneProviderAuthMethod);
}

export function listDefaultProviderAuthMethods(): Record<string, ProviderAuthMethod[]> {
  const out: Record<string, ProviderAuthMethod[]> = {};
  for (const provider of Object.keys(DEFAULT_PROVIDER_AUTH_METHODS) as ProviderName[]) {
    out[provider] = getDefaultProviderAuthMethods(provider);
  }
  return out;
}
