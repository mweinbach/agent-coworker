import { getAiCoworkerPaths, readConnectionStore, type AiCoworkerPaths } from "../connect";
import { PROVIDER_NAMES, type ProviderName } from "../types";
import { defaultSupportedModel, listSupportedModels, type SupportedModel } from "../models/registry";
import { readCodexAuthMaterial } from "./codex-auth";
import { getOpenCodeDisplayName } from "./opencodeShared";
import {
  discoverOpenAiProxyModels,
  resolveOpenAiProxyApiKey,
  resolveOpenAiProxyBaseUrl,
  type OpenAiCompatibleModelEntry,
} from "./openaiProxyShared";
import { resolveAuthHomeDir } from "../utils/authHome";

export type ProviderCatalogModelEntry = Pick<
  SupportedModel,
  "id" | "displayName" | "knowledgeCutoff" | "supportsImageInput"
>;

export type ProviderCatalogEntry = {
  id: ProviderName;
  name: string;
  models: ProviderCatalogModelEntry[];
  defaultModel: string;
};

export type ProviderCatalogPayload = {
  all: ProviderCatalogEntry[];
  default: Record<string, string>;
  connected: string[];
};

const PROVIDER_LABELS: Record<ProviderName, string> = {
  google: "Google",
  openai: "OpenAI",
  anthropic: "Anthropic",
  baseten: "Baseten",
  together: "Together AI",
  nvidia: "NVIDIA",
  "opencode-go": getOpenCodeDisplayName("opencode-go"),
  "opencode-zen": getOpenCodeDisplayName("opencode-zen"),
  "openai-proxy": "OpenAI-API Proxy",
  "codex-cli": "Codex CLI",
};

function mapDiscoveredModel(entry: OpenAiCompatibleModelEntry): ProviderCatalogModelEntry {
  return {
    id: entry.id,
    displayName: entry.displayName,
    knowledgeCutoff: entry.knowledgeCutoff,
    supportsImageInput: entry.supportsImageInput,
  };
}

export function listProviderCatalogEntries(): ProviderCatalogEntry[] {
  return PROVIDER_NAMES.map((provider) => ({
    id: provider,
    name: PROVIDER_LABELS[provider],
    models: listSupportedModels(provider).map((model) => ({
      id: model.id,
      displayName: model.displayName,
      knowledgeCutoff: model.knowledgeCutoff,
      supportsImageInput: model.supportsImageInput,
    })),
    defaultModel: defaultSupportedModel(provider).id,
  }));
}

export async function getProviderCatalog(opts: {
  homedir?: string;
  paths?: AiCoworkerPaths;
  readStore?: typeof readConnectionStore;
  readCodexAuthMaterialImpl?: typeof readCodexAuthMaterial;
  fetchImpl?: typeof fetch;
  currentSelection?: { provider: ProviderName; model: string };
} = {}): Promise<ProviderCatalogPayload> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: opts.homedir ?? resolveAuthHomeDir() });
  const readStore = opts.readStore ?? readConnectionStore;
  const readCodexAuthMaterialImpl = opts.readCodexAuthMaterialImpl ?? readCodexAuthMaterial;
  const store = await readStore(paths);
  const all = listProviderCatalogEntries();

  const proxyBaseUrl = resolveOpenAiProxyBaseUrl();
  const proxyApiKey = resolveOpenAiProxyApiKey({
    savedKey: store.services["openai-proxy"]?.mode === "api_key" ? store.services["openai-proxy"]?.apiKey : undefined,
  });
  const proxyDiscovered = proxyBaseUrl
    ? await discoverOpenAiProxyModels({ baseUrl: proxyBaseUrl, apiKey: proxyApiKey, fetchImpl: opts.fetchImpl }).catch(() => [])
    : [];
  const proxyCatalog = all.find((entry) => entry.id === "openai-proxy");
  if (proxyCatalog && proxyDiscovered.length > 0) {
    proxyCatalog.models = proxyDiscovered.map(mapDiscoveredModel);
    proxyCatalog.defaultModel = proxyDiscovered[0]?.id ?? proxyCatalog.defaultModel;
  }

  const currentProxyModel = opts.currentSelection?.provider === "openai-proxy" ? opts.currentSelection.model.trim() : "";
  if (proxyCatalog && currentProxyModel && !proxyCatalog.models.some((model) => model.id === currentProxyModel)) {
    proxyCatalog.models = [
      ...proxyCatalog.models,
      {
        id: currentProxyModel,
        displayName: currentProxyModel,
        knowledgeCutoff: "Unknown",
        supportsImageInput: false,
      },
    ];
  }

  const defaults: Record<string, string> = {};
  for (const entry of all) defaults[entry.id] = entry.defaultModel;
  const hasCodexOauth = Boolean((await readCodexAuthMaterialImpl(paths))?.accessToken);
  const connected = PROVIDER_NAMES.filter((provider) => {
    const entry = store.services[provider];
    if (entry?.mode === "api_key" || entry?.mode === "oauth") return true;
    return provider === "codex-cli" && hasCodexOauth;
  });
  return { all, default: defaults, connected };
}
