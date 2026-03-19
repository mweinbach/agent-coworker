import { getSavedProviderApiKey } from "../config";
import { assertSupportedModel } from "../models/registry";
import type { RuntimeRunTurnParams } from "./types";

export type GoogleInteractionsModelInfo = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

export type ResolvedGoogleInteractionsModel = {
  model: GoogleInteractionsModelInfo;
  apiKey?: string;
};

/**
 * Static model metadata for supported Google Interactions models.
 * This replaces the PI model catalog dependency for Google models.
 */
const SUPPORTED_GOOGLE_INTERACTIONS_MODELS: Record<string, GoogleInteractionsModelInfo> = {
  "gemini-3.1-pro-preview": {
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  },
  "gemini-3.1-pro-preview-customtools": {
    id: "gemini-3.1-pro-preview-customtools",
    name: "Gemini 3.1 Pro Preview (Custom Tools)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  },
  "gemini-3-flash-preview": {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    cost: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
  },
  "gemini-3.1-flash-lite-preview": {
    id: "gemini-3.1-flash-lite-preview",
    name: "Gemini 3.1 Flash-Lite Preview",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    cost: { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0 },
  },
};

function resolveGoogleInteractionsModelInfo(modelId: string): GoogleInteractionsModelInfo {
  const known = SUPPORTED_GOOGLE_INTERACTIONS_MODELS[modelId];
  if (known) return known;

  // Fallback for unknown models — use conservative defaults
  return {
    id: modelId,
    name: modelId,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  };
}

export async function resolveGoogleInteractionsModel(
  params: RuntimeRunTurnParams,
): Promise<ResolvedGoogleInteractionsModel> {
  const modelId = params.config.model;
  const supported = assertSupportedModel("google", modelId, "model");
  const modelInfo = resolveGoogleInteractionsModelInfo(supported.id);

  return {
    model: {
      ...modelInfo,
      id: supported.id,
      name: supported.displayName,
      input: supported.supportsImageInput ? ["text", "image"] : ["text"],
    },
    apiKey: getSavedProviderApiKey(params.config, "google"),
  };
}
