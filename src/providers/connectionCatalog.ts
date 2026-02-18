import { getAiCoworkerPaths, readConnectionStore, type AiCoworkerPaths } from "../connect";
import { PROVIDER_NAMES, type ProviderName } from "../types";
import { PROVIDER_MODEL_CATALOG } from "./catalog";

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
} = {}): Promise<ProviderCatalogPayload> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: opts.homedir });
  const readStore = opts.readStore ?? readConnectionStore;
  const store = await readStore(paths);
  const all = listProviderCatalogEntries();
  const defaults: Record<string, string> = {};
  for (const entry of all) defaults[entry.id] = entry.defaultModel;
  const connected = PROVIDER_NAMES.filter((provider) => {
    const entry = store.services[provider];
    return entry?.mode === "api_key" || entry?.mode === "oauth";
  });
  return { all, default: defaults, connected };
}
