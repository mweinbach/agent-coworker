import path from "node:path";

import { type AiCoworkerPaths, getAiCoworkerPaths, readConnectionStore } from "../connect";
import {
  defaultSupportedModel,
  getSupportedModel,
  listSupportedModels,
  type SupportedModel,
} from "../models/registry";
import {
  isOpenAiReasoningEffort,
  type OpenAiReasoningEffort,
} from "../shared/openaiCompatibleOptions";
import { PROVIDER_NAMES, type ProviderName } from "../types";
import { resolveAuthHomeDir } from "../utils/authHome";
import { isAntigravitySupportedPlatform } from "./antigravitySupport";
import { readBedrockCatalogSnapshot } from "./bedrockShared";
import { listCodexAppServerModels, readCodexAppServerAccount } from "./codexAppServerAuth";
import {
  listLmStudioLlms,
  lmStudioCatalogStateMessage,
  mapLmStudioModelToResolvedMetadata,
  selectDefaultLmStudioModel,
} from "./lmstudio/catalog";
import {
  isLmStudioError,
  listLmStudioModels,
  resolveLmStudioProviderOptions,
} from "./lmstudio/client";
import { getOpenCodeDisplayName } from "./opencodeShared";

function storedProviderApiKey(
  store: Awaited<ReturnType<typeof readConnectionStore>>,
  provider: ProviderName,
): string | undefined {
  const entry = store.services[provider];
  const apiKey = entry?.mode === "api_key" ? entry.apiKey?.trim() : "";
  return apiKey || undefined;
}

export type ProviderCatalogModelEntry = Pick<
  SupportedModel,
  "id" | "displayName" | "knowledgeCutoff" | "supportsImageInput"
> & {
  reasoning?: {
    defaultEffort: OpenAiReasoningEffort;
  };
};

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

function codexHomeFromPaths(paths: AiCoworkerPaths): string {
  return path.join(paths.authDir, "codex-cli");
}

const PROVIDER_LABELS: Record<ProviderName, string> = {
  google: "Google",
  openai: "OpenAI",
  anthropic: "Anthropic",
  bedrock: "Amazon Bedrock",
  baseten: "Baseten",
  together: "Together AI",
  fireworks: "Fireworks AI",
  firepass: "Fire Pass",
  nvidia: "NVIDIA",
  lmstudio: "LM Studio",
  minimax: "MiniMax",
  "opencode-go": getOpenCodeDisplayName("opencode-go"),
  "opencode-zen": getOpenCodeDisplayName("opencode-zen"),
  "codex-cli": "Codex",
  antigravity: "Antigravity",
};

function reasoningConfigForModel(
  model: Pick<SupportedModel, "providerOptionsDefaults">,
): ProviderCatalogModelEntry["reasoning"] {
  const defaultEffort = model.providerOptionsDefaults.reasoningEffort;
  return isOpenAiReasoningEffort(defaultEffort) ? { defaultEffort } : undefined;
}

function staticCatalogModelEntry(model: SupportedModel): ProviderCatalogModelEntry {
  const reasoning = reasoningConfigForModel(model);
  return {
    id: model.id,
    displayName: model.displayName,
    knowledgeCutoff: model.knowledgeCutoff,
    supportsImageInput: model.supportsImageInput,
    ...(reasoning ? { reasoning } : {}),
  };
}

function staticCatalogEntry(provider: Exclude<ProviderName, "lmstudio">): ProviderCatalogEntry {
  return {
    id: provider,
    name: PROVIDER_LABELS[provider],
    models: listSupportedModels(provider).map(staticCatalogModelEntry),
    defaultModel: defaultSupportedModel(provider).id,
  };
}

async function codexCatalogEntry(opts: {
  listCodexAppServerModelsImpl?: typeof listCodexAppServerModels;
  codexHome?: string;
}): Promise<ProviderCatalogEntry> {
  const listModels = opts.listCodexAppServerModelsImpl ?? listCodexAppServerModels;
  let appServerModels: Awaited<ReturnType<typeof listCodexAppServerModels>> = [];
  try {
    appServerModels = await listModels({ codexHome: opts.codexHome });
  } catch (error) {
    return {
      id: "codex-cli",
      name: PROVIDER_LABELS["codex-cli"],
      models: [],
      defaultModel: "",
      state: "unreachable",
      message: error instanceof Error ? error.message : "Unable to read Codex app-server models.",
    };
  }

  const resolveLiveModel = (model: (typeof appServerModels)[number]) => {
    const supported =
      getSupportedModel("codex-cli", model.model) ?? getSupportedModel("codex-cli", model.id);
    const id = supported?.id ?? model.model ?? model.id;
    return { id, supported };
  };
  const modelsById = new Map<string, ProviderCatalogModelEntry>();
  for (const model of appServerModels) {
    const live = resolveLiveModel(model);
    if (modelsById.has(live.id)) continue;
    const reasoning = live.supported ? reasoningConfigForModel(live.supported) : undefined;
    modelsById.set(live.id, {
      id: live.id,
      displayName: model.displayName || live.supported?.displayName || live.id,
      knowledgeCutoff: live.supported?.knowledgeCutoff ?? "Unknown",
      supportsImageInput: live.supported?.supportsImageInput ?? model.supportsImageInput ?? false,
      ...(reasoning ? { reasoning } : {}),
    });
  }
  const models = [...modelsById.values()];
  if (models.length === 0) {
    return {
      id: "codex-cli",
      name: PROVIDER_LABELS["codex-cli"],
      models: [],
      defaultModel: "",
      state: "empty",
      message: "Codex app-server did not report any locally supported models.",
    };
  }

  const defaultFromAppServer = appServerModels.find((model) => model.isDefault);
  const defaultModel =
    (defaultFromAppServer ? resolveLiveModel(defaultFromAppServer).id : undefined) ??
    models[0]?.id ??
    "";

  return {
    id: "codex-cli",
    name: PROVIDER_LABELS["codex-cli"],
    models,
    defaultModel,
    state: "ready",
  };
}

