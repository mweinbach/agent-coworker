import type { AgentConfig } from "../types";

type MaybeEnv = Record<string, string | undefined> | NodeJS.ProcessEnv;

export type AwsBedrockProxyDiscoveredModel = {
  id: string;
  displayName: string;
  supportsImageInput: boolean;
  knowledgeCutoff: "Unknown";
};

export type AwsBedrockProxyModelDiscoveryFailureCode =
  | "missing_base_url"
  | "unauthorized"
  | "http_error"
  | "invalid_payload"
  | "no_models"
  | "network_error"
  | "timeout";

export type AwsBedrockProxyModelDiscoveryResult =
  | {
      ok: true;
      models: AwsBedrockProxyDiscoveredModel[];
    }
  | {
      ok: false;
      code: AwsBedrockProxyModelDiscoveryFailureCode;
      message: string;
      status?: number;
    };

const DEFAULT_DISCOVERY_TIMEOUT_MS = 7_500;

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.search || url.hash) return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function titleCaseSegment(value: string): string {
  if (!value) return value;
  return value
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function displayNameForModelId(modelId: string): string {
  const compact = modelId.trim();
  if (!compact) return modelId;
  const vendorSplit = compact.split("/");
  const base = vendorSplit[vendorSplit.length - 1] ?? compact;
  return titleCaseSegment(base);
}

function isSelectableModelId(modelId: string): boolean {
  return modelId !== "*";
}

function supportsImageByMetadata(rawModel: Record<string, unknown>): boolean {
  const modalities = Array.isArray(rawModel.modalities) ? rawModel.modalities : [];
  if (modalities.some((entry) => typeof entry === "string" && entry.toLowerCase().includes("image"))) {
    return true;
  }

  const inputModalities = Array.isArray(rawModel.input_modalities) ? rawModel.input_modalities : [];
  if (inputModalities.some((entry) => typeof entry === "string" && entry.toLowerCase().includes("image"))) {
    return true;
  }

  const id = asNonEmptyString(rawModel.id)?.toLowerCase() ?? "";
  return id.includes("vision") || id.includes("multimodal");
}

function parseDiscoveredModels(raw: unknown): { models: AwsBedrockProxyDiscoveredModel[]; malformed: boolean } {
  if (typeof raw !== "object" || raw === null) {
    return { models: [], malformed: true };
  }
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.data)) {
    return { models: [], malformed: true };
  }

  const models = record.data
    .map((entry) => (typeof entry === "object" && entry !== null ? entry as Record<string, unknown> : null))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      id: asNonEmptyString(entry.id) ?? "",
      supportsImageInput: supportsImageByMetadata(entry),
    }))
    .filter((entry) => entry.id.length > 0 && isSelectableModelId(entry.id));

  if (models.length === 0) return { models: [], malformed: false };

  const uniqueById = new Map<string, { id: string; supportsImageInput: boolean }>();
  for (const model of models) {
    const existing = uniqueById.get(model.id);
    if (!existing || (!existing.supportsImageInput && model.supportsImageInput)) {
      uniqueById.set(model.id, model);
    }
  }

  return {
    malformed: false,
    models: [...uniqueById.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((entry) => ({
        id: entry.id,
        displayName: displayNameForModelId(entry.id),
        supportsImageInput: entry.supportsImageInput,
        knowledgeCutoff: "Unknown" as const,
      })),
  };
}

