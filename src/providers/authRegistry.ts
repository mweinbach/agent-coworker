import {
  getAiCoworkerPaths,
  disconnectProvider,
  readConnectionStore,
  writeToolApiKey,
  type AiCoworkerPaths,
  type ConnectProviderResult,
  type DisconnectProviderResult,
  type OauthStdioMode,
} from "../connect";
import {
  discoverAwsBedrockProxyModelsDetailed,
  formatAwsBedrockProxyDiscoveryFailure,
  resolveAwsBedrockProxyBaseUrl,
} from "./awsBedrockProxyShared";
import { PROVIDER_NAMES, type AgentConfig, type ProviderName } from "../types";
import { resolveAuthHomeDir } from "../utils/authHome";

export type ProviderAuthMethodType = "api" | "oauth";

export type ProviderAuthMethod = {
  id: string;
  type: ProviderAuthMethodType;
  label: string;
  oauthMode?: "auto" | "code";
};

export type ProviderAuthChallenge = {
  method: "auto" | "code";
  instructions: string;
  url?: string;
  command?: string;
};

export type ConnectProviderHandler = (opts: {
  provider: ProviderName;
  methodId?: string;
  code?: string;
  apiKey?: string;
  cwd?: string;
  paths?: AiCoworkerPaths;
  oauthStdioMode?: OauthStdioMode;
  onOauthLine?: (line: string) => void;
}) => Promise<ConnectProviderResult>;

export type DisconnectProviderHandler = (opts: {
  provider: ProviderName;
  paths?: AiCoworkerPaths;
}) => Promise<DisconnectProviderResult>;

const PROVIDER_AUTH_METHODS: Record<ProviderName, ProviderAuthMethod[]> = {
  google: [
    { id: "api_key", type: "api", label: "API key" },
    { id: "exa_api_key", type: "api", label: "Exa API key (web search)" },
  ],
  "aws-bedrock-proxy": [{ id: "api_key", type: "api", label: "API key" }],
  openai: [{ id: "api_key", type: "api", label: "API key" }],
  anthropic: [{ id: "api_key", type: "api", label: "API key" }],
  baseten: [{ id: "api_key", type: "api", label: "API key" }],
  together: [{ id: "api_key", type: "api", label: "API key" }],
  nvidia: [{ id: "api_key", type: "api", label: "API key" }],
  lmstudio: [{ id: "api_key", type: "api", label: "API token (optional)" }],
  "opencode-go": [{ id: "api_key", type: "api", label: "API key" }],
  "opencode-zen": [{ id: "api_key", type: "api", label: "API key" }],
  "codex-cli": [
    { id: "oauth_cli", type: "oauth", label: "Sign in with ChatGPT (browser)", oauthMode: "auto" },
    { id: "api_key", type: "api", label: "API key" },
  ],
};

export function listProviderAuthMethods(): Record<string, ProviderAuthMethod[]> {
  const out: Record<string, ProviderAuthMethod[]> = {};
  for (const provider of PROVIDER_NAMES) out[provider] = [...PROVIDER_AUTH_METHODS[provider]];
  return out;
}

export function resolveProviderAuthMethod(provider: ProviderName, methodId: string): ProviderAuthMethod | null {
  const methods = PROVIDER_AUTH_METHODS[provider] ?? [];
  return methods.find((m) => m.id === methodId) ?? null;
}

export function requiresProviderAuthCode(provider: ProviderName, methodId: string): boolean {
  const method = resolveProviderAuthMethod(provider, methodId);
  return method?.type === "oauth" && method.oauthMode === "code";
}

export function authorizeProviderAuth(opts: {
  provider: ProviderName;
  methodId: string;
}): { ok: true; challenge: ProviderAuthChallenge } | { ok: false; message: string } {
  const method = resolveProviderAuthMethod(opts.provider, opts.methodId);
  if (!method) {
    return { ok: false, message: `Unsupported auth method "${opts.methodId}" for ${opts.provider}.` };
  }
  if (method.type !== "oauth") {
    return { ok: false, message: `Auth method "${opts.methodId}" does not support authorization.` };
  }

  if (opts.provider === "codex-cli") {
    return {
      ok: true,
      challenge: {
        method: method.oauthMode ?? "auto",
        instructions: "Continue to browser-based ChatGPT sign-in. Cowork will open the official Codex OAuth flow and save the returned token locally.",
      },
    };
  }

  return { ok: false, message: `Provider ${opts.provider} does not support OAuth authorization.` };
}

