import path from "node:path";

import { createOpenAI, type OpenAIResponsesProviderOptions } from "@ai-sdk/openai";

import { getAiCoworkerPaths, type AiCoworkerPaths } from "../connect";
import type { AgentConfig } from "../types";
import {
  CODEX_BACKEND_BASE_URL,
  codexAuthFilePath,
  isTokenExpiring,
  readCodexAuthMaterial,
  refreshCodexAuthMaterial,
  type CodexAuthMaterial,
} from "./codex-auth";

export const DEFAULT_CODEX_CLI_PROVIDER_OPTIONS = {
  reasoningEffort: "high",
  reasoningSummary: "detailed",
  textVerbosity: "high",
} as const satisfies OpenAIResponsesProviderOptions;

const refreshInflightByAuthFile = new Map<string, Promise<CodexAuthMaterial>>();

function resolveCoworkPaths(config: AgentConfig): AiCoworkerPaths {
  const homedir = config.userAgentDir ? path.dirname(config.userAgentDir) : undefined;
  return getAiCoworkerPaths({ homedir });
}

function applyCodexAuth(request: Request, material: CodexAuthMaterial): Request {
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${material.accessToken}`);
  if (material.accountId?.trim()) {
    headers.set("ChatGPT-Account-ID", material.accountId.trim());
  }
  return new Request(request, { headers });
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

function createCodexAuthFetch(paths: AiCoworkerPaths): typeof fetch {
  return async (input, init) => {
    const requestTemplate = new Request(input, init);
    const firstRequest = requestTemplate.clone();
    const retryRequest = requestTemplate.clone();

    const material = await loadCodexAuthForRequest({ paths, fetchImpl: fetch });
    const firstResponse = await fetch(applyCodexAuth(firstRequest, material));
    if (firstResponse.status !== 401 || !material.refreshToken) return firstResponse;

    try {
      const refreshed = await loadCodexAuthForRequest({
        paths,
        fetchImpl: fetch,
        forceRefresh: true,
      });
      return await fetch(applyCodexAuth(retryRequest, refreshed));
    } catch {
      return firstResponse;
    }
  };
}

export const codexCliProvider = {
  keyCandidates: ["codex-cli", "openai"] as const,
  createModel: ({ config, modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }) => {
    if (savedKey) {
      return createOpenAI({ name: "codex-cli", apiKey: savedKey })(modelId);
    }

    const paths = resolveCoworkPaths(config);
    const provider = createOpenAI({
      name: "codex-cli",
      apiKey: "unused",
      baseURL: CODEX_BACKEND_BASE_URL,
      fetch: createCodexAuthFetch(paths),
    });
    return provider(modelId);
  },
};
