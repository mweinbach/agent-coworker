import type { AiCoworkerPaths, ConnectProviderResult, OauthStdioMode } from "../connect";
import { PROVIDER_NAMES, type ProviderName } from "../types";

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
  apiKey?: string;
  cwd?: string;
  paths?: AiCoworkerPaths;
  oauthStdioMode?: OauthStdioMode;
  allowOpenTerminal?: boolean;
  onOauthLine?: (line: string) => void;
}) => Promise<ConnectProviderResult>;

const PROVIDER_AUTH_METHODS: Record<ProviderName, ProviderAuthMethod[]> = {
  google: [{ id: "api_key", type: "api", label: "API key" }],
  openai: [{ id: "api_key", type: "api", label: "API key" }],
  anthropic: [{ id: "api_key", type: "api", label: "API key" }],
  "codex-cli": [
    { id: "oauth_cli", type: "oauth", label: "Sign in with ChatGPT (browser)", oauthMode: "auto" },
    { id: "oauth_device", type: "oauth", label: "Sign in with ChatGPT (device code)", oauthMode: "auto" },
    { id: "api_key", type: "api", label: "API key" },
  ],
  "claude-code": [
    { id: "oauth_cli", type: "oauth", label: "Sign in with Claude Code", oauthMode: "auto" },
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
    const isDeviceCode = opts.methodId === "oauth_device";
    return {
      ok: true,
      challenge: {
        method: method.oauthMode ?? "auto",
        instructions: isDeviceCode
          ? "Use the device-code flow. A one-time code will be generated when you continue."
          : "Continue to open browser-based ChatGPT OAuth and finish sign-in.",
        url: isDeviceCode ? "https://auth.openai.com/codex/device" : "https://auth.openai.com/oauth/authorize",
      },
    };
  }

  if (opts.provider === "claude-code") {
    return {
      ok: true,
      challenge: {
        method: method.oauthMode ?? "auto",
        instructions: "Run Claude Code sign-in in a terminal, then continue.",
        command: "claude setup-token",
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
}): Promise<ConnectProviderResult> {
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

  return await opts.connect({
    provider: opts.provider,
    apiKey,
    cwd: opts.cwd,
    paths: opts.paths,
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
  allowOpenTerminal?: boolean;
  onOauthLine?: (line: string) => void;
}): Promise<ConnectProviderResult> {
  const method = resolveProviderAuthMethod(opts.provider, opts.methodId);
  if (!method) {
    return { ok: false, provider: opts.provider, message: `Unsupported auth method "${opts.methodId}".` };
  }
  if (method.type !== "oauth") {
    return { ok: false, provider: opts.provider, message: `Method "${opts.methodId}" is not an OAuth method.` };
  }
  if (method.oauthMode === "code" && !opts.code?.trim()) {
    return { ok: false, provider: opts.provider, message: "Authorization code is required." };
  }

  return await opts.connect({
    provider: opts.provider,
    methodId: opts.methodId,
    cwd: opts.cwd,
    paths: opts.paths,
    oauthStdioMode: opts.oauthStdioMode,
    allowOpenTerminal: opts.allowOpenTerminal,
    onOauthLine: opts.onOauthLine,
  });
}
