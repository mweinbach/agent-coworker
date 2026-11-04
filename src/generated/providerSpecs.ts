// GENERATED FILE - DO NOT EDIT.
// Source: config/providers.json. Regenerate with `bun run providers:generate`;
// `bun run docs:check` fails when this file is stale.

/** Canonical provider ids, in canonical provider order. */
export const PROVIDER_NAMES = [
  "google",
  "openai",
  "anthropic",
  "bedrock",
  "baseten",
  "together",
  "fireworks",
  "firepass",
  "nvidia",
  "lmstudio",
  "minimax",
  "opencode-go",
  "opencode-zen",
  "codex-cli",
] as const;

type GeneratedProviderName = (typeof PROVIDER_NAMES)[number];

/** Providers whose models are registered statically under `config/models/<provider>/`. */
export const MODEL_REGISTRY_PROVIDER_NAMES = [
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
] as const satisfies readonly GeneratedProviderName[];

type ProviderSpecAuthField = {
  readonly id: string;
  readonly label: string;
  readonly kind: "text" | "password";
  readonly required?: boolean;
  readonly secret?: boolean;
  readonly placeholder?: string;
};

type ProviderSpecAuthMethod = {
  readonly id: string;
  readonly type: "api" | "oauth";
  readonly label: string;
  readonly oauthMode?: "auto" | "code";
  readonly fields?: readonly ProviderSpecAuthField[];
};

type ProviderSpec = {
  readonly displayName: string;
  readonly transport: "gemini-interactions" | "openai-responses" | "anthropic-messages" | "bedrock-converse" | "chat-completions" | "codex-app-server";
  readonly userFacing: boolean;
  readonly discovery: "api" | "static" | "local";
  /** Default model id; for registry providers it is the `isDefault` model in `config/models/`. */
  readonly defaultModel: string;
  readonly titleModel: string | null;
  /** Static auth methods offered before the server reports live ones. */
  readonly authMethods: readonly ProviderSpecAuthMethod[];
};

