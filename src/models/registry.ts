import { z } from "zod";

import anthropicClaudeHaiku45 from "../../config/models/anthropic/claude-haiku-4-5.json";
import anthropicClaudeOpus46 from "../../config/models/anthropic/claude-opus-4-6.json";
import anthropicClaudeOpus47 from "../../config/models/anthropic/claude-opus-4-7.json";
import anthropicClaudeOpus48 from "../../config/models/anthropic/claude-opus-4-8.json";
import anthropicClaudeSonnet45 from "../../config/models/anthropic/claude-sonnet-4-5.json";
import anthropicClaudeSonnet46 from "../../config/models/anthropic/claude-sonnet-4-6.json";
import antigravityGemini31FlashLite from "../../config/models/antigravity/gemini-3.1-flash-lite.json";
import antigravityGemini31Pro from "../../config/models/antigravity/gemini-3.1-pro-preview.json";
import antigravityGemini35Flash from "../../config/models/antigravity/gemini-3.5-flash.json";
import basetenMoonshotAiKimiK25 from "../../config/models/baseten/moonshotai-kimi-k2.5.json";
import basetenNvidiaNemotron120bA12b from "../../config/models/baseten/nvidia-nemotron-120b-a12b.json";
import basetenZaiOrgGlm5 from "../../config/models/baseten/zai-org-glm-5.json";
import bedrockAmazonNovaLiteV10 from "../../config/models/bedrock/amazon.nova-lite-v1-0.json";
import bedrockAmazonNovaMicroV10 from "../../config/models/bedrock/amazon.nova-micro-v1-0.json";
import bedrockAnthropicClaude35Haiku20241022V10 from "../../config/models/bedrock/anthropic.claude-3-5-haiku-20241022-v1-0.json";
import codexCliGpt53CodexSpark from "../../config/models/codex-cli/gpt-5.3-codex-spark.json";
import codexCliGpt54 from "../../config/models/codex-cli/gpt-5.4.json";
import codexCliGpt54Mini from "../../config/models/codex-cli/gpt-5.4-mini.json";
import codexCliGpt55 from "../../config/models/codex-cli/gpt-5.5.json";
import firepassKimiK2p6Turbo from "../../config/models/firepass/accounts-fireworks-routers-kimi-k2p6-turbo.json";
import fireworksDeepseekV4Pro from "../../config/models/fireworks/accounts-fireworks-models-deepseek-v4-pro.json";
import fireworksGlm5p1 from "../../config/models/fireworks/accounts-fireworks-models-glm-5p1.json";
import fireworksKimiK2p6 from "../../config/models/fireworks/accounts-fireworks-models-kimi-k2p6.json";
import fireworksMinimaxM2p7 from "../../config/models/fireworks/accounts-fireworks-models-minimax-m2p7.json";
import fireworksQwen3p6Plus from "../../config/models/fireworks/accounts-fireworks-models-qwen3p6-plus.json";
import googleGemini31FlashLite from "../../config/models/google/gemini-3.1-flash-lite.json";
import googleGemini31ProPreview from "../../config/models/google/gemini-3.1-pro-preview.json";
import googleGemini31ProPreviewCustomtools from "../../config/models/google/gemini-3.1-pro-preview-customtools.json";
import googleGemini35Flash from "../../config/models/google/gemini-3.5-flash.json";
import googleGemini3FlashPreview from "../../config/models/google/gemini-3-flash-preview.json";
import minimaxM3 from "../../config/models/minimax/MiniMax-M3.json";
import nvidiaNemotron3Super120bA12b from "../../config/models/nvidia/nvidia-nemotron-3-super-120b-a12b.json";
import openaiGpt52 from "../../config/models/openai/gpt-5.2.json";
import openaiGpt52Pro from "../../config/models/openai/gpt-5.2-pro.json";
import openaiGpt54 from "../../config/models/openai/gpt-5.4.json";
import openaiGpt54Mini from "../../config/models/openai/gpt-5.4-mini.json";
import openaiGpt54Nano from "../../config/models/openai/gpt-5.4-nano.json";
import openaiGpt54Pro from "../../config/models/openai/gpt-5.4-pro.json";
import openaiGpt55 from "../../config/models/openai/gpt-5.5.json";
import openaiGpt5Mini from "../../config/models/openai/gpt-5-mini.json";
import opencodeGoDeepseekV4Flash from "../../config/models/opencode-go/deepseek-v4-flash.json";
import opencodeGoDeepseekV4Pro from "../../config/models/opencode-go/deepseek-v4-pro.json";
import opencodeGoGlm51 from "../../config/models/opencode-go/glm-5.1.json";
import opencodeGoGlm5 from "../../config/models/opencode-go/glm-5.json";
import opencodeGoHy3Preview from "../../config/models/opencode-go/hy3-preview.json";
import opencodeGoKimiK25 from "../../config/models/opencode-go/kimi-k2.5.json";
import opencodeGoKimiK26 from "../../config/models/opencode-go/kimi-k2.6.json";
import opencodeGoMimoV25 from "../../config/models/opencode-go/mimo-v2.5.json";
import opencodeGoMimoV25Pro from "../../config/models/opencode-go/mimo-v2.5-pro.json";
import opencodeGoMimoV2Omni from "../../config/models/opencode-go/mimo-v2-omni.json";
import opencodeGoMimoV2Pro from "../../config/models/opencode-go/mimo-v2-pro.json";
import opencodeGoMinimaxM25 from "../../config/models/opencode-go/minimax-m2.5.json";
import opencodeGoMinimaxM27 from "../../config/models/opencode-go/minimax-m2.7.json";
import opencodeGoMinimaxM3 from "../../config/models/opencode-go/minimax-m3.json";
import opencodeGoQwen35Plus from "../../config/models/opencode-go/qwen3.5-plus.json";
import opencodeGoQwen36Plus from "../../config/models/opencode-go/qwen3.6-plus.json";
import opencodeGoQwen37Max from "../../config/models/opencode-go/qwen3.7-max.json";
import opencodeGoQwen37Plus from "../../config/models/opencode-go/qwen3.7-plus.json";
import opencodeZenBigPickle from "../../config/models/opencode-zen/big-pickle.json";
import opencodeZenClaudeHaiku45 from "../../config/models/opencode-zen/claude-haiku-4-5.json";
import opencodeZenClaudeOpus41 from "../../config/models/opencode-zen/claude-opus-4-1.json";
import opencodeZenClaudeOpus45 from "../../config/models/opencode-zen/claude-opus-4-5.json";
import opencodeZenClaudeOpus46 from "../../config/models/opencode-zen/claude-opus-4-6.json";
import opencodeZenClaudeOpus47 from "../../config/models/opencode-zen/claude-opus-4-7.json";
import opencodeZenClaudeOpus48 from "../../config/models/opencode-zen/claude-opus-4-8.json";
import opencodeZenClaudeSonnet4 from "../../config/models/opencode-zen/claude-sonnet-4.json";
import opencodeZenClaudeSonnet45 from "../../config/models/opencode-zen/claude-sonnet-4-5.json";
import opencodeZenClaudeSonnet46 from "../../config/models/opencode-zen/claude-sonnet-4-6.json";
import opencodeZenDeepseekV4Flash from "../../config/models/opencode-zen/deepseek-v4-flash.json";
import opencodeZenDeepseekV4FlashFree from "../../config/models/opencode-zen/deepseek-v4-flash-free.json";
import opencodeZenGemini31Pro from "../../config/models/opencode-zen/gemini-3.1-pro.json";
import opencodeZenGemini35Flash from "../../config/models/opencode-zen/gemini-3.5-flash.json";
import opencodeZenGemini3Flash from "../../config/models/opencode-zen/gemini-3-flash.json";
import opencodeZenGlm51 from "../../config/models/opencode-zen/glm-5.1.json";
import opencodeZenGlm5 from "../../config/models/opencode-zen/glm-5.json";
import opencodeZenGpt51 from "../../config/models/opencode-zen/gpt-5.1.json";
import opencodeZenGpt51Codex from "../../config/models/opencode-zen/gpt-5.1-codex.json";
import opencodeZenGpt51CodexMax from "../../config/models/opencode-zen/gpt-5.1-codex-max.json";
import opencodeZenGpt51CodexMini from "../../config/models/opencode-zen/gpt-5.1-codex-mini.json";
import opencodeZenGpt52 from "../../config/models/opencode-zen/gpt-5.2.json";
import opencodeZenGpt52Codex from "../../config/models/opencode-zen/gpt-5.2-codex.json";
import opencodeZenGpt53Codex from "../../config/models/opencode-zen/gpt-5.3-codex.json";
import opencodeZenGpt53CodexSpark from "../../config/models/opencode-zen/gpt-5.3-codex-spark.json";
import opencodeZenGpt54 from "../../config/models/opencode-zen/gpt-5.4.json";
import opencodeZenGpt54Mini from "../../config/models/opencode-zen/gpt-5.4-mini.json";
import opencodeZenGpt54Nano from "../../config/models/opencode-zen/gpt-5.4-nano.json";
import opencodeZenGpt54Pro from "../../config/models/opencode-zen/gpt-5.4-pro.json";
import opencodeZenGpt55 from "../../config/models/opencode-zen/gpt-5.5.json";
import opencodeZenGpt55Pro from "../../config/models/opencode-zen/gpt-5.5-pro.json";
import opencodeZenGpt5 from "../../config/models/opencode-zen/gpt-5.json";
import opencodeZenGpt5Codex from "../../config/models/opencode-zen/gpt-5-codex.json";
import opencodeZenGpt5Nano from "../../config/models/opencode-zen/gpt-5-nano.json";
import opencodeZenGrokBuild01 from "../../config/models/opencode-zen/grok-build-0.1.json";
import opencodeZenKimiK25 from "../../config/models/opencode-zen/kimi-k2.5.json";
import opencodeZenKimiK26 from "../../config/models/opencode-zen/kimi-k2.6.json";
import opencodeZenMimoV25Free from "../../config/models/opencode-zen/mimo-v2.5-free.json";
import opencodeZenMinimaxM25 from "../../config/models/opencode-zen/minimax-m2.5.json";
import opencodeZenMinimaxM27 from "../../config/models/opencode-zen/minimax-m2.7.json";
import opencodeZenMinimaxM3Free from "../../config/models/opencode-zen/minimax-m3-free.json";
import opencodeZenNemotron3UltraFree from "../../config/models/opencode-zen/nemotron-3-ultra-free.json";
import opencodeZenNorthMiniCodeFree from "../../config/models/opencode-zen/north-mini-code-free.json";
import opencodeZenQwen35Plus from "../../config/models/opencode-zen/qwen3.5-plus.json";
import opencodeZenQwen36Plus from "../../config/models/opencode-zen/qwen3.6-plus.json";
import opencodeZenQwen36PlusFree from "../../config/models/opencode-zen/qwen3.6-plus-free.json";
import togetherMoonshotAiKimiK25 from "../../config/models/together/moonshotai-kimi-k2.5.json";
import togetherQwenQwen35397bA17b from "../../config/models/together/qwen-qwen3.5-397b-a17b.json";
import togetherZaiOrgGlm5 from "../../config/models/together/zai-org-glm-5.json";
import type { ProviderName } from "../types";

