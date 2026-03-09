import { getAiCoworkerPaths } from "../connect";
import type { AgentConfig } from "../types";
import {
  isTokenExpiring,
  readCodexAuthMaterial,
  refreshCodexAuthMaterialCoalesced,
} from "./codex-auth";
import { resolveCoworkHomedir } from "../utils/coworkHome";

type HeaderMap = Record<string, string>;
type HeaderResolver = () => Promise<HeaderMap>;

export type ProviderModelAdapter = {
  modelId: string;
  provider: string;
  specificationVersion: "v3";
  config: {
    headers: HeaderResolver;
  };
};

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function envKey(...candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const value = process.env[candidate]?.trim();
    if (value) return value;
  }
  return undefined;
}

function createModelAdapter(modelId: string, provider: string, headers: HeaderResolver): ProviderModelAdapter {
  return {
    modelId,
    provider,
    specificationVersion: "v3",
    config: {
      headers,
    },
  };
}

export function createOpenAiModelAdapter(modelId: string, savedKey?: string): ProviderModelAdapter {
  return createModelAdapter(modelId, "openai.responses", async () => {
    const key = firstNonEmpty(savedKey, envKey("OPENAI_API_KEY"));
    const headers: HeaderMap = {};
    if (key) {
      headers.authorization = `Bearer ${key}`;
    }
    return headers;
  });
}

export function createGoogleModelAdapter(modelId: string, savedKey?: string): ProviderModelAdapter {
  return createModelAdapter(modelId, "google.generative-ai", async () => {
    const key = firstNonEmpty(savedKey, envKey("GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"));
    const headers: HeaderMap = {};
    if (key) {
      headers["x-goog-api-key"] = key;
    }
    return headers;
  });
}

export function createAnthropicModelAdapter(modelId: string, savedKey?: string): ProviderModelAdapter {
  return createModelAdapter(modelId, "anthropic.messages", async () => {
    const key = firstNonEmpty(savedKey, envKey("ANTHROPIC_API_KEY"));
    const headers: HeaderMap = {};
    if (key) {
      headers["x-api-key"] = key;
    }
    return headers;
  });
}

async function resolveCodexAuthHeaders(config: AgentConfig): Promise<HeaderMap> {
  const paths = getAiCoworkerPaths({ homedir: resolveCoworkHomedir(config.userAgentDir) });

  let material = await readCodexAuthMaterial(paths);
  if (!material?.accessToken) return {};

  if (isTokenExpiring(material) && material.refreshToken) {
    material = await refreshCodexAuthMaterialCoalesced({
      paths,
      material,
      fetchImpl: fetch,
    });
  }

  if (isTokenExpiring(material, 0)) {
    throw new Error("Codex token is expired. Run /connect codex-cli to re-authenticate.");
  }

  const headers: HeaderMap = {
    authorization: `Bearer ${material.accessToken}`,
  };
  if (material.accountId?.trim()) {
    headers["ChatGPT-Account-ID"] = material.accountId.trim();
  }
  return headers;
}

export function createCodexCliModelAdapter(
  config: AgentConfig,
  modelId: string,
  savedKey?: string
): ProviderModelAdapter {
  return createModelAdapter(modelId, "codex-cli.responses", async () => {
    const key = firstNonEmpty(savedKey);
    if (key) return { authorization: `Bearer ${key}` };
    return await resolveCodexAuthHeaders(config);
  });
}