export const PROVIDER_SPECS: { readonly [P in GeneratedProviderName]: ProviderSpec } = {
  "google": {
    displayName: "Google",
    transport: "gemini-interactions",
    userFacing: true,
    discovery: "api",
    defaultModel: "gemini-3.1-pro-preview",
    titleModel: "gemini-3-flash-preview",
    authMethods: [
      {
        "id": "api_key",
        "type": "api",
        "label": "API key"
      },
      {
        "id": "exa_api_key",
        "type": "api",
        "label": "Exa API key (web search)"
      },
      {
        "id": "parallel_api_key",
        "type": "api",
        "label": "Parallel API key (web search)"
      }
    ],
  },
  "openai": {
    displayName: "OpenAI",
    transport: "openai-responses",
    userFacing: true,
    discovery: "api",
    defaultModel: "gpt-5.4",
    titleModel: "gpt-5-mini",
    authMethods: [
      {
        "id": "api_key",
        "type": "api",
        "label": "API key"
      }
    ],
  },
  "anthropic": {
    displayName: "Anthropic",
    transport: "anthropic-messages",
    userFacing: true,
    discovery: "api",
    defaultModel: "claude-opus-4-8",
    titleModel: "claude-haiku-4-5",
    authMethods: [
      {
        "id": "api_key",
        "type": "api",
        "label": "API key"
      }
    ],
  },
  "bedrock": {
    displayName: "Amazon Bedrock",
    transport: "bedrock-converse",
    userFacing: true,
    discovery: "static",
    defaultModel: "amazon.nova-lite-v1:0",
    titleModel: null,
    authMethods: [
      {
        "id": "aws_default",
        "type": "api",
        "label": "AWS default credentials",
        "fields": [
          {
            "id": "region",
            "label": "AWS region",
            "kind": "text",
            "placeholder": "us-east-1"
          }
        ]
      },
      {
        "id": "aws_profile",
        "type": "api",
        "label": "AWS profile",
        "fields": [
          {
            "id": "profile",
            "label": "AWS profile",
            "kind": "text",
            "required": true,
            "placeholder": "default"
          },
          {
            "id": "region",
            "label": "AWS region",
            "kind": "text",
            "placeholder": "us-east-1"
          }
        ]
      },
      {
        "id": "aws_keys",
        "type": "api",
        "label": "AWS access keys",
        "fields": [
          {
            "id": "accessKeyId",
            "label": "Access key ID",
            "kind": "text",
            "required": true,
            "placeholder": "AKIA..."
          },
          {
            "id": "secretAccessKey",
            "label": "Secret access key",
            "kind": "password",
            "required": true,
            "secret": true
          },
          {
            "id": "sessionToken",
            "label": "Session token",
            "kind": "password",
            "secret": true
          },
          {
            "id": "region",
            "label": "AWS region",
            "kind": "text",
            "required": true,
            "placeholder": "us-east-1"
          }
        ]
      },
      {
        "id": "api_key",
        "type": "api",
        "label": "Bedrock API key",
        "fields": [
          {
            "id": "apiKey",
            "label": "Bedrock API key",
            "kind": "password",
            "required": true,
            "secret": true
          },
          {
            "id": "region",
            "label": "AWS region",
            "kind": "text",
            "required": true,
            "placeholder": "us-east-1"
          }
        ]
      }
    ],
  },
  "baseten": {
    displayName: "Baseten",
    transport: "chat-completions",
    userFacing: false,
    discovery: "api",
    defaultModel: "moonshotai/Kimi-K2.5",
    titleModel: "moonshotai/Kimi-K2.5",
    authMethods: [
      {
        "id": "api_key",
        "type": "api",
        "label": "API key"
      }
    ],
  },
  "together": {
    displayName: "Together AI",
    transport: "chat-completions",
    userFacing: true,
    discovery: "api",
    defaultModel: "moonshotai/Kimi-K2.5",
    titleModel: "moonshotai/Kimi-K2.5",
    authMethods: [
      {
        "id": "api_key",
        "type": "api",
        "label": "API key"
      }
    ],
  },
  "fireworks": {
    displayName: "Fireworks AI",
    transport: "chat-completions",
    userFacing: true,
    discovery: "api",
    defaultModel: "accounts/fireworks/models/kimi-k2p6",
    titleModel: "accounts/fireworks/models/kimi-k2p6",
    authMethods: [
      {
        "id": "api_key",
        "type": "api",
        "label": "API key"
      }
    ],
  },
  "firepass": {
    displayName: "Fire Pass",
    transport: "chat-completions",
    userFacing: true,
    discovery: "api",
    defaultModel: "accounts/fireworks/routers/kimi-k2p6-turbo",
    titleModel: "accounts/fireworks/routers/kimi-k2p6-turbo",
    authMethods: [
      {
        "id": "api_key",
        "type": "api",
        "label": "Fire Pass API key"
      }
    ],
  },
  "nvidia": {
    displayName: "NVIDIA",
    transport: "chat-completions",
    userFacing: true,
    discovery: "api",
    defaultModel: "nvidia/nemotron-3-super-120b-a12b",
    titleModel: "nvidia/nemotron-3-super-120b-a12b",
    authMethods: [
      {
        "id": "api_key",
        "type": "api",
        "label": "API key"
      }
    ],
  },
  "lmstudio": {
    displayName: "LM Studio",
    transport: "chat-completions",
    userFacing: true,
    discovery: "local",
    defaultModel: "local-model",
    titleModel: null,
    authMethods: [
      {
        "id": "api_key",
        "type": "api",
        "label": "API token (optional)"
      }
    ],
  },
  "minimax": {
    displayName: "MiniMax",
    transport: "chat-completions",
    userFacing: true,
    discovery: "api",
    defaultModel: "MiniMax-M3",
    titleModel: null,
    authMethods: [
      {
        "id": "api_key",
        "type": "api",
        "label": "API key"
      }
    ],
  },
  "opencode-go": {
    displayName: "OpenCode Go",
    transport: "chat-completions",
    userFacing: true,
    discovery: "api",
    defaultModel: "glm-5",
    titleModel: "glm-5",
    authMethods: [
      {
        "id": "api_key",
        "type": "api",
        "label": "API key"
      }
    ],
  },
  "opencode-zen": {
    displayName: "OpenCode Zen",
    transport: "chat-completions",
    userFacing: true,
    discovery: "api",
    defaultModel: "glm-5",
    titleModel: "glm-5",
    authMethods: [
      {
        "id": "api_key",
        "type": "api",
        "label": "API key"
      }
    ],
  },
  "codex-cli": {
    displayName: "Codex",
    transport: "codex-app-server",
    userFacing: true,
    discovery: "static",
    defaultModel: "gpt-5.6-sol",
    titleModel: "gpt-5.4-mini",
    authMethods: [
      {
        "id": "oauth_cli",
        "type": "oauth",
        "label": "Sign in with ChatGPT (browser)",
        "oauthMode": "auto"
      }
    ],
  },
};