const STATIC_MODEL_PROVIDER_NAMES = [
  "google",
  "openai",
  "anthropic",
  "bedrock",
  "baseten",
  "together",
  "fireworks",
  "firepass",
  "nvidia",
  "minimax",
  "opencode-go",
  "opencode-zen",
  "codex-cli",
  "antigravity",
] as const satisfies readonly ProviderName[];

type StaticModelProviderName = (typeof STATIC_MODEL_PROVIDER_NAMES)[number];

const providerNameSchema = z.enum(STATIC_MODEL_PROVIDER_NAMES);

const supportedModelSchema = z
  .object({
    id: z.string().trim().min(1),
    provider: providerNameSchema,
    displayName: z.string().trim().min(1),
    // Vendor-published cutoff strings are user-facing metadata, not a normalized date field.
    knowledgeCutoff: z.string().trim().min(1),
    supportsImageInput: z.boolean(),
    promptTemplate: z.string().trim().min(1),
    providerOptionsDefaults: z.record(z.string(), z.unknown()),
    isDefault: z.boolean(),
  })
  .strict();

export type SupportedModel = z.infer<typeof supportedModelSchema>;

const RAW_MODEL_REGISTRY_ENTRIES = [
  anthropicClaudeHaiku45,
  anthropicClaudeOpus46,
  anthropicClaudeOpus47,
  anthropicClaudeOpus48,
  anthropicClaudeSonnet45,
  anthropicClaudeSonnet46,
  bedrockAmazonNovaLiteV10,
  bedrockAmazonNovaMicroV10,
  bedrockAnthropicClaude35Haiku20241022V10,
  basetenMoonshotAiKimiK25,
  basetenNvidiaNemotron120bA12b,
  basetenZaiOrgGlm5,
  codexCliGpt55,
  codexCliGpt54,
  codexCliGpt54Mini,
  codexCliGpt53CodexSpark,
  fireworksDeepseekV4Pro,
  fireworksGlm5p1,
  fireworksKimiK2p6,
  fireworksMinimaxM2p7,
  fireworksQwen3p6Plus,
  firepassKimiK2p6Turbo,
  googleGemini35Flash,
  googleGemini3FlashPreview,
  antigravityGemini35Flash,
  antigravityGemini31Pro,
  antigravityGemini31FlashLite,
  googleGemini31FlashLite,
  googleGemini31ProPreview,
  googleGemini31ProPreviewCustomtools,
  openaiGpt5Mini,
  openaiGpt52Pro,
  openaiGpt52,
  openaiGpt55,
  openaiGpt54,
  openaiGpt54Mini,
  openaiGpt54Nano,
  openaiGpt54Pro,
  nvidiaNemotron3Super120bA12b,
  minimaxM3,
  opencodeGoMinimaxM3,
  opencodeGoMinimaxM27,
  opencodeGoMinimaxM25,
  opencodeGoKimiK26,
  opencodeGoKimiK25,
  opencodeGoGlm51,
  opencodeGoGlm5,
  opencodeGoDeepseekV4Pro,
  opencodeGoDeepseekV4Flash,
  opencodeGoQwen37Max,
  opencodeGoQwen37Plus,
  opencodeGoQwen36Plus,
  opencodeGoQwen35Plus,
  opencodeGoMimoV2Pro,
  opencodeGoMimoV2Omni,
  opencodeGoMimoV25Pro,
  opencodeGoMimoV25,
  opencodeGoHy3Preview,
  opencodeZenClaudeOpus48,
  opencodeZenClaudeOpus47,
  opencodeZenClaudeOpus46,
  opencodeZenClaudeOpus45,
  opencodeZenClaudeOpus41,
  opencodeZenClaudeSonnet46,
  opencodeZenClaudeSonnet45,
  opencodeZenClaudeSonnet4,
  opencodeZenClaudeHaiku45,
  opencodeZenGemini35Flash,
  opencodeZenGemini31Pro,
  opencodeZenGemini3Flash,
  opencodeZenGpt55,
  opencodeZenGpt55Pro,
  opencodeZenGpt54,
  opencodeZenGpt54Pro,
  opencodeZenGpt54Mini,
  opencodeZenGpt54Nano,
  opencodeZenGpt53CodexSpark,
  opencodeZenGpt53Codex,
  opencodeZenGpt52,
  opencodeZenGpt52Codex,
  opencodeZenGpt51,
  opencodeZenGpt51CodexMax,
  opencodeZenGpt51Codex,
  opencodeZenGpt51CodexMini,
  opencodeZenGpt5,
  opencodeZenGpt5Codex,
  opencodeZenGpt5Nano,
  opencodeZenGrokBuild01,
  opencodeZenDeepseekV4Flash,
  opencodeZenGlm51,
  opencodeZenGlm5,
  opencodeZenMinimaxM27,
  opencodeZenMinimaxM25,
  opencodeZenKimiK26,
  opencodeZenKimiK25,
  opencodeZenQwen36Plus,
  opencodeZenQwen35Plus,
  opencodeZenBigPickle,
  opencodeZenDeepseekV4FlashFree,
  opencodeZenMimoV25Free,
  opencodeZenQwen36PlusFree,
  opencodeZenMinimaxM3Free,
  opencodeZenNemotron3UltraFree,
  opencodeZenNorthMiniCodeFree,
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
    bedrock: [],
    baseten: [],
    together: [],
    fireworks: [],
    firepass: [],
    nvidia: [],
    minimax: [],
    "opencode-go": [],
    "opencode-zen": [],
    "codex-cli": [],
    antigravity: [],
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

const MODEL_REGISTRY_ENTRIES = RAW_MODEL_REGISTRY_ENTRIES.map((entry) =>
  supportedModelSchema.parse(entry),
).sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
const MODEL_REGISTRY = buildRegistry(MODEL_REGISTRY_ENTRIES);

/**
 * Legacy model ID aliases for backward compatibility.
 * Maps deprecated/legacy model IDs to their canonical replacements.
 */
const LEGACY_MODEL_ALIASES: Record<string, string> = {
  "openai:gpt-5.1": "openai:gpt-5.4",
  "openai:gpt-5.2-codex": "openai:gpt-5.4",
  "codex-cli:gpt-5-codex": "codex-cli:gpt-5.4",
  "codex-cli:gpt-5.1": "codex-cli:gpt-5.4",
  "codex-cli:gpt-5.1-codex": "codex-cli:gpt-5.4",
  "codex-cli:gpt-5.1-codex-max": "codex-cli:gpt-5.4",
  "codex-cli:gpt-5.1-codex-mini": "codex-cli:gpt-5.4",
  "codex-cli:gpt-5.2-codex": "codex-cli:gpt-5.4",
  "google:gemini-3-pro-preview": "google:gemini-3.1-pro-preview-customtools",
  "google:gemini-3.1-flash-lite-preview": "google:gemini-3.1-flash-lite",
  "antigravity:gemini-3.1-pro": "antigravity:gemini-3.1-pro-preview",
};

type LikelyModelProvider = "openai" | "anthropic" | "google";

function inferLikelyProviderForModelId(modelId: string): LikelyModelProvider | null {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith("claude-")) return "anthropic";
  if (normalized.startsWith("gemini-")) return "google";
  if (
    normalized.startsWith("gpt-5") ||
    normalized.startsWith("gpt-4o") ||
    /^o(?:1|3|4)(?:$|[-.])/.test(normalized) ||
    /(^|[-.])codex(?:$|[-.])/.test(normalized)
  ) {
    return "openai";
  }
  return null;
}

