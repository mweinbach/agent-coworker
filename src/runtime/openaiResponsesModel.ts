import { getSavedProviderApiKey, getSavedProviderApiKeyForHome } from "../config";
import { getAiCoworkerPaths } from "../connect";
import { assertSupportedModel } from "../models/registry";
import {
  CODEX_BACKEND_BASE_URL,
  isTokenExpiring,
  readCodexAuthMaterial,
  refreshCodexAuthMaterialCoalesced,
} from "../providers/codex-auth";
import type { AgentConfig } from "../types";
import { resolveAuthHomeDir } from "../utils/authHome";

import { type PiModel, pickKnownPiModel } from "./piRuntimeOptions";
import type { RuntimeRunTurnParams } from "./types";

const OPENAI_RESPONSES_BASE_URL = "https://api.openai.com/v1";

type SupportedResponsesModelLimits = Pick<PiModel, "contextWindow" | "maxTokens">;

// Keep runtime token limits pinned to the supported registry surface so we do not
// inherit unrelated fallback values from PI's broader model catalog.
const SUPPORTED_OPENAI_RESPONSES_MODEL_LIMITS: Record<string, SupportedResponsesModelLimits> = {
  "gpt-5-mini": { contextWindow: 400_000, maxTokens: 128_000 },
  "gpt-5.2": { contextWindow: 400_000, maxTokens: 128_000 },
  "gpt-5.2-pro": { contextWindow: 400_000, maxTokens: 128_000 },
  "gpt-5.4": { contextWindow: 400_000, maxTokens: 128_000 },
  "gpt-5.4-mini": { contextWindow: 400_000, maxTokens: 128_000 },
  "gpt-5.5": { contextWindow: 1_050_000, maxTokens: 128_000 },
};

const SUPPORTED_CODEX_BACKEND_MODEL_LIMITS: Record<string, SupportedResponsesModelLimits> = {
  "gpt-5.4": { contextWindow: 272_000, maxTokens: 128_000 },
  "gpt-5.4-mini": { contextWindow: 272_000, maxTokens: 128_000 },
  "gpt-5.5": { contextWindow: 400_000, maxTokens: 128_000 },
};

type ResolvedOpenAiResponsesModel = {
  model: PiModel;
  apiKey?: string;
  headers?: Record<string, string>;
  accountId?: string;
};

type ResolvedCodexAuth = {
  accessToken: string;
  accountId?: string;
};

async function resolveCodexAccessToken(
  config: AgentConfig,
  log?: (line: string) => void,
): Promise<ResolvedCodexAuth> {
  void config;
  // Codex auth is stored in the user-global Cowork home, not under a workspace
  // `.agent` root.
  const paths = getAiCoworkerPaths({ homedir: resolveAuthHomeDir(config) });
  let material = await readCodexAuthMaterial(paths);
  if (!material?.accessToken) {
    throw new Error("Codex auth is missing. Run /connect codex-cli to authenticate.");
  }

  if (isTokenExpiring(material) && material.refreshToken) {
    try {
      material = await refreshCodexAuthMaterialCoalesced({
        paths,
        material,
        fetchImpl: fetch,
      });
      log?.("[auth] refreshed Codex runtime token");
    } catch (error) {
      log?.(`[warn] failed to refresh Codex runtime token: ${String(error)}`);
    }
  }

  if (isTokenExpiring(material, 0)) {
    throw new Error("Codex token is expired. Run /connect codex-cli to re-authenticate.");
  }

  const accountId = material.accountId?.trim();
  return {
    accessToken: material.accessToken,
    ...(accountId ? { accountId } : {}),
  };
}

function applySupportedOpenAiResponsesModel(
  provider: "openai" | "codex-cli",
  modelId: string,
  model: PiModel,
): PiModel {
  const supported = assertSupportedModel(provider, modelId, "model");
  const supportedLimits =
    provider === "openai" ? SUPPORTED_OPENAI_RESPONSES_MODEL_LIMITS[supported.id] : undefined;
  if (provider === "openai" && !supportedLimits) {
    throw new Error(
      `Missing supported OpenAI Responses model limits for openai model ${supported.id}.`,
    );
  }
  return {
    ...model,
    id: supported.id,
    name: supported.id,
    input: supported.supportsImageInput ? ["text", "image"] : ["text"],
    ...(supportedLimits ?? {}),
  };
}

function buildSupportedCodexResponsesModel(opts: {
  modelId: string;
  api: "openai-responses" | "openai-codex-responses";
  provider: "openai" | "openai-codex";
  baseUrl: string;
  headers?: Record<string, string>;
}): PiModel {
  const supportedLimits =
    opts.api === "openai-codex-responses"
      ? SUPPORTED_CODEX_BACKEND_MODEL_LIMITS[opts.modelId]
      : SUPPORTED_OPENAI_RESPONSES_MODEL_LIMITS[opts.modelId];

  if (!supportedLimits) {
    throw new Error(
      `Missing supported OpenAI Responses model limits for codex-cli model ${opts.modelId}.`,
    );
  }

  return applySupportedOpenAiResponsesModel("codex-cli", opts.modelId, {
    id: opts.modelId,
    name: opts.modelId,
    api: opts.api,
    provider: opts.provider,
    baseUrl: opts.baseUrl,
    reasoning: true,
    input: ["text"],
    ...supportedLimits,
    ...(opts.headers ? { headers: { ...opts.headers } } : {}),
  });
}

export async function resolveOpenAiResponsesModel(
  params: RuntimeRunTurnParams,
): Promise<ResolvedOpenAiResponsesModel> {
  const modelId = params.config.model;
  const provider = params.config.provider;

  if (provider === "openai") {
    const model = pickKnownPiModel("openai", modelId);
    if (!model) {
      throw new Error(
        `No OpenAI Responses model metadata available for provider openai (model: ${modelId}).`,
      );
    }
    return {
      model: applySupportedOpenAiResponsesModel(provider, modelId, model),
      apiKey: getSavedProviderApiKey(params.config, "openai"),
    };
  }

  if (provider !== "codex-cli") {
    throw new Error(`Unsupported provider for OpenAI Responses runtime: ${provider}`);
  }

  const savedKey = getSavedProviderApiKeyForHome(resolveAuthHomeDir(params.config), "codex-cli");
  if (savedKey) {
    return {
      model: buildSupportedCodexResponsesModel({
        modelId,
        api: "openai-responses",
        provider: "openai",
        baseUrl: OPENAI_RESPONSES_BASE_URL,
      }),
      apiKey: savedKey,
    };
  }

  const codexAuth = await resolveCodexAccessToken(params.config, params.log);
  const codexHeaders = codexAuth.accountId
    ? { "ChatGPT-Account-ID": codexAuth.accountId }
    : undefined;

  return {
    model: buildSupportedCodexResponsesModel({
      modelId,
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: CODEX_BACKEND_BASE_URL,
      ...(codexHeaders ? { headers: codexHeaders } : {}),
    }),
    apiKey: codexAuth.accessToken,
    ...(codexAuth.accountId ? { accountId: codexAuth.accountId } : {}),
    ...(codexHeaders ? { headers: codexHeaders } : {}),
  };
}
