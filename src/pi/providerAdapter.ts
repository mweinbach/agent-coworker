/**
 * Provider adapter: Maps our AgentConfig provider/model to pi's Model objects.
 *
 * For standard providers (anthropic, openai, google), pi has built-in model
 * definitions accessed via getModel(provider, modelId).
 *
 * For codex-cli, pi has built-in "openai-codex" provider support with
 * oauth-based authentication.
 */

import type { Model, Api } from "@mariozechner/pi-ai";
import { getModel as piGetModel, getModels as piGetModels } from "@mariozechner/pi-ai";
import type { ProviderName } from "../types";

/**
 * Maps our provider names to pi's provider names.
 */
const PROVIDER_MAP: Record<ProviderName, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  "codex-cli": "openai-codex",
};

/**
 * Resolve a pi Model object from our config's provider + modelId.
 *
 * For known models in pi's registry, uses `getModel()` directly.
 * For unknown model IDs (custom/new models not yet in pi's registry),
 * constructs a Model object by cloning a known model's metadata.
 */
export function resolvePiModel(
  provider: ProviderName,
  modelId: string,
  opts?: { apiKey?: string; baseUrl?: string; headers?: Record<string, string> },
): Model<Api> {
  const piProvider = PROVIDER_MAP[provider];

  // Try to get the exact model from pi's registry.
  try {
    const model = piGetModel(piProvider as any, modelId as any);
    if (model) {
      // Apply any overrides (apiKey passed via headers, custom baseUrl).
      if (opts?.baseUrl || opts?.headers) {
        return {
          ...model,
          ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
          ...(opts.headers ? { headers: { ...model.headers, ...opts.headers } } : {}),
        };
      }
      return model;
    }
  } catch {
    // Model not in registry — fall through to construct one.
  }

  // Model not in pi's registry. Construct one using the first known model as template.
  return buildCustomModel(piProvider, modelId, opts);
}

/**
 * Build a custom Model object for a model ID not in pi's registry.
 * Uses the first model of that provider as a template for api/baseUrl/etc.
 */
function buildCustomModel(
  piProvider: string,
  modelId: string,
  opts?: { apiKey?: string; baseUrl?: string; headers?: Record<string, string> },
): Model<Api> {
  let template: Model<Api> | undefined;
  try {
    const models = piGetModels(piProvider as any);
    template = models[0];
  } catch {
    // Provider not in registry at all.
  }

  if (!template) {
    // Absolute fallback — construct a minimal model.
    return {
      id: modelId,
      name: modelId,
      api: "openai-completions" as Api,
      provider: piProvider,
      baseUrl: opts?.baseUrl ?? "https://api.openai.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
      ...(opts?.headers ? { headers: opts.headers } : {}),
    };
  }

  return {
    ...template,
    id: modelId,
    name: modelId,
    ...(opts?.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts?.headers ? { headers: { ...template.headers, ...opts.headers } } : {}),
  };
}

/**
 * Returns all model IDs available in pi's registry for a given provider.
 */
export function listPiModels(provider: ProviderName): string[] {
  const piProvider = PROVIDER_MAP[provider];
  try {
    return piGetModels(piProvider as any).map((m) => m.id);
  } catch {
    return [];
  }
}
