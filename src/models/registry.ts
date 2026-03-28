import { z } from "zod";

import anthropicClaudeHaiku45 from "../../config/models/anthropic/claude-haiku-4-5.json";
import anthropicClaudeOpus46 from "../../config/models/anthropic/claude-opus-4-6.json";
import anthropicClaudeSonnet45 from "../../config/models/anthropic/claude-sonnet-4-5.json";
import anthropicClaudeSonnet46 from "../../config/models/anthropic/claude-sonnet-4-6.json";
import basetenMoonshotAiKimiK25 from "../../config/models/baseten/moonshotai-kimi-k2.5.json";
import basetenNvidiaNemotron120bA12b from "../../config/models/baseten/nvidia-nemotron-120b-a12b.json";
import basetenZaiOrgGlm5 from "../../config/models/baseten/zai-org-glm-5.json";
import codexCliGpt5Codex from "../../config/models/codex-cli/gpt-5-codex.json";
import codexCliGpt51CodexMax from "../../config/models/codex-cli/gpt-5.1-codex-max.json";
import codexCliGpt51CodexMini from "../../config/models/codex-cli/gpt-5.1-codex-mini.json";
import codexCliGpt51Codex from "../../config/models/codex-cli/gpt-5.1-codex.json";
import codexCliGpt51 from "../../config/models/codex-cli/gpt-5.1.json";
import codexCliGpt52Codex from "../../config/models/codex-cli/gpt-5.2-codex.json";
import codexCliGpt54 from "../../config/models/codex-cli/gpt-5.4.json";
import codexCliGpt54Mini from "../../config/models/codex-cli/gpt-5.4-mini.json";
import fireworksGlm5 from "../../config/models/fireworks/accounts-fireworks-models-glm-5.json";
import fireworksKimiK2p5 from "../../config/models/fireworks/accounts-fireworks-models-kimi-k2p5.json";
import fireworksKimiK2p5Turbo from "../../config/models/fireworks/accounts-fireworks-routers-kimi-k2p5-turbo.json";
import fireworksMinimaxM2p5 from "../../config/models/fireworks/accounts-fireworks-models-minimax-m2p5.json";
import googleGemini3FlashPreview from "../../config/models/google/gemini-3-flash-preview.json";
import googleGemini31FlashLitePreview from "../../config/models/google/gemini-3.1-flash-lite-preview.json";
import googleGemini31ProPreview from "../../config/models/google/gemini-3.1-pro-preview.json";
import googleGemini31ProPreviewCustomtools from "../../config/models/google/gemini-3.1-pro-preview-customtools.json";
import openaiGpt5Mini from "../../config/models/openai/gpt-5-mini.json";
import openaiGpt51 from "../../config/models/openai/gpt-5.1.json";
import openaiGpt52Codex from "../../config/models/openai/gpt-5.2-codex.json";
import openaiGpt52Pro from "../../config/models/openai/gpt-5.2-pro.json";
import openaiGpt52 from "../../config/models/openai/gpt-5.2.json";
import openaiGpt54 from "../../config/models/openai/gpt-5.4.json";
import openaiGpt54Mini from "../../config/models/openai/gpt-5.4-mini.json";
import nvidiaNemotron3Super120bA12b from "../../config/models/nvidia/nvidia-nemotron-3-super-120b-a12b.json";
import opencodeGoGlm5 from "../../config/models/opencode-go/glm-5.json";
import opencodeGoKimiK25 from "../../config/models/opencode-go/kimi-k2.5.json";
import opencodeZenBigPickle from "../../config/models/opencode-zen/big-pickle.json";
import opencodeZenGlm5 from "../../config/models/opencode-zen/glm-5.json";
import opencodeZenKimiK25 from "../../config/models/opencode-zen/kimi-k2.5.json";
import opencodeZenMimoV2FlashFree from "../../config/models/opencode-zen/mimo-v2-flash-free.json";
import opencodeZenMiniMaxM25Free from "../../config/models/opencode-zen/minimax-m2.5-free.json";
import opencodeZenMiniMaxM25 from "../../config/models/opencode-zen/minimax-m2.5.json";
import opencodeZenNemotron3SuperFree from "../../config/models/opencode-zen/nemotron-3-super-free.json";
import togetherMoonshotAiKimiK25 from "../../config/models/together/moonshotai-kimi-k2.5.json";
import togetherQwenQwen35397bA17b from "../../config/models/together/qwen-qwen3.5-397b-a17b.json";
import togetherZaiOrgGlm5 from "../../config/models/together/zai-org-glm-5.json";
import type { ProviderName } from "../types";

