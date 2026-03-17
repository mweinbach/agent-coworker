import { getAiCoworkerPaths } from "../connect";
import type { AgentConfig } from "../types";
import {
  getOpenCodeProviderConfig,
  isOpenCodeModelSupportedByProvider,
  resolveOpenCodeApiKey,
  type OpenCodeProviderName,
} from "./opencodeShared";
import {
  isTokenExpiring,
  readCodexAuthMaterial,
  refreshCodexAuthMaterialCoalesced,
} from "./codex-auth";
import {
  OPENAI_PROXY_DISABLED_BETA_HEADER,
  OPENAI_PROXY_DISABLED_BETA_HEADER_VALUE,
} from "./openaiProxyShared";
import { resolveAuthHomeDir } from "../utils/authHome";

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

export function createBasetenModelAdapter(modelId: string, savedKey?: string): ProviderModelAdapter {
  return createModelAdapter(modelId, "baseten.completions", async () => {
    const key = firstNonEmpty(savedKey, envKey("BASETEN_API_KEY"));
    const headers: HeaderMap = {};
    if (key) {
      headers.authorization = `Api-Key ${key}`;
    }
    return headers;
  });
}

export function createTogetherModelAdapter(modelId: string, savedKey?: string): ProviderModelAdapter {
  return createModelAdapter(modelId, "together.completions", async () => {
    const key = firstNonEmpty(savedKey, envKey("TOGETHER_API_KEY"));
    const headers: HeaderMap = {};
    if (key) {
      headers.authorization = `Bearer ${key}`;
    }
    return headers;
  });
}

export function createOpenAiProxyModelAdapter(modelId: string, savedKey?: string): ProviderModelAdapter {
  return createModelAdapter(modelId, "openai-proxy.completions", async () => {
    const key = firstNonEmpty(savedKey, envKey("OPENAI_PROXY_API_KEY"));
    const headers: HeaderMap = {
      [OPENAI_PROXY_DISABLED_BETA_HEADER]: OPENAI_PROXY_DISABLED_BETA_HEADER_VALUE,
    };
    if (key) {
      headers.authorization = `Bearer ${key}`;
    }
    return headers;
  });
}

export function createNvidiaModelAdapter(modelId: string, savedKey?: string): ProviderModelAdapter {
  return createModelAdapter(modelId, "nvidia.completions", async () => {
    const key = firstNonEmpty(savedKey, envKey("NVIDIA_API_KEY"));
    const headers: HeaderMap = {};
    if (key) {
      headers.authorization = `Bearer ${key}`;
    }
    return headers;
  });
}

function createOpenCodeModelAdapter(
  provider: OpenCodeProviderName,
  modelId: string,
  savedKey?: string,
): ProviderModelAdapter {
  if (!isOpenCodeModelSupportedByProvider(provider, modelId)) {
    throw new Error(`${provider} does not support model ${modelId}.`);
  }
  const providerConfig = getOpenCodeProviderConfig(provider);
  return createModelAdapter(modelId, providerConfig.adapterProvider, async () => {
    const key = resolveOpenCodeApiKey(provider, { savedKey });
    const headers: HeaderMap = {};
    if (key) {
      headers.authorization = `Bearer ${key}`;
    }
    return headers;
  });
}

export function createOpenCodeGoModelAdapter(modelId: string, savedKey?: string): ProviderModelAdapter {
  return createOpenCodeModelAdapter("opencode-go", modelId, savedKey);
}

export function createOpenCodeZenModelAdapter(modelId: string, savedKey?: string): ProviderModelAdapter {
  return createOpenCodeModelAdapter("opencode-zen", modelId, savedKey);
}

async function resolveCodexAuthHeaders(config: AgentConfig): Promise<HeaderMap> {
  void config;
  // Model adapter auth must read the user-global Cowork auth store so a
  // workspace-local `.agent` directory cannot hide an existing login.
  const paths = getAiCoworkerPaths({ homedir: resolveAuthHomeDir(config) });

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