function providerMatchesLikelyModelProvider(
  provider: ProviderName,
  expectedProvider: LikelyModelProvider,
): boolean {
  if (expectedProvider === "openai") {
    return provider === "openai" || provider === "codex-cli";
  }
  if (expectedProvider === "google") {
    return provider === "google" || provider === "antigravity";
  }
  return provider === expectedProvider;
}

export function describeModelProviderMismatch(
  provider: ProviderName,
  modelId: string,
): string | null {
  const expectedProvider = inferLikelyProviderForModelId(modelId);
  if (!expectedProvider || providerMatchesLikelyModelProvider(provider, expectedProvider)) {
    return null;
  }
  if (expectedProvider === "openai") {
    return `"${modelId}" looks like an OpenAI model; use provider openai instead (Responses API).`;
  }
  if (expectedProvider === "google") {
    return `"${modelId}" looks like a Google model; use provider google instead.`;
  }
  return `"${modelId}" looks like an Anthropic model; use provider anthropic instead.`;
}

export { MODEL_REGISTRY_ENTRIES };

function isStaticRegistryProvider(provider: ProviderName): provider is StaticModelProviderName {
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
    throw new Error(
      `Provider ${provider} uses dynamic model discovery and has no static default model.`,
    );
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

export function providerOptionsDefaultsForModel(
  provider: ProviderName,
  modelId: string,
): Record<string, unknown> {
  return { ...(getSupportedModel(provider, modelId)?.providerOptionsDefaults ?? {}) };
}

/**
 * True when `modelId` provably belongs to a different provider: it is not
 * registered for `provider`, does not look like a model from `provider`'s
 * family, and is registered for at least one other static provider.
 *
 * Unknown-everywhere ids are NOT foreign — dynamic model discovery allows
 * providers to expose models outside the static registry.
 */
export function isModelIdForeignToProvider(provider: ProviderName, modelId: string): boolean {
  if (getSupportedModel(provider, modelId)) return false;
  const likelyProvider = inferLikelyProviderForModelId(modelId);
  if (likelyProvider && providerMatchesLikelyModelProvider(provider, likelyProvider)) {
    return false;
  }
  return STATIC_MODEL_PROVIDER_NAMES.some(
    (candidate) => candidate !== provider && getSupportedModel(candidate, modelId) !== null,
  );
}

export function assertSupportedModel(
  provider: ProviderName,
  modelId: string,
  source = "model",
): SupportedModel {
  const supported = getSupportedModel(provider, modelId);
  if (supported) return supported;

  const mismatchHint = describeModelProviderMismatch(provider, modelId);
  const supportedIds = listSupportedModelIds(provider).join(", ");
  throw new Error(
    `Unsupported ${source} "${modelId}" for provider ${provider}.${mismatchHint ? ` ${mismatchHint}` : ""} Supported models: ${supportedIds}`,
  );
}
