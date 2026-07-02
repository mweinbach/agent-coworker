import {
  defaultSupportedModel,
  listSupportedModels,
  type SupportedModel,
} from "../models/registry";
import {
  GOOGLE_DYNAMIC_REASONING_EFFORT,
  listGoogleReasoningEffortValuesForModel,
} from "../shared/googleThinking";
import { DEFAULT_OPENAI_REASONING_EFFORT_VALUES } from "../shared/openaiCompatibleOptions";
import { asArray, asFiniteNumber, asNonEmptyString, asRecord } from "../shared/recordParsing";
import type { AiCoworkerPaths } from "../store/connections";
import type { ProviderName } from "../types";
import { readBedrockCatalogSnapshot, refreshBedrockDiscoveryCache } from "./bedrockShared";
import { openAiReasoningConfigForSupportedModel } from "./catalog";
import { type CodexAppServerModel, listCodexAppServerModels } from "./codexAppServerAuth";
import {
  listLmStudioLlms,
  mapLmStudioModelToResolvedMetadata,
  selectDefaultLmStudioModel,
} from "./lmstudio/catalog";
import { listLmStudioModels } from "./lmstudio/client";
import type {
  CachedModelDiscoveryModel,
  ModelDiscoveryAdapter,
  ModelDiscoveryResult,
  ModelDiscoverySource,
} from "./modelDiscoveryCache";

type StaticProvider = Exclude<ProviderName, "lmstudio">;
type OpenAiCompatibleModelListProvider = Extract<
  ProviderName,
  | "openai"
  | "baseten"
  | "together"
  | "fireworks"
  | "firepass"
  | "nvidia"
  | "minimax"
  | "opencode-go"
  | "opencode-zen"
>;

const GOOGLE_MODEL_LIST_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const ANTHROPIC_MODEL_LIST_URL = "https://api.anthropic.com/v1/models";
const MAX_PAGINATED_MODEL_LIST_PAGES = 20;
const MODEL_ID_DENY_PATTERN =
  /(embedding|embed|rerank|whisper|tts|text[-_ ]?to[-_ ]?speech|speech|audio|transcrib|image|imagen|dall[-_ ]?e|moderation|guard|safety|stable[-_ ]?diffusion|flux|veo|lyria|aqa|bison)/i;

function modelReasoning(model: CodexAppServerModel): CachedModelDiscoveryModel["reasoning"] {
  const availableEfforts = model.reasoningEfforts;
  const defaultEffort = model.reasoningDefaultEffort;
  if (!availableEfforts?.length && !defaultEffort) return undefined;
  return {
    ...(defaultEffort ? { defaultEffort } : {}),
    ...(availableEfforts?.length ? { availableEfforts } : {}),
  };
}

