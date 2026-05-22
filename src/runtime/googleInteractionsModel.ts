import { getSavedProviderApiKey } from "../config";
import { assertSupportedModel } from "../models/registry";
import type { RuntimeRunTurnParams } from "./types";

export type GoogleInteractionsModelInputModality =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "document";

export type GoogleInteractionsModelInfo = {
  id: string;
  name: string;
  reasoning: boolean;
  input: GoogleInteractionsModelInputModality[];
  contextWindow: number;
  maxTokens: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

const GOOGLE_MULTIMODAL_INPUT: GoogleInteractionsModelInputModality[] = [
  "text",
  "image",
  "audio",
  "video",
  "document",
];

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
    input: GOOGLE_MULTIMODAL_INPUT,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  },
  "gemini-3.1-pro-preview-customtools": {
    id: "gemini-3.1-pro-preview-customtools",
    name: "Gemini 3.1 Pro Preview (Custom Tools)",
    reasoning: true,
    input: GOOGLE_MULTIMODAL_INPUT,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  },
  "gemini-3-flash-preview": {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    reasoning: true,
    input: GOOGLE_MULTIMODAL_INPUT,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    cost: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
  },
  "gemini-3.1-flash-lite-preview": {
    id: "gemini-3.1-flash-lite-preview",
    name: "Gemini 3.1 Flash-Lite Preview",
    reasoning: true,
    input: GOOGLE_MULTIMODAL_INPUT,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    cost: { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0 },
  },
  "gemini-3.5-flash": {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    reasoning: true,
    input: GOOGLE_MULTIMODAL_INPUT,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    cost: { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
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
    input: GOOGLE_MULTIMODAL_INPUT,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  };
}

function googleInteractionsInputForModel(
  supportsImageInput: boolean,
): GoogleInteractionsModelInputModality[] {
  if (supportsImageInput) return GOOGLE_MULTIMODAL_INPUT;
  return ["text", "audio", "video", "document"];
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
      input: googleInteractionsInputForModel(supported.supportsImageInput),
    },
    apiKey:
      getSavedProviderApiKey(params.config, "google") ||
      getSavedProviderApiKey(params.config, "antigravity"),
  };
}