export async function setProviderApiKey(opts: {
  provider: ProviderName;
  methodId: string;
  apiKey: string;
  cwd?: string;
  paths?: AiCoworkerPaths;
  connect: ConnectProviderHandler;
  config?: AgentConfig;
  providerOptions?: unknown;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<ConnectProviderResult> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: resolveAuthHomeDir() });
  const method = resolveProviderAuthMethod(opts.provider, opts.methodId);
  if (!method) {
    return { ok: false, provider: opts.provider, message: `Unsupported auth method "${opts.methodId}".` };
  }
  if (method.type !== "api") {
    return { ok: false, provider: opts.provider, message: `Method "${opts.methodId}" is not an API key method.` };
  }
  const apiKey = opts.apiKey.trim();
  if (!apiKey) {
    return { ok: false, provider: opts.provider, message: "API key is required." };
  }

  if (opts.provider === "google" && method.id === "exa_api_key") {
    try {
      const saved = await writeToolApiKey({
        name: "exa",
        apiKey,
        paths,
      });
      return {
        ok: true,
        provider: opts.provider,
        mode: "api_key",
        storageFile: saved.storageFile,
        message: "Exa API key saved for Google webSearch.",
        maskedApiKey: saved.maskedApiKey,
      };
    } catch (error) {
      return {
        ok: false,
        provider: opts.provider,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (opts.provider === "aws-bedrock-proxy" && method.id === "api_key") {
    const baseUrl = resolveAwsBedrockProxyBaseUrl({
      config: opts.config,
      providerOptions: opts.providerOptions,
      env: opts.env ?? process.env,
    });
    const validation = await discoverAwsBedrockProxyModelsDetailed({
      baseUrl,
      apiKey,
      fetchImpl: opts.fetchImpl,
    });
    if (!validation.ok) {
      const detail = formatAwsBedrockProxyDiscoveryFailure(validation);
      const guidance = validation.code === "unauthorized"
        ? " Use your LiteLLM proxy token, not an upstream OpenAI/Anthropic key like sk-..."
        : "";
      return {
        ok: false,
        provider: opts.provider,
        message: `${detail}${guidance}`,
      };
    }
  }

  return await opts.connect({
    provider: opts.provider,
    apiKey,
    cwd: opts.cwd,
    paths,
  });
}

export async function copyProviderApiKey(opts: {
  provider: ProviderName;
  sourceProvider: ProviderName;
  methodId: string;
  cwd?: string;
  paths?: AiCoworkerPaths;
  connect: ConnectProviderHandler;
}): Promise<ConnectProviderResult> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: resolveAuthHomeDir() });
  const method = resolveProviderAuthMethod(opts.provider, opts.methodId);
  if (!method) {
    return { ok: false, provider: opts.provider, message: `Unsupported auth method "${opts.methodId}".` };
  }
  if (method.type !== "api") {
    return { ok: false, provider: opts.provider, message: `Method "${opts.methodId}" is not an API key method.` };
  }

  const store = await readConnectionStore(paths);
  const targetEntry = store.services[opts.provider];
  const targetApiKey = targetEntry?.mode === "api_key" ? targetEntry.apiKey?.trim() ?? "" : "";
  if (targetApiKey) {
    return {
      ok: false,
      provider: opts.provider,
      message: `${opts.provider} already has a saved API key.`,
    };
  }
  const sourceEntry = store.services[opts.sourceProvider];
  const apiKey = sourceEntry?.mode === "api_key" ? sourceEntry.apiKey?.trim() ?? "" : "";
  if (!apiKey) {
    return {
      ok: false,
      provider: opts.provider,
      message: `No saved API key found for ${opts.sourceProvider}.`,
    };
  }

  return await opts.connect({
    provider: opts.provider,
    apiKey,
    cwd: opts.cwd,
    paths,
  });
}

export async function callbackProviderAuth(opts: {
  provider: ProviderName;
  methodId: string;
  code?: string;
  cwd?: string;
  paths?: AiCoworkerPaths;
  connect: ConnectProviderHandler;
  oauthStdioMode?: OauthStdioMode;
  onOauthLine?: (line: string) => void;
}): Promise<ConnectProviderResult> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: resolveAuthHomeDir() });
  const method = resolveProviderAuthMethod(opts.provider, opts.methodId);
  if (!method) {
    return { ok: false, provider: opts.provider, message: `Unsupported auth method "${opts.methodId}".` };
  }
  if (method.type !== "oauth") {
    return { ok: false, provider: opts.provider, message: `Method "${opts.methodId}" is not an OAuth method.` };
  }
  const code = opts.code?.trim();
  if (method.oauthMode === "code" && !code) {
    return { ok: false, provider: opts.provider, message: "Authorization code is required." };
  }
  if (method.oauthMode !== "code" && code) {
    return {
      ok: false,
      provider: opts.provider,
      message: `Method "${opts.methodId}" manages OAuth in-app and does not accept a pasted authorization code.`,
    };
  }

  return await opts.connect({
    provider: opts.provider,
    methodId: opts.methodId,
    code,
    cwd: opts.cwd,
    paths,
    oauthStdioMode: opts.oauthStdioMode,
    onOauthLine: opts.onOauthLine,
  });
}

export async function logoutProviderAuth(opts: {
  provider: ProviderName;
  paths?: AiCoworkerPaths;
  disconnect?: DisconnectProviderHandler;
}): Promise<DisconnectProviderResult> {
  const disconnect = opts.disconnect ?? disconnectProvider;
  return await disconnect({
    provider: opts.provider,
    paths: opts.paths ?? getAiCoworkerPaths({ homedir: resolveAuthHomeDir() }),
  });
}