export function codexAppServerModelToCachedModel(
  model: CodexAppServerModel,
): CachedModelDiscoveryModel {
  const reasoning = modelReasoning(model);
  return {
    id: model.model || model.id,
    model: model.model || model.id,
    displayName: model.displayName || model.model || model.id,
    ...(model.description ? { description: model.description } : {}),
    ...(model.supportsImageInput !== undefined
      ? { supportsImageInput: model.supportsImageInput }
      : {}),
    ...(model.isDefault ? { isDefault: true } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(model.runtimeOptions ? { runtimeOptions: model.runtimeOptions } : {}),
    ...(model.runtimeOverrides ? { runtimeOverrides: model.runtimeOverrides } : {}),
  };
}

export async function discoverCodexAppServerModels(opts: {
  codexHome?: string;
  listCodexAppServerModelsImpl?: typeof listCodexAppServerModels;
  signal?: AbortSignal;
}): Promise<ModelDiscoveryResult> {
  opts.signal?.throwIfAborted();
  const listModels = opts.listCodexAppServerModelsImpl ?? listCodexAppServerModels;
  const models = await listModels({ codexHome: opts.codexHome });
  opts.signal?.throwIfAborted();
  return {
    provider: "codex-cli",
    source: "app-server",
    models: models.map(codexAppServerModelToCachedModel),
  };
}

export function createCodexAppServerModelDiscoveryAdapter(opts: {
  codexHome?: string;
  listCodexAppServerModelsImpl?: typeof listCodexAppServerModels;
}): ModelDiscoveryAdapter {
  return {
    provider: "codex-cli",
    source: "app-server",
    discover: async ({ signal }) =>
      await discoverCodexAppServerModels({
        codexHome: opts.codexHome,
        listCodexAppServerModelsImpl: opts.listCodexAppServerModelsImpl,
        signal,
      }),
  };
}

export async function discoverLmStudioModels(opts: {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<ModelDiscoveryResult> {
  opts.signal?.throwIfAborted();
  const response = await listLmStudioModels({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
  });
  opts.signal?.throwIfAborted();
  const llms = listLmStudioLlms(response.models);
  const defaultModel =
    llms.length > 0 ? selectDefaultLmStudioModel(response.models, opts.baseUrl) : null;
  return {
    provider: "lmstudio",
    source: "local-http",
    models: llms.map((model) => {
      const metadata = mapLmStudioModelToResolvedMetadata(model);
      return {
        id: metadata.id,
        displayName: metadata.displayName,
        ...(model.description ? { description: model.description } : {}),
        knowledgeCutoff: metadata.knowledgeCutoff,
        supportsImageInput: metadata.supportsImageInput,
        ...(defaultModel?.key === model.key ? { isDefault: true } : {}),
        runtimeOptions: {
          ...(metadata.maxContextLength ? { maxContextLength: metadata.maxContextLength } : {}),
          ...(metadata.effectiveContextLength
            ? { effectiveContextLength: metadata.effectiveContextLength }
            : {}),
          ...(metadata.trainedForToolUse !== undefined
            ? { trainedForToolUse: metadata.trainedForToolUse }
            : {}),
          ...(metadata.architecture ? { architecture: metadata.architecture } : {}),
          ...(metadata.format ? { format: metadata.format } : {}),
        },
      };
    }),
  };
}

export function createLmStudioModelDiscoveryAdapter(opts: {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): ModelDiscoveryAdapter {
  return {
    provider: "lmstudio",
    source: "local-http",
    discover: async ({ signal }) =>
      await discoverLmStudioModels({
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        fetchImpl: opts.fetchImpl,
        signal,
      }),
  };
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function parseJsonResponse(response: Response, provider: ProviderName): Promise<unknown> {
  if (response.ok) return await response.json();
  let detail = "";
  try {
    detail = (await response.text()).trim().slice(0, 300);
  } catch {
    detail = "";
  }
  throw new Error(
    `${provider} model list failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ""}`,
  );
}

function modelRecordsFromPayload(payload: unknown): unknown[] {
  const record = asRecord(payload);
  if (!record) return asArray(payload);
  const data = asArray(record.data);
  if (data.length > 0) return data;
  const models = asArray(record.models);
  if (models.length > 0) return models;
  return asArray(payload);
}

function finiteRecordNumber(record: Record<string, unknown>, key: string): number | undefined {
  return asFiniteNumber(record[key]);
}

function stringRecordValue(record: Record<string, unknown>, key: string): string | undefined {
  return asNonEmptyString(record[key]);
}

function stringArrayRecordValue(record: Record<string, unknown>, key: string): string[] {
  return asArray(record[key]).filter((entry): entry is string => typeof entry === "string");
}

function defaultModelIdForProvider(provider: ProviderName): string | undefined {
  return listSupportedModels(provider).find((model) => model.isDefault)?.id;
}

function isStaticDefaultModel(provider: ProviderName, modelId: string): boolean {
  return defaultModelIdForProvider(provider) === modelId;
}

function titleCaseModelToken(token: string): string {
  const lower = token.toLowerCase();
  if (["gpt", "glm", "qwen", "vl", "mcp", "oss", "ai"].includes(lower)) {
    return lower.toUpperCase();
  }
  if (lower === "claude") return "Claude";
  if (lower === "gemini") return "Gemini";
  if (lower === "kimi") return "Kimi";
  if (lower === "minimax") return "MiniMax";
  if (lower === "nemotron") return "Nemotron";
  if (lower === "deepseek") return "DeepSeek";
  if (lower === "mistral") return "Mistral";
  if (lower === "llama") return "Llama";
  if (!token) return token;
  return `${token[0]?.toUpperCase() ?? ""}${token.slice(1)}`;
}

function humanizeModelId(modelId: string): string {
  const shortened = modelId
    .replace(/^models\//, "")
    .replace(/^accounts\/fireworks\/(?:models|routers)\//, "");
  return shortened
    .split(/[/_\-\s]+/g)
    .filter(Boolean)
    .map(titleCaseModelToken)
    .join(" ");
}

function isOpenAiReasoningModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return normalized.startsWith("gpt-5") || /^o[134](?:$|[-.])/.test(normalized);
}

function reasoningForLiveModel(
  provider: ProviderName,
  modelId: string,
  supported?: SupportedModel,
): CachedModelDiscoveryModel["reasoning"] {
  if (provider === "google") {
    return {
      defaultEffort: GOOGLE_DYNAMIC_REASONING_EFFORT,
      availableEfforts: [...listGoogleReasoningEffortValuesForModel(modelId)],
    };
  }
  if (provider === "openai" && isOpenAiReasoningModel(modelId)) {
    const registryConfig = supported ? openAiReasoningConfigForSupportedModel(supported) : null;
    if (registryConfig) {
      return {
        defaultEffort: registryConfig.defaultEffort,
        availableEfforts: [...registryConfig.availableEfforts],
      };
    }
    return {
      defaultEffort: "high",
      availableEfforts: [...DEFAULT_OPENAI_REASONING_EFFORT_VALUES],
    };
  }
  return undefined;
}

function cachedModelFromLiveFields(
  provider: ProviderName,
  modelId: string,
  fields: {
    displayName?: string;
    description?: string;
    supportsImageInput?: boolean;
    reasoning?: CachedModelDiscoveryModel["reasoning"];
    runtimeOptions?: Record<string, unknown>;
  } = {},
): CachedModelDiscoveryModel {
  const supported = listSupportedModels(provider).length
    ? listSupportedModels(provider).find((model) => model.id === modelId)
    : undefined;
  const reasoning = fields.reasoning ?? reasoningForLiveModel(provider, modelId, supported);
  return {
    id: modelId,
    displayName: fields.displayName ?? supported?.displayName ?? humanizeModelId(modelId),
    ...(fields.description ? { description: fields.description } : {}),
    ...(supported?.knowledgeCutoff ? { knowledgeCutoff: supported.knowledgeCutoff } : {}),
    supportsImageInput: supported?.supportsImageInput ?? fields.supportsImageInput ?? false,
    ...(isStaticDefaultModel(provider, modelId) ? { isDefault: true } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(fields.runtimeOptions ? { runtimeOptions: fields.runtimeOptions } : {}),
  };
}

function openAiCompatibleRuntimeOptions(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { source: "models-api" };
  const created = finiteRecordNumber(record, "created");
  const ownedBy =
    stringRecordValue(record, "owned_by") ??
    stringRecordValue(record, "ownedBy") ??
    stringRecordValue(record, "organization");
  const object = stringRecordValue(record, "object");
  const sourceType = stringRecordValue(record, "type");
  const contextLength =
    finiteRecordNumber(record, "context_length") ??
    finiteRecordNumber(record, "contextLength") ??
    finiteRecordNumber(record, "max_context_length");
  if (created !== undefined) out.created = created;
  if (ownedBy) out.ownedBy = ownedBy;
  if (object) out.object = object;
  if (sourceType) out.sourceType = sourceType;
  if (contextLength !== undefined) out.contextLength = contextLength;
  return out;
}

function shouldIncludeOpenAiCompatibleModel(
  provider: OpenAiCompatibleModelListProvider,
  modelId: string,
  record: Record<string, unknown>,
): boolean {
  if (listSupportedModels(provider).some((model) => model.id === modelId)) return true;
  if (MODEL_ID_DENY_PATTERN.test(modelId)) return false;

  const normalized = modelId.trim().toLowerCase();
  const sourceType = stringRecordValue(record, "type")?.toLowerCase();
  if (sourceType && !["chat", "language", "text", "model", "serverless"].includes(sourceType)) {
    return false;
  }

  if (provider === "openai") {
    return normalized.startsWith("gpt-") || /^o\d/.test(normalized);
  }
  if (provider === "minimax") {
    return normalized.startsWith("minimax-");
  }
  if (provider === "fireworks" || provider === "firepass") {
    return (
      normalized.startsWith("accounts/fireworks/models/") ||
      normalized.startsWith("accounts/fireworks/routers/") ||
      normalized.startsWith("fireworks/")
    );
  }
  if (provider === "nvidia") {
    return normalized.startsWith("nvidia/");
  }
  if (provider === "opencode-go" || provider === "opencode-zen") {
    return true;
  }

  return /chat|instruct|kimi|qwen|glm|deepseek|llama|mistral|mixtral|gemma|nemotron|minimax|moonshot|claude|gpt/i.test(
    modelId,
  );
}

export async function discoverOpenAiCompatibleModels(opts: {
  provider: OpenAiCompatibleModelListProvider;
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  authorizationHeaderName?: string;
  authorizationPrefix?: string;
  headers?: Record<string, string>;
}): Promise<ModelDiscoveryResult> {
  opts.signal?.throwIfAborted();
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(opts.headers ?? {}),
  };
  if (opts.apiKey) {
    const headerName = opts.authorizationHeaderName ?? "Authorization";
    const prefix = opts.authorizationPrefix ?? "Bearer";
    headers[headerName] = prefix ? `${prefix} ${opts.apiKey}` : opts.apiKey;
  }
  const response = await (opts.fetchImpl ?? fetch)(joinUrl(opts.baseUrl, "models"), {
    method: "GET",
    headers,
    signal: opts.signal,
  });
  const payload = await parseJsonResponse(response, opts.provider);
  opts.signal?.throwIfAborted();
  const models: CachedModelDiscoveryModel[] = [];
  for (const raw of modelRecordsFromPayload(payload)) {
    const record = asRecord(raw);
    if (!record) continue;
    const modelId =
      stringRecordValue(record, "id") ??
      stringRecordValue(record, "model") ??
      stringRecordValue(record, "name");
    if (!modelId || !shouldIncludeOpenAiCompatibleModel(opts.provider, modelId, record)) {
      continue;
    }
    const displayName =
      stringRecordValue(record, "display_name") ??
      stringRecordValue(record, "displayName") ??
      stringRecordValue(record, "name");
    const description = stringRecordValue(record, "description");
    const sourceType = stringRecordValue(record, "type")?.toLowerCase();
    models.push(
      cachedModelFromLiveFields(opts.provider, modelId, {
        ...(displayName && displayName !== modelId ? { displayName } : {}),
        ...(description ? { description } : {}),
        supportsImageInput:
          /vision|vl|multimodal|omni/i.test(modelId) || sourceType === "vision" ? true : undefined,
        runtimeOptions: openAiCompatibleRuntimeOptions(record),
      }),
    );
  }
  return {
    provider: opts.provider,
    source: "api",
    models,
  };
}

export function createOpenAiCompatibleModelDiscoveryAdapter(opts: {
  provider: OpenAiCompatibleModelListProvider;
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  authorizationHeaderName?: string;
  authorizationPrefix?: string;
  headers?: Record<string, string>;
}): ModelDiscoveryAdapter {
  return {
    provider: opts.provider,
    source: "api",
    discover: async ({ signal }) =>
      await discoverOpenAiCompatibleModels({
        provider: opts.provider,
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        fetchImpl: opts.fetchImpl,
        authorizationHeaderName: opts.authorizationHeaderName,
        authorizationPrefix: opts.authorizationPrefix,
        headers: opts.headers,
        signal,
      }),
  };
}

function googleModelId(record: Record<string, unknown>): string | undefined {
  const name = stringRecordValue(record, "name")?.replace(/^models\//, "");
  return name ?? stringRecordValue(record, "baseModelId");
}

function shouldIncludeGoogleModel(record: Record<string, unknown>, modelId: string): boolean {
  const methods = stringArrayRecordValue(record, "supportedGenerationMethods");
  if (!methods.includes("generateContent") && !methods.includes("streamGenerateContent")) {
    return false;
  }
  if (!modelId.toLowerCase().startsWith("gemini-")) return false;
  return !MODEL_ID_DENY_PATTERN.test(modelId);
}

function googleRuntimeOptions(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { source: "models-api" };
  const baseModelId = stringRecordValue(record, "baseModelId");
  const version = stringRecordValue(record, "version");
  const inputTokenLimit = finiteRecordNumber(record, "inputTokenLimit");
  const outputTokenLimit = finiteRecordNumber(record, "outputTokenLimit");
  const supportedGenerationMethods = stringArrayRecordValue(record, "supportedGenerationMethods");
  if (baseModelId) out.baseModelId = baseModelId;
  if (version) out.version = version;
  if (inputTokenLimit !== undefined) out.inputTokenLimit = inputTokenLimit;
  if (outputTokenLimit !== undefined) out.outputTokenLimit = outputTokenLimit;
  if (supportedGenerationMethods.length > 0) {
    out.supportedGenerationMethods = supportedGenerationMethods;
  }
  if (typeof record.thinking === "boolean") out.thinking = record.thinking;
  return out;
}

export async function discoverGoogleModels(opts: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<ModelDiscoveryResult> {
  opts.signal?.throwIfAborted();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const models: CachedModelDiscoveryModel[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGINATED_MODEL_LIST_PAGES; page += 1) {
    const url = new URL(GOOGLE_MODEL_LIST_URL);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-goog-api-key": opts.apiKey,
      },
      signal: opts.signal,
    });
    const payload = await parseJsonResponse(response, "google");
    opts.signal?.throwIfAborted();
    const record = asRecord(payload);
    for (const rawModel of asArray(record?.models)) {
      const modelRecord = asRecord(rawModel);
      if (!modelRecord) continue;
      const modelId = googleModelId(modelRecord);
      if (!modelId || !shouldIncludeGoogleModel(modelRecord, modelId)) continue;
      models.push(
        cachedModelFromLiveFields("google", modelId, {
          displayName: stringRecordValue(modelRecord, "displayName"),
          description: stringRecordValue(modelRecord, "description"),
          supportsImageInput: true,
          runtimeOptions: googleRuntimeOptions(modelRecord),
        }),
      );
    }
    pageToken = asNonEmptyString(record?.nextPageToken);
    if (!pageToken) break;
  }
  return {
    provider: "google",
    source: "api",
    models,
  };
}

export function createGoogleModelDiscoveryAdapter(opts: {
  apiKey: string;
  fetchImpl?: typeof fetch;
}): ModelDiscoveryAdapter {
  return {
    provider: "google",
    source: "api",
    discover: async ({ signal }) =>
      await discoverGoogleModels({
        apiKey: opts.apiKey,
        fetchImpl: opts.fetchImpl,
        signal,
      }),
  };
}

function anthropicRuntimeOptions(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { source: "models-api" };
  const createdAt = stringRecordValue(record, "created_at");
  const type = stringRecordValue(record, "type");
  if (createdAt) out.createdAt = createdAt;
  if (type) out.sourceType = type;
  return out;
}

export async function discoverAnthropicModels(opts: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<ModelDiscoveryResult> {
  opts.signal?.throwIfAborted();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const models: CachedModelDiscoveryModel[] = [];
  let afterId: string | undefined;
  for (let page = 0; page < MAX_PAGINATED_MODEL_LIST_PAGES; page += 1) {
    const url = new URL(ANTHROPIC_MODEL_LIST_URL);
    url.searchParams.set("limit", "100");
    if (afterId) url.searchParams.set("after_id", afterId);
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": opts.apiKey,
      },
      signal: opts.signal,
    });
    const payload = await parseJsonResponse(response, "anthropic");
    opts.signal?.throwIfAborted();
    const record = asRecord(payload);
    for (const rawModel of asArray(record?.data)) {
      const modelRecord = asRecord(rawModel);
      if (!modelRecord) continue;
      const modelId = stringRecordValue(modelRecord, "id");
      if (!modelId?.toLowerCase().startsWith("claude-")) continue;
      models.push(
        cachedModelFromLiveFields("anthropic", modelId, {
          displayName:
            stringRecordValue(modelRecord, "display_name") ??
            stringRecordValue(modelRecord, "displayName"),
          runtimeOptions: anthropicRuntimeOptions(modelRecord),
        }),
      );
    }
    if (record?.has_more !== true) break;
    afterId = asNonEmptyString(record.last_id);
    if (!afterId) break;
  }
  return {
    provider: "anthropic",
    source: "api",
    models,
  };
}

export function createAnthropicModelDiscoveryAdapter(opts: {
  apiKey: string;
  fetchImpl?: typeof fetch;
}): ModelDiscoveryAdapter {
  return {
    provider: "anthropic",
    source: "api",
    discover: async ({ signal }) =>
      await discoverAnthropicModels({
        apiKey: opts.apiKey,
        fetchImpl: opts.fetchImpl,
        signal,
      }),
  };
}

function supportedModelToCachedModel(
  model: ReturnType<typeof listSupportedModels>[number],
): CachedModelDiscoveryModel {
  return {
    id: model.id,
    displayName: model.displayName,
    knowledgeCutoff: model.knowledgeCutoff,
    supportsImageInput: model.supportsImageInput,
  };
}

export function discoverStaticProviderModels(provider: StaticProvider): ModelDiscoveryResult {
  const defaultModel = defaultSupportedModel(provider).id;
  return {
    provider,
    source: "static",
    models: listSupportedModels(provider).map((model) => ({
      ...supportedModelToCachedModel(model),
      ...(model.id === defaultModel ? { isDefault: true } : {}),
    })),
  };
}

export function createStaticModelDiscoveryAdapter(provider: StaticProvider): ModelDiscoveryAdapter {
  return {
    provider,
    source: "static",
    discover: async () => discoverStaticProviderModels(provider),
  };
}

export async function discoverBedrockModels(opts: {
  paths: AiCoworkerPaths;
  env?: NodeJS.ProcessEnv;
  force?: boolean;
  signal?: AbortSignal;
}): Promise<ModelDiscoveryResult> {
  opts.signal?.throwIfAborted();
  const snapshot = opts.force
    ? await refreshBedrockDiscoveryCache({ paths: opts.paths, env: opts.env })
    : await readBedrockCatalogSnapshot({ paths: opts.paths, env: opts.env });
  opts.signal?.throwIfAborted();
  const source: ModelDiscoverySource =
    snapshot.auth && (!("usedCache" in snapshot) || snapshot.usedCache || snapshot.ok)
      ? "api"
      : "static";
  return {
    provider: "bedrock",
    source,
    updatedAt: "updatedAt" in snapshot ? snapshot.updatedAt : undefined,
    message: snapshot.message,
    models: snapshot.models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      ...(model.description ? { description: model.description } : {}),
      knowledgeCutoff: model.knowledgeCutoff,
      supportsImageInput: model.supportsImageInput,
      ...(model.id === snapshot.defaultModel ? { isDefault: true } : {}),
      runtimeOptions: {
        sourceKind: model.sourceKind,
        ...(model.sourceModelId ? { sourceModelId: model.sourceModelId } : {}),
        ...(model.sourceModelArn ? { sourceModelArn: model.sourceModelArn } : {}),
      },
    })),
  };
}

export function createBedrockModelDiscoveryAdapter(opts: {
  paths: AiCoworkerPaths;
  env?: NodeJS.ProcessEnv;
}): ModelDiscoveryAdapter {
  return {
    provider: "bedrock",
    source: "api",
    discover: async ({ force, signal }) =>
      await discoverBedrockModels({
        paths: opts.paths,
        env: opts.env,
        force,
        signal,
      }),
  };
}