async function bedrockCatalogEntry(opts: {
  providerOptions?: unknown;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  paths?: AiCoworkerPaths;
}): Promise<{ entry: ProviderCatalogEntry; connected: boolean }> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: opts.homedir ?? resolveAuthHomeDir() });
  const snapshot = await readBedrockCatalogSnapshot({
    paths,
    env: opts.env,
  });
  return {
    entry: {
      id: "bedrock",
      name: PROVIDER_LABELS.bedrock,
      models: snapshot.models.map((model) => ({
        id: model.id,
        displayName: model.displayName,
        knowledgeCutoff: model.knowledgeCutoff,
        supportsImageInput: model.supportsImageInput,
      })),
      defaultModel: snapshot.defaultModel,
      ...(snapshot.state ? { state: snapshot.state } : {}),
      ...(snapshot.message ? { message: snapshot.message } : {}),
    },
    connected: snapshot.connected,
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
    const models = (
      await listLmStudioModels({
        baseUrl: provider.baseUrl,
        apiKey:
          provider.apiKey ??
          (opts.store ? storedProviderApiKey(opts.store, "lmstudio") : undefined),
        fetchImpl: opts.lmstudioFetchImpl,
      })
    ).models;
    const llms = listLmStudioLlms(models);
    const defaultModel =
      llms.length > 0 ? selectDefaultLmStudioModel(models, provider.baseUrl).key : "";
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

export async function listProviderCatalogEntries(
  opts: {
    store?: Awaited<ReturnType<typeof readConnectionStore>>;
    providerOptions?: unknown;
    env?: NodeJS.ProcessEnv;
    lmstudioFetchImpl?: typeof fetch;
    listCodexAppServerModelsImpl?: typeof listCodexAppServerModels;
    platform?: NodeJS.Platform;
  } = {},
): Promise<ProviderCatalogEntry[]> {
  const bedrock = await bedrockCatalogEntry({
    providerOptions: opts.providerOptions,
    env: opts.env,
  });
  const lmstudio = await lmStudioCatalogEntry(opts);
  const codex = opts.listCodexAppServerModelsImpl
    ? await codexCatalogEntry({ listCodexAppServerModelsImpl: opts.listCodexAppServerModelsImpl })
    : staticCatalogEntry("codex-cli");
  return PROVIDER_NAMES.filter(
    (provider) => provider !== "antigravity" || isAntigravitySupportedPlatform(opts.platform),
  ).map((provider) => {
    if (provider === "bedrock") return bedrock.entry;
    if (provider === "lmstudio") return lmstudio.entry;
    if (provider === "codex-cli") return codex;
    return staticCatalogEntry(provider);
  });
}

export async function getProviderCatalog(
  opts: {
    homedir?: string;
    paths?: AiCoworkerPaths;
    readStore?: typeof readConnectionStore;
    readCodexAppServerAccountImpl?: typeof readCodexAppServerAccount;
    listCodexAppServerModelsImpl?: typeof listCodexAppServerModels;
    providerOptions?: unknown;
    env?: NodeJS.ProcessEnv;
    lmstudioFetchImpl?: typeof fetch;
    platform?: NodeJS.Platform;
  } = {},
): Promise<ProviderCatalogPayload> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: opts.homedir ?? resolveAuthHomeDir() });
  const readStore = opts.readStore ?? readConnectionStore;
  const readCodexAppServerAccountImpl =
    opts.readCodexAppServerAccountImpl ?? readCodexAppServerAccount;
  const store = await readStore(paths);
  const codexHome = codexHomeFromPaths(paths);
  const bedrock = await bedrockCatalogEntry({
    paths,
    providerOptions: opts.providerOptions,
    env: opts.env,
  });
  const hasCodexAccount = Boolean(
    await readCodexAppServerAccountImpl({ refreshToken: false, codexHome }).then(
      (result) => result.account,
      () => null,
    ),
  );
  const lmstudio = await lmStudioCatalogEntry({
    store,
    providerOptions: opts.providerOptions,
    env: opts.env,
    lmstudioFetchImpl: opts.lmstudioFetchImpl,
  });
  const codex = hasCodexAccount
    ? await codexCatalogEntry({
        listCodexAppServerModelsImpl: opts.listCodexAppServerModelsImpl,
        codexHome,
      })
    : staticCatalogEntry("codex-cli");
  const all = PROVIDER_NAMES.filter(
    (provider) => provider !== "antigravity" || isAntigravitySupportedPlatform(opts.platform),
  ).map((provider) => {
    if (provider === "bedrock") return bedrock.entry;
    if (provider === "lmstudio") return lmstudio.entry;
    if (provider === "codex-cli") return codex;
    return staticCatalogEntry(provider);
  });
  const defaults: Record<string, string> = {};
  for (const entry of all) defaults[entry.id] = entry.defaultModel;
  const connected = PROVIDER_NAMES.filter((provider) => {
    if (provider === "lmstudio") {
      return lmstudio.connected;
    }
    if (provider === "bedrock") {
      return bedrock.connected;
    }
    const entry = store.services[provider];
    if (provider === "antigravity" && !isAntigravitySupportedPlatform(opts.platform)) {
      return false;
    }
    if (entry?.mode === "api_key" || entry?.mode === "oauth") return true;
    return provider === "codex-cli" && hasCodexAccount;
  });
  return { all, default: defaults, connected };
}