function trimMessage(value: string, max = 200): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}...`;
}

function parseDiscoveryErrorBody(rawText: string): string | null {
  const text = rawText.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string") return trimMessage(parsed);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return trimMessage(record.message);
    const error = record.error;
    if (typeof error === "string" && error.trim()) return trimMessage(error);
    if (typeof error === "object" && error !== null) {
      const errorRecord = error as Record<string, unknown>;
      if (typeof errorRecord.message === "string" && errorRecord.message.trim()) return trimMessage(errorRecord.message);
      if (typeof errorRecord.detail === "string" && errorRecord.detail.trim()) return trimMessage(errorRecord.detail);
    }
    return null;
  } catch {
    return trimMessage(text);
  }
}

export function formatAwsBedrockProxyDiscoveryFailure(
  failure: Extract<AwsBedrockProxyModelDiscoveryResult, { ok: false }>,
): string {
  if (failure.code === "missing_base_url") {
    return "Set the AWS Bedrock Proxy URL before saving a proxy token.";
  }
  if (failure.code === "unauthorized") {
    const detail = failure.message.trim();
    if (detail) return `Proxy token rejected by /models (${detail}).`;
    return "Proxy token rejected by /models (401/403).";
  }
  if (failure.code === "http_error") {
    const suffix = failure.status ? ` (${failure.status})` : "";
    const detail = failure.message.trim();
    return detail
      ? `Proxy /models request failed${suffix}: ${detail}`
      : `Proxy /models request failed${suffix}.`;
  }
  if (failure.code === "invalid_payload") {
    return "Proxy /models returned an invalid payload.";
  }
  if (failure.code === "no_models") {
    return "Proxy /models returned no usable models.";
  }
  if (failure.code === "timeout") {
    return "Proxy /models request timed out.";
  }
  return "Proxy /models request failed. Check proxy URL and token.";
}

export function resolveAwsBedrockProxyApiKey(opts: {
  savedKey?: string;
  env?: MaybeEnv;
} = {}): string | undefined {
  const savedKey = opts.savedKey?.trim();
  if (savedKey) return savedKey;
  const env = opts.env ?? process.env;
  const envValue = env.AWS_BEDROCK_PROXY_API_KEY?.trim() || env.OPENAI_PROXY_API_KEY?.trim();
  return envValue || undefined;
}

function providerOptionsBaseUrl(config: AgentConfig | undefined): string | undefined {
  const options = config?.providerOptions;
  if (!options || typeof options !== "object") return undefined;
  const root = options as Record<string, unknown>;
  const aws = root["aws-bedrock-proxy"];
  if (aws && typeof aws === "object" && !Array.isArray(aws)) {
    const baseUrl = asNonEmptyString((aws as Record<string, unknown>).baseUrl);
    if (baseUrl) return baseUrl;
  }
  const legacy = root["openai-proxy"];
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    const baseUrl = asNonEmptyString((legacy as Record<string, unknown>).baseUrl);
    if (baseUrl) return baseUrl;
  }
  return undefined;
}

export function resolveAwsBedrockProxyBaseUrl(opts: {
  baseUrl?: string;
  config?: AgentConfig;
  providerOptions?: unknown;
  env?: MaybeEnv;
} = {}): string | undefined {
  if (opts.baseUrl) {
    const normalized = normalizeBaseUrl(opts.baseUrl);
    if (normalized) return normalized;
  }

  const options = opts.providerOptions ?? opts.config?.providerOptions;
  if (options && typeof options === "object" && !Array.isArray(options)) {
    const root = options as Record<string, unknown>;
    const fromAws = root["aws-bedrock-proxy"];
    if (fromAws && typeof fromAws === "object" && !Array.isArray(fromAws)) {
      const normalized = normalizeBaseUrl(String((fromAws as Record<string, unknown>).baseUrl ?? ""));
      if (normalized) return normalized;
    }
    const fromLegacy = root["openai-proxy"];
    if (fromLegacy && typeof fromLegacy === "object" && !Array.isArray(fromLegacy)) {
      const normalized = normalizeBaseUrl(String((fromLegacy as Record<string, unknown>).baseUrl ?? ""));
      if (normalized) return normalized;
    }
  }

  const configValue =
    asNonEmptyString((opts.config as { awsBedrockProxyBaseUrl?: unknown } | undefined)?.awsBedrockProxyBaseUrl)
    || asNonEmptyString((opts.config as { openaiProxyBaseUrl?: unknown } | undefined)?.openaiProxyBaseUrl)
    || providerOptionsBaseUrl(opts.config);
  if (configValue) {
    const normalized = normalizeBaseUrl(configValue);
    if (normalized) return normalized;
  }

  const env = opts.env ?? process.env;
  const envValue = env.AWS_BEDROCK_PROXY_BASE_URL || env.OPENAI_PROXY_BASE_URL;
  if (!envValue) return undefined;
  return normalizeBaseUrl(envValue) ?? undefined;
}

export function awsBedrockProxyForcedHeaders(): Record<string, string> {
  return {
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
  };
}

export async function discoverAwsBedrockProxyModels(opts: {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<AwsBedrockProxyDiscoveredModel[]> {
  const result = await discoverAwsBedrockProxyModelsDetailed(opts);
  if (!result.ok) {
    console.warn(
      `[aws-bedrock-proxy] discoverAwsBedrockProxyModels returning [] after ${result.code}: ${result.message}`,
    );
  }
  return result.ok ? result.models : [];
}

export async function discoverAwsBedrockProxyModelsDetailed(opts: {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<AwsBedrockProxyModelDiscoveryResult> {
  const baseUrl = opts.baseUrl;
  if (!baseUrl) {
    return {
      ok: false,
      code: "missing_base_url",
      message: "Missing AWS Bedrock Proxy base URL.",
    };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      ...awsBedrockProxyForcedHeaders(),
    };
    const apiKey = opts.apiKey?.trim();
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const response = await fetchImpl(`${baseUrl}/models`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      const rawText = await response.text().catch(() => "");
      const detail = parseDiscoveryErrorBody(rawText) ?? trimMessage(response.statusText || "");
      return {
        ok: false,
        code: response.status === 401 || response.status === 403 ? "unauthorized" : "http_error",
        status: response.status,
        message: detail,
      };
    }

    const body = await response.json().catch(() => undefined);
    const parsed = parseDiscoveredModels(body);
    if (parsed.malformed) {
      return {
        ok: false,
        code: "invalid_payload",
        message: "The /models response did not match the expected schema.",
      };
    }
    if (parsed.models.length === 0) {
      return {
        ok: false,
        code: "no_models",
        message: "The /models response included no usable model ids.",
      };
    }

    return {
      ok: true,
      models: parsed.models,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        ok: false,
        code: "timeout",
        message: "The /models request timed out.",
      };
    }
    return {
      ok: false,
      code: "network_error",
      message: trimMessage(error instanceof Error ? error.message : String(error)),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveAwsBedrockProxyDiscoveredModel(opts: {
  modelId: string;
  baseUrl?: string;
  apiKey?: string;
  providerOptions?: unknown;
  env?: MaybeEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<AwsBedrockProxyDiscoveredModel | null> {
  const modelId = asNonEmptyString(opts.modelId);
  if (!modelId) return null;

  const discovery = await discoverAwsBedrockProxyModelsDetailed({
    baseUrl: resolveAwsBedrockProxyBaseUrl({
      baseUrl: opts.baseUrl,
      providerOptions: opts.providerOptions,
      env: opts.env,
    }),
    apiKey: resolveAwsBedrockProxyApiKey({
      savedKey: opts.apiKey,
      env: opts.env,
    }),
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });

  if (!discovery.ok) return null;
  return discovery.models.find((model) => model.id === modelId) ?? null;
}
