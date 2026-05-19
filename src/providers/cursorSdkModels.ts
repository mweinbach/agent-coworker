import { Cursor, type ModelListItem, type ModelSelection } from "@cursor/sdk";

import { assertSupportedModel, listSupportedModels } from "../models/registry";
import type { AgentConfig } from "../types";

import { resolveCursorApiKey } from "./cursorSdkAuth";

let cachedModels: ModelListItem[] | null = null;
let cachedModelsAt = 0;
const MODEL_CACHE_MS = 5 * 60 * 1000;

export async function listCursorSdkModels(config: AgentConfig): Promise<ModelListItem[]> {
  const now = Date.now();
  if (cachedModels && now - cachedModelsAt < MODEL_CACHE_MS) {
    return cachedModels;
  }
  const apiKey = resolveCursorApiKey(config);
  const models = await Cursor.models.list({ apiKey });
  cachedModels = models;
  cachedModelsAt = now;
  return models;
}

export function buildCursorModelSelection(config: AgentConfig, modelId: string): ModelSelection {
  const supported = assertSupportedModel("cursor-agent", modelId);
  const root =
    typeof config.providerOptions === "object" && config.providerOptions !== null
      ? (config.providerOptions as Record<string, unknown>)
      : {};
  const section =
    typeof root["cursor-agent"] === "object" && root["cursor-agent"] !== null
      ? (root["cursor-agent"] as Record<string, unknown>)
      : {};
  const thinking =
    (typeof section.thinking === "string" && section.thinking.trim()) ||
    (typeof supported.providerOptionsDefaults.thinking === "string"
      ? supported.providerOptionsDefaults.thinking
      : undefined);
  const params = thinking ? [{ id: "thinking", value: thinking }] : undefined;
  return params ? { id: modelId, params } : { id: modelId };
}

export async function resolveEffectiveCursorModelId(
  config: AgentConfig,
  configuredModel: string,
  log?: (line: string) => void,
): Promise<string> {
  try {
    const remote = await listCursorSdkModels(config);
    const supportedIds = new Set(listSupportedModels("cursor-agent").map((model) => model.id));
    const available = remote.map((model) => model.id).filter((id) => supportedIds.has(id));
    if (available.includes(configuredModel)) return configuredModel;
    const fallback =
      remote.find((model) => model.variants?.some((variant) => variant.isDefault))?.id ??
      available[0] ??
      configuredModel;
    if (fallback !== configuredModel) {
      log?.(
        `[cursor-sdk] model ${JSON.stringify(configuredModel)} is not available; using ${JSON.stringify(fallback)}.`,
      );
    }
    return fallback;
  } catch (error) {
    log?.(`[cursor-sdk] model list failed, using configured model: ${String(error)}`);
    return configuredModel;
  }
}
