import type { ResolvedModelMetadata } from "../../models/metadataTypes";
import {
  createLmStudioError,
  isLmStudioError,
  listLmStudioModels,
  loadLmStudioModel,
  resolveLmStudioProviderOptions,
  unloadLmStudioModel,
  type ResolvedLmStudioProviderOptions,
} from "./client";
import type {
  LmStudioLoadedInstance,
  LmStudioLoadResponse,
  LmStudioModel,
} from "./types";

type FetchLike = typeof fetch;

function compareModelKeys(a: { key: string }, b: { key: string }): number {
  return a.key.localeCompare(b.key);
}

function normalizeModelKey(modelId: string, source = "model"): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    throw new Error(`${source} is required.`);
  }
  return trimmed;
}

export function listLmStudioLlms(models: readonly LmStudioModel[]): LmStudioModel[] {
  return models
    .filter((model) => model.type === "llm")
    .sort(compareModelKeys);
}

export function pickLmStudioLoadedInstance(
  instances: readonly LmStudioLoadedInstance[],
): LmStudioLoadedInstance | null {
  if (instances.length === 0) return null;
  return [...instances].sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
}

function loadConfigContextLength(load: LmStudioLoadResponse | undefined): number | undefined {
  return typeof load?.load_config?.context_length === "number" && Number.isFinite(load.load_config.context_length)
    ? load.load_config.context_length
    : undefined;
}

export function buildLmStudioPlaceholderMetadata(modelId: string): ResolvedModelMetadata {
  const id = normalizeModelKey(modelId);
  return {
    id,
    provider: "lmstudio",
    displayName: id,
    knowledgeCutoff: "Unknown",
    supportsImageInput: false,
    promptTemplate: "system.md",
    providerOptionsDefaults: {},
    source: "dynamic",
    loaded: false,
  };
}

function metadataFromLoadResult(model: LmStudioModel, loadResult?: LmStudioLoadResponse): ResolvedModelMetadata {
  const effectiveContextLength =
    loadConfigContextLength(loadResult)
    ?? pickLmStudioLoadedInstance(model.loaded_instances)?.config.context_length
    ?? model.max_context_length;
  return {
    ...mapLmStudioModelToResolvedMetadata(model),
    effectiveContextLength,
    loaded: true,
  };
}

export function mapLmStudioModelToResolvedMetadata(model: LmStudioModel): ResolvedModelMetadata {
  const loadedInstance = pickLmStudioLoadedInstance(model.loaded_instances);
  return {
    id: model.key,
    provider: "lmstudio",
    displayName: model.display_name?.trim() || model.key,
    knowledgeCutoff: "Unknown",
    supportsImageInput: model.capabilities?.vision === true,
    promptTemplate: "system.md",
    providerOptionsDefaults: {},
    source: "dynamic",
    maxContextLength: model.max_context_length,
    effectiveContextLength: loadedInstance?.config.context_length ?? model.max_context_length,
    trainedForToolUse: model.capabilities?.trained_for_tool_use === true,
    ...(model.architecture ? { architecture: model.architecture } : {}),
    ...(model.format ? { format: model.format } : {}),
    loaded: loadedInstance !== null,
  };
}

export function selectDefaultLmStudioModel(models: readonly LmStudioModel[], baseUrl: string): LmStudioModel {
  const llms = listLmStudioLlms(models);
  const loaded = llms.filter((model) => model.loaded_instances.length > 0);
  if (loaded.length > 0) {
    return [...loaded].sort(compareModelKeys)[0]!;
  }
  if (llms.length > 0) {
    return llms[0]!;
  }
  throw createLmStudioError(
    "no_llms",
    `LM Studio server at ${baseUrl} is reachable, but no LLMs are available.`,
    baseUrl,
  );
}

export async function resolveLmStudioDiscoveredModelMetadata(opts: {
  modelId: string;
  providerOptions?: unknown;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}): Promise<ResolvedModelMetadata> {
  const provider = resolveLmStudioProviderOptions(opts.providerOptions, opts.env);
  const models = (await listLmStudioModels({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    fetchImpl: opts.fetchImpl,
  })).models;
  const model = models.find((entry) => entry.key === normalizeModelKey(opts.modelId));
  if (!model) {
    throw createLmStudioError(
      "missing_model",
      `LM Studio model "${opts.modelId}" is not available at ${provider.baseUrl}.`,
      provider.baseUrl,
    );
  }
  if (model.type !== "llm") {
    throw createLmStudioError(
      "missing_model",
      `LM Studio model "${opts.modelId}" is not an LLM and cannot be used for chat inference.`,
      provider.baseUrl,
    );
  }
  return mapLmStudioModelToResolvedMetadata(model);
}

export async function resolveDefaultLmStudioModelMetadata(opts: {
  providerOptions?: unknown;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}): Promise<ResolvedModelMetadata> {
  const provider = resolveLmStudioProviderOptions(opts.providerOptions, opts.env);
  const models = (await listLmStudioModels({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    fetchImpl: opts.fetchImpl,
  })).models;
  return mapLmStudioModelToResolvedMetadata(selectDefaultLmStudioModel(models, provider.baseUrl));
}

