import { getAiCoworkerPaths, readConnectionStore, type AiCoworkerPaths } from "../connect";
import { PROVIDER_NAMES, type ProviderName } from "../types";
import { PROVIDER_MODEL_CATALOG } from "./catalog";
import { readCodexAuthMaterial } from "./codex-auth";

export type ProviderCatalogEntry = {
  id: ProviderName;
  name: string;
  models: string[];
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
  "codex-cli": "Codex CLI",
};

export function listProviderCatalogEntries(): ProviderCatalogEntry[] {
  return PROVIDER_NAMES.map((provider) => ({
    id: provider,
    name: PROVIDER_LABELS[provider],
    models: [...PROVIDER_MODEL_CATALOG[provider].availableModels],
    defaultModel: PROVIDER_MODEL_CATALOG[provider].defaultModel,
  }));
}

export async function getProviderCatalog(opts: {
  homedir?: string;
  paths?: AiCoworkerPaths;
  readStore?: typeof readConnectionStore;
  readCodexAuthMaterialImpl?: typeof readCodexAuthMaterial;
} = {}): Promise<ProviderCatalogPayload> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: opts.homedir });
  const readStore = opts.readStore ?? readConnectionStore;
  const readCodexAuthMaterialImpl = opts.readCodexAuthMaterialImpl ?? readCodexAuthMaterial;
  const store = await readStore(paths);
  const all = listProviderCatalogEntries();
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
