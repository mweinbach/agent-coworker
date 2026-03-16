import { providerOptionsDefaultsForModel } from "../../models/registry";
import { OPENAI_COMPATIBLE_PROVIDER_NAMES, isOpenAiReasoningEffort } from "../../shared/openaiCompatibleOptions";
import type { AgentConfig } from "../../types";
import type { AgentReasoningEffort } from "../../shared/agents";

import type { AgentRoleDefinition } from "./roles";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeObjects(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  return {
    ...base,
    ...patch,
  };
}

function currentReasoningEffort(config: AgentConfig): AgentReasoningEffort | undefined {
  if (!OPENAI_COMPATIBLE_PROVIDER_NAMES.includes(config.provider as (typeof OPENAI_COMPATIBLE_PROVIDER_NAMES)[number])) {
    return undefined;
  }
  const section = isPlainObject(config.providerOptions) && isPlainObject(config.providerOptions[config.provider])
    ? (config.providerOptions[config.provider] as Record<string, unknown>)
    : undefined;
  return isOpenAiReasoningEffort(section?.reasoningEffort) ? section.reasoningEffort : undefined;
}

function modelDefaultReasoningEffort(config: AgentConfig, model: string): AgentReasoningEffort | undefined {
  const defaults = providerOptionsDefaultsForModel(config.provider, model);
  const section = isPlainObject(defaults) ? defaults : {};
  return isOpenAiReasoningEffort(section.reasoningEffort) ? section.reasoningEffort : undefined;
}

function applyReasoningEffort(
  config: AgentConfig,
  effectiveReasoningEffort: AgentReasoningEffort | undefined,
): AgentConfig["providerOptions"] {
  if (!effectiveReasoningEffort) {
    return config.providerOptions;
  }
  if (!OPENAI_COMPATIBLE_PROVIDER_NAMES.includes(config.provider as (typeof OPENAI_COMPATIBLE_PROVIDER_NAMES)[number])) {
    return config.providerOptions;
  }
  const nextProviderOptions = isPlainObject(config.providerOptions) ? { ...config.providerOptions } : {};
  const providerKey = config.provider;
  const nextSection = isPlainObject(nextProviderOptions[providerKey])
    ? { ...(nextProviderOptions[providerKey] as Record<string, unknown>) }
    : {};
  nextProviderOptions[config.provider] = mergeObjects(nextSection, { reasoningEffort: effectiveReasoningEffort });
  return nextProviderOptions as AgentConfig["providerOptions"];
}

export function routeAgentConfig(
  parentConfig: AgentConfig,
  opts: {
    role: AgentRoleDefinition;
    model?: string;
    reasoningEffort?: AgentReasoningEffort;
  },
): {
  config: AgentConfig;
  requestedModel?: string;
  effectiveModel: string;
  requestedReasoningEffort?: AgentReasoningEffort;
  effectiveReasoningEffort?: AgentReasoningEffort;
} {
  const requestedModel = opts.model?.trim() || undefined;
  const requestedReasoningEffort = opts.reasoningEffort;

  const effectiveModel = opts.role.modelPolicy?.fixedModel ?? requestedModel ?? parentConfig.model;
  const effectiveReasoningEffort =
    opts.role.modelPolicy?.fixedReasoningEffort
    ?? requestedReasoningEffort
    ?? (requestedModel ? modelDefaultReasoningEffort(parentConfig, effectiveModel) : undefined)
    ?? currentReasoningEffort(parentConfig);

  return {
    config: {
      ...parentConfig,
      model: effectiveModel,
      providerOptions: applyReasoningEffort(parentConfig, effectiveReasoningEffort),
    },
    ...(requestedModel ? { requestedModel } : {}),
    effectiveModel,
    ...(requestedReasoningEffort ? { requestedReasoningEffort } : {}),
    ...(effectiveReasoningEffort ? { effectiveReasoningEffort } : {}),
  };
}
