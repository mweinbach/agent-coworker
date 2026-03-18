import type {
  LmStudioListModelsResponse,
  LmStudioLoadResponse,
  LmStudioProviderOptions,
  LmStudioUnloadResponse,
} from "./types";

export const DEFAULT_LM_STUDIO_BASE_URL = "http://localhost:1234";

export type LmStudioErrorCode =
  | "unreachable"
  | "http_error"
  | "invalid_response"
  | "missing_model"
  | "no_llms"
  | "load_failed"
  | "unload_failed";

export class LmStudioError extends Error {
  readonly code: LmStudioErrorCode;
  readonly baseUrl: string;
  readonly status?: number;

  constructor(opts: {
    code: LmStudioErrorCode;
    message: string;
    baseUrl: string;
    status?: number;
    cause?: unknown;
  }) {
    super(opts.message, "cause" in Error.prototype ? { cause: opts.cause } : undefined);
    this.name = "LmStudioError";
    this.code = opts.code;
    this.baseUrl = opts.baseUrl;
    this.status = opts.status;
  }
}

export function isLmStudioError(error: unknown): error is LmStudioError {
  return error instanceof LmStudioError;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : undefined;
  }
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) return undefined;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : undefined;
}

function normalizeLmStudioBaseUrl(raw?: string): string {
  const trimmed = raw?.trim() || DEFAULT_LM_STUDIO_BASE_URL;
  let normalized = trimmed.replace(/\/+$/, "");
  if (normalized.endsWith("/api/v1")) {
    normalized = normalized.slice(0, -"/api/v1".length);
  } else if (normalized.endsWith("/v1")) {
    normalized = normalized.slice(0, -"/v1".length);
  }
  return normalized || DEFAULT_LM_STUDIO_BASE_URL;
}

export type ResolvedLmStudioProviderOptions = {
  baseUrl: string;
  apiKey?: string;
  contextLength?: number;
  autoLoad: boolean;
  reloadOnContextMismatch: boolean;
};

export function resolveLmStudioProviderOptions(
  providerOptions: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedLmStudioProviderOptions {
  const root = asRecord(providerOptions);
  const section = asRecord(root?.lmstudio);
  const rawSection = (section ?? {}) as LmStudioProviderOptions;
  const baseUrl = normalizeLmStudioBaseUrl(
    asNonEmptyString(env.LM_STUDIO_BASE_URL)
    ?? asNonEmptyString(rawSection.baseUrl),
  );
  const apiKey =
    asNonEmptyString(env.LM_STUDIO_API_KEY)
    ?? asNonEmptyString(env.LM_STUDIO_API_TOKEN)
    ?? undefined;
  const contextLength =
    asPositiveInteger(env.LM_STUDIO_CONTEXT_LENGTH)
    ?? asPositiveInteger(rawSection.contextLength);
  const autoLoad =
    asBoolean(env.LM_STUDIO_AUTO_LOAD)
    ?? asBoolean(rawSection.autoLoad)
    ?? true;
  const reloadOnContextMismatch =
    asBoolean(env.LM_STUDIO_RELOAD_ON_CONTEXT_MISMATCH)
    ?? asBoolean(rawSection.reloadOnContextMismatch)
    ?? true;

  return {
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(contextLength ? { contextLength } : {}),
    autoLoad,
    reloadOnContextMismatch,
  };
}

export function lmStudioOpenAiBaseUrl(baseUrl: string): string {
  return `${normalizeLmStudioBaseUrl(baseUrl)}/v1`;
}

function nativeEndpoint(baseUrl: string, pathname: string): string {
  return `${normalizeLmStudioBaseUrl(baseUrl)}/api/v1${pathname}`;
}

function requestHeaders(baseUrl: string, apiKey?: string, json = true): HeadersInit {
  const headers: Record<string, string> = {};
  if (json) {
    headers.accept = "application/json";
    headers["content-type"] = "application/json";
  }
  const token = apiKey?.trim();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text ? text.slice(0, 400) : "";
  } catch {
    return "";
  }
}

async function requestJson<T>(opts: {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  pathname: string;
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
}): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = normalizeLmStudioBaseUrl(opts.baseUrl);
  const url = nativeEndpoint(baseUrl, opts.pathname);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: opts.method ?? "GET",
      headers: requestHeaders(baseUrl, opts.apiKey, true),
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch (error) {
    throw new LmStudioError({
      code: "unreachable",
      baseUrl,
      message: `LM Studio server is unreachable at ${baseUrl}.`,
      cause: error,
    });
  }

  if (!response.ok) {
    const body = await readErrorBody(response);
    throw new LmStudioError({
      code: "http_error",
      baseUrl,
      status: response.status,
      message: body
        ? `LM Studio request failed at ${url} (${response.status}): ${body}`
        : `LM Studio request failed at ${url} (${response.status}).`,
    });
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw new LmStudioError({
      code: "invalid_response",
      baseUrl,
      message: `LM Studio returned invalid JSON from ${url}.`,
      cause: error,
    });
  }

  return json as T;
}

export async function listLmStudioModels(opts: {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<LmStudioListModelsResponse> {
  return await requestJson<LmStudioListModelsResponse>({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
    pathname: "/models",
  });
}

export async function loadLmStudioModel(opts: {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  modelKey: string;
  contextLength?: number;
}): Promise<LmStudioLoadResponse> {
  try {
    return await requestJson<LmStudioLoadResponse>({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      fetchImpl: opts.fetchImpl,
      pathname: "/models/load",
      method: "POST",
      body: {
        model: opts.modelKey,
        ...(typeof opts.contextLength === "number" ? { context_length: opts.contextLength } : {}),
        echo_load_config: true,
      },
    });
  } catch (error) {
    if (isLmStudioError(error)) {
      throw new LmStudioError({
        code: error.code === "http_error" ? "load_failed" : error.code,
        baseUrl: error.baseUrl,
        status: error.status,
        message: error.message,
        cause: error,
      });
    }
    throw error;
  }
}

export async function unloadLmStudioModel(opts: {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  instanceId: string;
}): Promise<LmStudioUnloadResponse> {
  try {
    return await requestJson<LmStudioUnloadResponse>({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      fetchImpl: opts.fetchImpl,
      pathname: "/models/unload",
      method: "POST",
      body: {
        instance_id: opts.instanceId,
      },
    });
  } catch (error) {
    if (isLmStudioError(error)) {
      throw new LmStudioError({
        code: error.code === "http_error" ? "unload_failed" : error.code,
        baseUrl: error.baseUrl,
        status: error.status,
        message: error.message,
        cause: error,
      });
    }
    throw error;
  }
}

export function createLmStudioError(
  code: LmStudioErrorCode,
  message: string,
  baseUrl: string,
): LmStudioError {
  return new LmStudioError({ code, message, baseUrl: normalizeLmStudioBaseUrl(baseUrl) });
}