export const STATIC_MODEL_PROVIDER_NAMES = [
  "google",
  "openai",
  "anthropic",
  "baseten",
  "together",
  "fireworks",
  "nvidia",
  "opencode-go",
  "opencode-zen",
  "codex-cli",
 ] as const satisfies readonly ProviderName[];

export type StaticModelProviderName = (typeof STATIC_MODEL_PROVIDER_NAMES)[number];

const providerNameSchema = z.enum(STATIC_MODEL_PROVIDER_NAMES);

const supportedModelSchema = z.object({
  id: z.string().trim().min(1),
  provider: providerNameSchema,
  displayName: z.string().trim().min(1),
  // Vendor-published cutoff strings are user-facing metadata, not a normalized date field.
  knowledgeCutoff: z.string().trim().min(1),
  supportsImageInput: z.boolean(),
  promptTemplate: z.string().trim().min(1),
  providerOptionsDefaults: z.record(z.string(), z.unknown()),
  isDefault: z.boolean(),
}).strict();

export type SupportedModel = z.infer<typeof supportedModelSchema>;

const RAW_MODEL_REGISTRY_ENTRIES = [
  anthropicClaudeHaiku45,
  anthropicClaudeOpus46,
  anthropicClaudeSonnet45,
  anthropicClaudeSonnet46,
  basetenMoonshotAiKimiK25,
  basetenNvidiaNemotron120bA12b,
  basetenZaiOrgGlm5,
  codexCliGpt5Codex,
  codexCliGpt51CodexMax,
  codexCliGpt51CodexMini,
  codexCliGpt51Codex,
  codexCliGpt51,
  codexCliGpt52Codex,
  codexCliGpt54,
  codexCliGpt54Mini,
  fireworksGlm5,
  fireworksKimiK2p5,
  fireworksKimiK2p5Turbo,
  fireworksMinimaxM2p5,
  googleGemini3FlashPreview,
  googleGemini31FlashLitePreview,
  googleGemini31ProPreview,
  googleGemini31ProPreviewCustomtools,
  openaiGpt5Mini,
  openaiGpt51,
  openaiGpt52Codex,
  openaiGpt52Pro,
  openaiGpt52,
  openaiGpt54,
  openaiGpt54Mini,
  nvidiaNemotron3Super120bA12b,
  opencodeGoGlm5,
  opencodeGoKimiK25,
  opencodeZenBigPickle,
  opencodeZenGlm5,
  opencodeZenKimiK25,
  opencodeZenMimoV2FlashFree,
  opencodeZenMiniMaxM25Free,
  opencodeZenMiniMaxM25,
  opencodeZenNemotron3SuperFree,
  togetherMoonshotAiKimiK25,
  togetherQwenQwen35397bA17b,
  togetherZaiOrgGlm5,
] as const;
// This list needs to stay in sync with the imports above; adding a model requires both
// supplying the JSON file and including it in this array so buildRegistry actually sees it.