function metadataAfterLoad(model: LmStudioModel, loadResult: LmStudioLoadResponse): ResolvedModelMetadata {
  const loadedInstance: LmStudioLoadedInstance = {
    id: loadResult.instance_id,
    config: {
      context_length: loadConfigContextLength(loadResult) ?? model.max_context_length,
      ...(typeof loadResult.load_config?.eval_batch_size === "number"
        ? { eval_batch_size: loadResult.load_config.eval_batch_size }
        : {}),
      ...(typeof loadResult.load_config?.flash_attention === "boolean"
        ? { flash_attention: loadResult.load_config.flash_attention }
        : {}),
      ...(typeof loadResult.load_config?.num_experts === "number"
        ? { num_experts: loadResult.load_config.num_experts }
        : {}),
      ...(typeof loadResult.load_config?.offload_kv_cache_to_gpu === "boolean"
        ? { offload_kv_cache_to_gpu: loadResult.load_config.offload_kv_cache_to_gpu }
        : {}),
    },
  };
  return metadataFromLoadResult({
    ...model,
    loaded_instances: [loadedInstance],
  }, loadResult);
}

async function unloadLoadedInstances(opts: {
  provider: ResolvedLmStudioProviderOptions;
  instances: readonly LmStudioLoadedInstance[];
  fetchImpl?: FetchLike;
}): Promise<void> {
  for (const instance of opts.instances) {
    await unloadLmStudioModel({
      baseUrl: opts.provider.baseUrl,
      apiKey: opts.provider.apiKey,
      fetchImpl: opts.fetchImpl,
      instanceId: instance.id,
    });
  }
}

export async function prepareLmStudioModelMetadataForInference(opts: {
  modelId: string;
  providerOptions?: unknown;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
}): Promise<{
  metadata: ResolvedModelMetadata;
  provider: ResolvedLmStudioProviderOptions;
}> {
  const provider = resolveLmStudioProviderOptions(opts.providerOptions, opts.env);
  const requestedModelId = normalizeModelKey(opts.modelId);
  const response = await listLmStudioModels({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    fetchImpl: opts.fetchImpl,
  });
  const model = response.models.find((entry) => entry.key === requestedModelId);
  if (!model) {
    throw createLmStudioError(
      "missing_model",
      `LM Studio model "${requestedModelId}" is not available at ${provider.baseUrl}.`,
      provider.baseUrl,
    );
  }
  if (model.type !== "llm") {
    throw createLmStudioError(
      "missing_model",
      `LM Studio model "${requestedModelId}" is not an LLM and cannot be used for chat inference.`,
      provider.baseUrl,
    );
  }

  const loadedInstance = pickLmStudioLoadedInstance(model.loaded_instances);
  const currentContextLength = loadedInstance?.config.context_length;
  const requestedContextLength = provider.contextLength;

  if (loadedInstance && requestedContextLength === undefined) {
    return {
      metadata: mapLmStudioModelToResolvedMetadata(model),
      provider,
    };
  }

  if (loadedInstance && requestedContextLength !== undefined && requestedContextLength !== currentContextLength) {
    if (provider.reloadOnContextMismatch === false) {
      opts.log?.(
        `[lmstudio] requested context length ${requestedContextLength} differs from loaded ${currentContextLength} for ${requestedModelId}; reusing the existing load because reloadOnContextMismatch=false.`,
      );
      return {
        metadata: mapLmStudioModelToResolvedMetadata(model),
        provider,
      };
    }
    opts.log?.(
      `[lmstudio] requested context length ${requestedContextLength} differs from loaded ${currentContextLength} for ${requestedModelId}; unloading ${model.loaded_instances.length} instance(s) and reloading.`,
    );
    await unloadLoadedInstances({
      provider,
      instances: model.loaded_instances,
      fetchImpl: opts.fetchImpl,
    });
    const loadResult = await loadLmStudioModel({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      fetchImpl: opts.fetchImpl,
      modelKey: requestedModelId,
      contextLength: requestedContextLength,
    });
    return {
      metadata: metadataAfterLoad(model, loadResult),
      provider,
    };
  }

  if (!loadedInstance && requestedContextLength !== undefined) {
    opts.log?.(
      `[lmstudio] loading ${requestedModelId} with explicit context length ${requestedContextLength}.`,
    );
    const loadResult = await loadLmStudioModel({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      fetchImpl: opts.fetchImpl,
      modelKey: requestedModelId,
      contextLength: requestedContextLength,
    });
    return {
      metadata: metadataAfterLoad(model, loadResult),
      provider,
    };
  }

  if (!loadedInstance && provider.autoLoad) {
    opts.log?.(`[lmstudio] loading ${requestedModelId} before inference to capture the active context window.`);
    const loadResult = await loadLmStudioModel({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      fetchImpl: opts.fetchImpl,
      modelKey: requestedModelId,
    });
    return {
      metadata: metadataAfterLoad(model, loadResult),
      provider,
    };
  }

  if (!loadedInstance) {
    opts.log?.(
      `[lmstudio] ${requestedModelId} is not loaded and autoLoad=false; inference will rely on LM Studio JIT loading.`,
    );
  }

  return {
    metadata: mapLmStudioModelToResolvedMetadata(model),
    provider,
  };
}

export function lmStudioCatalogStateMessage(opts: {
  error?: unknown;
  baseUrl: string;
}): string {
  if (!opts.error) return "";
  if (isLmStudioError(opts.error)) {
    return opts.error.message;
  }
  return `Failed to query LM Studio at ${opts.baseUrl}: ${String(opts.error)}`;
}
