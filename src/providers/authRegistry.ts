import {
  type AiCoworkerPaths,
  type ConnectProviderResult,
  type DisconnectProviderResult,
  disconnectProvider,
  getAiCoworkerPaths,
  type OauthStdioMode,
  readConnectionStore,
  saveProviderConnectionConfig,
  writeToolApiKey,
} from "../connect";
import {
  getDefaultProviderAuthMethods,
  listDefaultProviderAuthMethods,
  type ProviderAuthFieldKind,
  type ProviderAuthMethod,
  type ProviderAuthMethodField,
  type ProviderAuthMethodType,
} from "../shared/providerAuthMethods";
import type { ProviderName } from "../types";
import { resolveAuthHomeDir } from "../utils/authHome";

export type {
  ProviderAuthFieldKind,
  ProviderAuthMethod,
  ProviderAuthMethodField,
  ProviderAuthMethodType,
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
export function listProviderAuthMethods(): Record<string, ProviderAuthMethod[]> {
  return listDefaultProviderAuthMethods();
}

export function resolveProviderAuthMethod(
  provider: ProviderName,
  methodId: string,
): ProviderAuthMethod | null {
  const methods = getDefaultProviderAuthMethods(provider);
  return methods.find((m) => m.id === methodId) ?? null;
}

export function requiresProviderAuthCode(provider: ProviderName, methodId: string): boolean {
  const method = resolveProviderAuthMethod(provider, methodId);
  return method?.type === "oauth" && method.oauthMode === "code";
}

function normalizeFieldValues(
  method: ProviderAuthMethod,
  values: Record<string, string>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  const allowedFields = new Set((method.fields ?? []).map((field) => field.id));
  for (const [rawKey, rawValue] of Object.entries(values)) {
    const key = rawKey.trim();
    if (!key || (allowedFields.size > 0 && !allowedFields.has(key))) continue;
    normalized[key] = rawValue.trim();
  }
  return normalized;
}

function validateStructuredProviderConfig(
  provider: ProviderName,
  method: ProviderAuthMethod,
  values: Record<string, string>,
): string | null {
  const normalized = normalizeFieldValues(method, values);
  for (const field of method.fields ?? []) {
    if (field.required && !normalized[field.id]) {
      return `${field.label} is required.`;
    }
  }
  if (provider !== "bedrock") return null;

  if (method.id === "aws_default") {
    return null;
  }
  if (method.id === "aws_profile" && !normalized.profile) {
    return "AWS profile is required.";
  }
  if (method.id === "aws_keys") {
    if (!normalized.accessKeyId) return "Access key ID is required.";
    if (!normalized.secretAccessKey) return "Secret access key is required.";
    if (!normalized.region) return "AWS region is required.";
  }
  if (method.id === "api_key") {
    if (!normalized.apiKey) return "Bedrock API key is required.";
    if (!normalized.region) return "AWS region is required.";
  }
  return null;
}

export function authorizeProviderAuth(opts: {
  provider: ProviderName;
  methodId: string;
}): { ok: true; challenge: ProviderAuthChallenge } | { ok: false; message: string } {
  const method = resolveProviderAuthMethod(opts.provider, opts.methodId);
  if (!method) {
    return {
      ok: false,
      message: `Unsupported auth method "${opts.methodId}" for ${opts.provider}.`,
    };
  }
  if (method.type !== "oauth") {
    return { ok: false, message: `Auth method "${opts.methodId}" does not support authorization.` };
  }

  if (opts.provider === "codex-cli") {
    return {
      ok: true,
      challenge: {
        method: method.oauthMode ?? "auto",
        instructions:
          "Continue to browser-based ChatGPT sign-in. Cowork will open the official Codex OAuth flow and save the returned token locally.",
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
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: resolveAuthHomeDir() });
  const method = resolveProviderAuthMethod(opts.provider, opts.methodId);
  if (!method) {
    return {
      ok: false,
      provider: opts.provider,
      message: `Unsupported auth method "${opts.methodId}".`,
    };
  }
  if (method.type !== "api") {
    return {
      ok: false,
      provider: opts.provider,
      message: `Method "${opts.methodId}" is not an API key method.`,
    };
  }
  if (
    (method.fields?.length ?? 0) > 0 &&
    !(opts.provider === "google" && method.id === "exa_api_key")
  ) {
    return {
      ok: false,
      provider: opts.provider,
      message: `Method "${opts.methodId}" requires structured credential fields and cannot be saved as a raw API key.`,
    };
  }
  const apiKey = opts.apiKey.trim();
  if (!apiKey) {
    return { ok: false, provider: opts.provider, message: "API key is required." };
  }

  if (
    opts.provider === "google" &&
    (method.id === "exa_api_key" || method.id === "parallel_api_key")
  ) {
    try {
      const toolName = method.id === "parallel_api_key" ? "parallel" : "exa";
      const providerLabel = method.id === "parallel_api_key" ? "Parallel" : "Exa";
      const saved = await writeToolApiKey({
        name: toolName,
        apiKey,
        paths,
      });
      return {
        ok: true,
        provider: opts.provider,
        mode: "api_key",
        storageFile: saved.storageFile,
        message: `${providerLabel} API key saved for web search.`,
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

  return await opts.connect({
    provider: opts.provider,
    apiKey,
    cwd: opts.cwd,
    paths,
  });
}

export async function setProviderConfig(opts: {
  provider: ProviderName;
  methodId: string;
  values: Record<string, string>;
  paths?: AiCoworkerPaths;
}): Promise<ConnectProviderResult> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: resolveAuthHomeDir() });
  const method = resolveProviderAuthMethod(opts.provider, opts.methodId);
  if (!method) {
    return {
      ok: false,
      provider: opts.provider,
      message: `Unsupported auth method "${opts.methodId}".`,
    };
  }
  if (method.type !== "api") {
    return {
      ok: false,
      provider: opts.provider,
      message: `Method "${opts.methodId}" is not a credential method.`,
    };
  }
  if ((method.fields?.length ?? 0) === 0) {
    return {
      ok: false,
      provider: opts.provider,
      message: `Method "${opts.methodId}" does not define structured fields.`,
    };
  }

  const normalized = normalizeFieldValues(method, opts.values);
  const validationError = validateStructuredProviderConfig(opts.provider, method, normalized);
  if (validationError) {
    return { ok: false, provider: opts.provider, message: validationError };
  }

  return await saveProviderConnectionConfig({
    provider: opts.provider,
    methodId: opts.methodId,
    values: normalized,
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
    return {
      ok: false,
      provider: opts.provider,
      message: `Unsupported auth method "${opts.methodId}".`,
    };
  }
  if (method.type !== "api") {
    return {
      ok: false,
      provider: opts.provider,
      message: `Method "${opts.methodId}" is not an API key method.`,
    };
  }

  const store = await readConnectionStore(paths);
  const targetEntry = store.services[opts.provider];
  const targetApiKey = targetEntry?.mode === "api_key" ? (targetEntry.apiKey?.trim() ?? "") : "";
  if (targetApiKey) {
    return {
      ok: false,
      provider: opts.provider,
      message: `${opts.provider} already has a saved API key.`,
    };
  }
  const sourceEntry = store.services[opts.sourceProvider];
  const apiKey = sourceEntry?.mode === "api_key" ? (sourceEntry.apiKey?.trim() ?? "") : "";
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
    return {
      ok: false,
      provider: opts.provider,
      message: `Unsupported auth method "${opts.methodId}".`,
    };
  }
  if (method.type !== "oauth") {
    return {
      ok: false,
      provider: opts.provider,
      message: `Method "${opts.methodId}" is not an OAuth method.`,
    };
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