function buildRegistry(entries: SupportedModel[]) {
  const byProvider: Record<StaticModelProviderName, SupportedModel[]> = {
    google: [],
    openai: [],
    anthropic: [],
    baseten: [],
    together: [],
    fireworks: [],
    nvidia: [],
    "opencode-go": [],
    "opencode-zen": [],
    "codex-cli": [],
  };
  const byKey = new Map<string, SupportedModel>();
  const defaults = new Map<StaticModelProviderName, SupportedModel>();

  for (const entry of entries) {
    byProvider[entry.provider].push(entry);
    const key = `${entry.provider}:${entry.id}`;
    if (byKey.has(key)) {
      throw new Error(`Duplicate model registry entry for ${key}.`);
    }
    byKey.set(key, entry);
    if (entry.isDefault) {
      if (defaults.has(entry.provider)) {
        throw new Error(`Multiple default models configured for provider ${entry.provider}.`);
      }
      defaults.set(entry.provider, entry);
    }
  }

  for (const provider of STATIC_MODEL_PROVIDER_NAMES) {
    if (byProvider[provider].length === 0) {
      throw new Error(`No supported models configured for provider ${provider}.`);
    }
    if (!defaults.has(provider)) {
      throw new Error(`No default model configured for provider ${provider}.`);
    }
    byProvider[provider].sort((a, b) => a.id.localeCompare(b.id));
  }

  return { byProvider, byKey, defaults };
}

const MODEL_REGISTRY_ENTRIES = RAW_MODEL_REGISTRY_ENTRIES
  .map((entry) => supportedModelSchema.parse(entry))
  .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
const MODEL_REGISTRY = buildRegistry(MODEL_REGISTRY_ENTRIES);

/**
 * Legacy model ID aliases for backward compatibility.
 * Maps deprecated/legacy model IDs to their canonical replacements.
 */
const LEGACY_MODEL_ALIASES: Record<string, string> = {
  "google:gemini-3-pro-preview": "google:gemini-3.1-pro-preview-customtools",
};

export { MODEL_REGISTRY_ENTRIES };

export function isStaticRegistryProvider(provider: ProviderName): provider is StaticModelProviderName {
  return (STATIC_MODEL_PROVIDER_NAMES as readonly string[]).includes(provider);
}

export function listSupportedModels(provider: ProviderName): readonly SupportedModel[] {
  return isStaticRegistryProvider(provider) ? MODEL_REGISTRY.byProvider[provider] : [];
}

export function getSupportedModel(provider: ProviderName, modelId: string): SupportedModel | null {
  if (!isStaticRegistryProvider(provider)) return null;
  const trimmed = modelId.trim();
  const key = `${provider}:${trimmed}`;
  // Check legacy aliases first
  const aliasedKey = LEGACY_MODEL_ALIASES[key];
  const lookupKey = aliasedKey ?? key;
  return MODEL_REGISTRY.byKey.get(lookupKey) ?? null;
}

export function defaultSupportedModel(provider: ProviderName): SupportedModel {
  if (!isStaticRegistryProvider(provider)) {
    throw new Error(`Provider ${provider} uses dynamic model discovery and has no static default model.`);
  }
  const entry = MODEL_REGISTRY.defaults.get(provider);
  if (!entry) throw new Error(`Missing default model for provider ${provider}.`);
  return entry;
}

export function defaultModelIdForProvider(provider: ProviderName): string {
  return defaultSupportedModel(provider).id;
}

export function listSupportedModelIds(provider: ProviderName): readonly string[] {
  return listSupportedModels(provider).map((entry) => entry.id);
}

export function supportsImageInput(provider: ProviderName, modelId: string): boolean {
  return getSupportedModel(provider, modelId)?.supportsImageInput ?? false;
}

export function providerOptionsDefaultsForModel(provider: ProviderName, modelId: string): Record<string, unknown> {
  return { ...(getSupportedModel(provider, modelId)?.providerOptionsDefaults ?? {}) };
}

export function assertSupportedModel(provider: ProviderName, modelId: string, source = "model"): SupportedModel {
  const supported = getSupportedModel(provider, modelId);
  if (supported) return supported;

  const supportedIds = listSupportedModelIds(provider).join(", ");
  throw new Error(`Unsupported ${source} "${modelId}" for provider ${provider}. Supported models: ${supportedIds}`);
}
