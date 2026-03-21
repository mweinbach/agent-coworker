import { getAiCoworkerPaths, readConnectionStore, type AiCoworkerPaths } from "../connect";
import { PROVIDER_NAMES, type ProviderName } from "../types";
import { defaultSupportedModel, listSupportedModels, type SupportedModel } from "../models/registry";
import { readCodexAuthMaterial } from "./codex-auth";
import {
  listLmStudioLlms,
  lmStudioCatalogStateMessage,
  mapLmStudioModelToResolvedMetadata,
  selectDefaultLmStudioModel,
} from "./lmstudio/catalog";
import { isLmStudioError, listLmStudioModels, resolveLmStudioProviderOptions } from "./lmstudio/client";
import { getOpenCodeDisplayName } from "./opencodeShared";
import { resolveAuthHomeDir } from "../utils/authHome";
import {
  discoverAwsBedrockProxyModelsDetailed,
  formatAwsBedrockProxyDiscoveryFailure,
  resolveAwsBedrockProxyBaseUrl,
} from "./awsBedrockProxyShared";

function storedProviderApiKey(store: Awaited<ReturnType<typeof readConnectionStore>>, provider: ProviderName): string | undefined {
  const entry = store.services[provider];
  const apiKey = entry?.mode === "api_key" ? entry.apiKey?.trim() : "";
  return apiKey || undefined;
}

export type ProviderCatalogModelEntry = Pick<
  SupportedModel,
  "id" | "displayName" | "knowledgeCutoff" | "supportsImageInput"
>;

export type ProviderCatalogEntry = {
  id: ProviderName;
  name: string;
  models: ProviderCatalogModelEntry[];
  defaultModel: string;
  state?: "ready" | "empty" | "unreachable";
  message?: string;
};

export type ProviderCatalogPayload = {
  all: ProviderCatalogEntry[];
  default: Record<string, string>;
  connected: string[];
};

const PROVIDER_LABELS: Record<ProviderName, string> = {
  google: "Google",
  openai: "OpenAI",
  "aws-bedrock-proxy": "AWS Bedrock Proxy",
  anthropic: "Anthropic",
  baseten: "Baseten",
  together: "Together AI",
  fireworks: "Fireworks AI",
  nvidia: "NVIDIA",
  lmstudio: "LM Studio",
  "opencode-go": getOpenCodeDisplayName("opencode-go"),
  "opencode-zen": getOpenCodeDisplayName("opencode-zen"),
  "codex-cli": "Codex CLI",
};

function staticCatalogEntry(provider: Exclude<ProviderName, "lmstudio">): ProviderCatalogEntry {
  return {
    id: provider,
    name: PROVIDER_LABELS[provider],
    models: listSupportedModels(provider).map((model) => ({
      id: model.id,
      displayName: model.displayName,
      knowledgeCutoff: model.knowledgeCutoff,
      supportsImageInput: model.supportsImageInput,
    })),
    defaultModel: defaultSupportedModel(provider).id,
  };
}

async function lmStudioCatalogEntry(opts: {
  store?: Awaited<ReturnType<typeof readConnectionStore>>;
  providerOptions?: unknown;
  env?: NodeJS.ProcessEnv;
  lmstudioFetchImpl?: typeof fetch;
}): Promise<{ entry: ProviderCatalogEntry; connected: boolean }> {
  const provider = resolveLmStudioProviderOptions(opts.providerOptions, opts.env);
  try {
    const models = (await listLmStudioModels({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey ?? (opts.store ? storedProviderApiKey(opts.store, "lmstudio") : undefined),
      fetchImpl: opts.lmstudioFetchImpl,
    })).models;
    const llms = listLmStudioLlms(models);
    const defaultModel = llms.length > 0 ? selectDefaultLmStudioModel(models, provider.baseUrl).key : "";
    return {
      entry: {
        id: "lmstudio",
        name: PROVIDER_LABELS.lmstudio,
        models: llms.map((model) => {
          const metadata = mapLmStudioModelToResolvedMetadata(model);
          return {
            id: metadata.id,
            displayName: metadata.displayName,
            knowledgeCutoff: metadata.knowledgeCutoff,
            supportsImageInput: metadata.supportsImageInput,
          };
        }),
        defaultModel,
        state: "ready",
      },
      connected: true,
    };
  } catch (error) {
    if (isLmStudioError(error) && error.code === "no_llms") {
      return {
        entry: {
          id: "lmstudio",
          name: PROVIDER_LABELS.lmstudio,
          models: [],
          defaultModel: "",
          state: "empty",
          message: error.message,
        },
        connected: true,
      };
    }
    return {
      entry: {
        id: "lmstudio",
        name: PROVIDER_LABELS.lmstudio,
        models: [],
        defaultModel: "",
        state: "unreachable",
        message: lmStudioCatalogStateMessage({
          error,
          baseUrl: provider.baseUrl,
        }),
      },
      connected: false,
    };
  }
}

