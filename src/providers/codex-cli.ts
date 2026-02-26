import path from "node:path";

import type { Model, Api, SimpleStreamOptions } from "../pi/types";

import { getAiCoworkerPaths, type AiCoworkerPaths } from "../connect";
import { resolvePiModel } from "../pi/providerAdapter";
import type { AgentConfig } from "../types";
import {
  CODEX_BACKEND_BASE_URL,
  codexAuthFilePath,
  isTokenExpiring,
  readCodexAuthMaterial,
  refreshCodexAuthMaterial,
  type CodexAuthMaterial,
} from "./codex-auth";

/**
 * Default stream options for Codex CLI models.
 */
export const DEFAULT_CODEX_CLI_STREAM_OPTIONS: SimpleStreamOptions = {
  reasoning: "high",
};

/**
 * Legacy shape preserved for config compatibility.
 */
export const DEFAULT_CODEX_CLI_PROVIDER_OPTIONS = {
  reasoningEffort: "high",
  reasoningSummary: "detailed",
  textVerbosity: "high",
} as const;

const refreshInflightByAuthFile = new Map<string, Promise<CodexAuthMaterial>>();

function resolveCoworkPaths(config: AgentConfig): AiCoworkerPaths {
  const homedir = config.userAgentDir ? path.dirname(config.userAgentDir) : undefined;
  return getAiCoworkerPaths({ homedir });
}

async function loadCodexAuthForRequest(opts: {
  paths: AiCoworkerPaths;
  fetchImpl: typeof fetch;
  forceRefresh?: boolean;
}): Promise<CodexAuthMaterial> {
  const material = await readCodexAuthMaterial(opts.paths, { migrateLegacy: true });
  if (!material?.accessToken) {
    throw new Error("Codex auth is missing. Run /connect codex-cli to authenticate.");
  }

  const refreshNeeded = opts.forceRefresh === true || isTokenExpiring(material);
  if (!refreshNeeded) return material;

  if (!material.refreshToken) {
    if (!opts.forceRefresh && !isTokenExpiring(material, 0)) return material;
    throw new Error("Codex token expired and refresh token is missing. Reconnect codex-cli.");
  }

  const key = codexAuthFilePath(opts.paths);
  const existing = refreshInflightByAuthFile.get(key);
  if (existing) return await existing;

  const refreshPromise = refreshCodexAuthMaterial({
    paths: opts.paths,
    material,
    fetchImpl: opts.fetchImpl,
  }).finally(() => {
    refreshInflightByAuthFile.delete(key);
  });
  refreshInflightByAuthFile.set(key, refreshPromise);

  try {
    return await refreshPromise;
  } catch {
    // If token is still currently valid and this was a preflight refresh attempt, proceed.
    if (!opts.forceRefresh && !isTokenExpiring(material, 0)) return material;
    throw new Error("Failed to refresh Codex auth token.");
  }
}

/**
 * Resolves a fresh Codex CLI API key (OAuth access token).
 *
 * Used by the agent loop's `getApiKey` callback to dynamically provide
 * the token for each LLM call, handling automatic refresh.
 */
export async function resolveCodexApiKey(config: AgentConfig): Promise<string> {
  const paths = resolveCoworkPaths(config);
  const material = await loadCodexAuthForRequest({ paths, fetchImpl: fetch });
  return material.accessToken;
}

/**
 * Resolves additional headers needed for Codex requests (e.g., account ID).
 */
export async function resolveCodexHeaders(config: AgentConfig): Promise<Record<string, string>> {
  const paths = resolveCoworkPaths(config);
  const material = await readCodexAuthMaterial(paths, { migrateLegacy: true });
  const headers: Record<string, string> = {};
  if (material?.accountId?.trim()) {
    headers["ChatGPT-Account-ID"] = material.accountId.trim();
  }
  return headers;
}

export const codexCliProvider = {
  keyCandidates: ["codex-cli", "openai"] as const,
  createModel: ({ config, modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }): Model<Api> => {
    if (savedKey) {
      // When using a saved API key directly, treat it as a standard OpenAI model.
      return resolvePiModel("openai", modelId, { apiKey: savedKey });
    }

    // For OAuth-based codex, return a model with the codex backend URL.
    // The actual auth token is provided dynamically via getApiKey in the agent loop.
    return resolvePiModel("codex-cli", modelId, {
      baseUrl: CODEX_BACKEND_BASE_URL,
    });
  },
};