export async function listProviderCatalogEntries(opts: {
  store?: Awaited<ReturnType<typeof readConnectionStore>>;
  providerOptions?: unknown;
  env?: NodeJS.ProcessEnv;
  lmstudioFetchImpl?: typeof fetch;
} = {}): Promise<ProviderCatalogEntry[]> {
  const lmstudio = await lmStudioCatalogEntry(opts);
  return PROVIDER_NAMES.map((provider) => {
    if (provider === "lmstudio") return lmstudio.entry;
    return staticCatalogEntry(provider);
  });
}

export async function getProviderCatalog(opts: {
  homedir?: string;
  paths?: AiCoworkerPaths;
  readStore?: typeof readConnectionStore;
  readCodexAuthMaterialImpl?: typeof readCodexAuthMaterial;
  providerOptions?: unknown;
  env?: NodeJS.ProcessEnv;
  lmstudioFetchImpl?: typeof fetch;
  activeProvider?: ProviderName;
  activeModel?: string;
  awsBedrockProxyBaseUrl?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<ProviderCatalogPayload> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: opts.homedir ?? resolveAuthHomeDir() });
  const readStore = opts.readStore ?? readConnectionStore;
  const readCodexAuthMaterialImpl = opts.readCodexAuthMaterialImpl ?? readCodexAuthMaterial;
  const store = await readStore(paths);
  const lmstudio = await lmStudioCatalogEntry({
    store,
    providerOptions: opts.providerOptions,
    env: opts.env,
    lmstudioFetchImpl: opts.lmstudioFetchImpl,
  });
  const all = PROVIDER_NAMES.map((provider) => {
    if (provider === "lmstudio") return lmstudio.entry;
    return staticCatalogEntry(provider);
  });

  const awsBedrockProxyIndex = all.findIndex((entry) => entry.id === "aws-bedrock-proxy");
  if (awsBedrockProxyIndex >= 0) {
    const proxyEntry = all[awsBedrockProxyIndex];
    const savedKey = store.services["aws-bedrock-proxy"]?.mode === "api_key"
      ? store.services["aws-bedrock-proxy"].apiKey
      : undefined;
    const baseUrl = resolveAwsBedrockProxyBaseUrl({
      baseUrl: opts.awsBedrockProxyBaseUrl,
      providerOptions: opts.providerOptions,
      env: opts.env,
    });
    const discovery = await discoverAwsBedrockProxyModelsDetailed({
      baseUrl,
      apiKey: savedKey,
      fetchImpl: opts.fetchImpl,
    });
    const discoveredModels = discovery.ok ? discovery.models : [];
    const activeProxyModel = opts.activeProvider === "aws-bedrock-proxy" ? opts.activeModel?.trim() : undefined;
    const hasActiveModel = Boolean(activeProxyModel && discoveredModels.some((model) => model.id === activeProxyModel));
    const models = activeProxyModel && !hasActiveModel
      ? [
          {
            id: activeProxyModel,
            displayName: activeProxyModel,
            knowledgeCutoff: "Unknown",
            supportsImageInput: false,
          },
          ...discoveredModels,
        ]
      : discoveredModels;
    all[awsBedrockProxyIndex] = {
      ...proxyEntry,
      models,
      defaultModel: models[0]?.id ?? (discovery.ok ? proxyEntry.defaultModel : ""),
      ...(discovery.ok ? {} : { state: "unreachable" as const, message: formatAwsBedrockProxyDiscoveryFailure(discovery) }),
    };
  }

  const defaults: Record<string, string> = {};
  for (const entry of all) defaults[entry.id] = entry.defaultModel;
  const hasCodexOauth = Boolean((await readCodexAuthMaterialImpl(paths))?.accessToken);
  const connected = PROVIDER_NAMES.filter((provider) => {
    if (provider === "lmstudio") {
      return lmstudio.connected;
    }
    const entry = store.services[provider];
    if (entry?.mode === "api_key" || entry?.mode === "oauth") return true;
    return provider === "codex-cli" && hasCodexOauth;
  });
  return { all, default: defaults, connected };
}
