import { getResolvedModelMetadataSync, normalizeModelIdForProvider } from "../../models/metadata";
import {
  childModelRef,
  normalizeChildRoutingConfig,
  parseChildModelRef,
} from "../../models/childModelRouting";
import { OPENAI_COMPATIBLE_PROVIDER_NAMES, isOpenAiReasoningEffort } from "../../shared/openaiCompatibleOptions";
import type { AgentReasoningEffort } from "../../shared/agents";
import { defaultRuntimeNameForProvider, type AgentConfig, type ProviderName } from "../../types";

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

function modelDefaultReasoningEffort(provider: ProviderName, model: string): AgentReasoningEffort | undefined {
  const defaults = getResolvedModelMetadataSync(provider, model, "child model").providerOptionsDefaults;
  const section = isPlainObject(defaults) ? defaults : {};
  return isOpenAiReasoningEffort(section.reasoningEffort) ? section.reasoningEffort : undefined;
}

function applyReasoningEffort(
  config: AgentConfig,
  provider: ProviderName,
  effectiveReasoningEffort: AgentReasoningEffort | undefined,
): AgentConfig["providerOptions"] {
  const nextProviderOptions = isPlainObject(config.providerOptions) ? { ...config.providerOptions } : {};
  const modelDefaults = getResolvedModelMetadataSync(provider, config.model, "child model").providerOptionsDefaults;
  if (Object.keys(modelDefaults).length > 0) {
    const nextSection = isPlainObject(nextProviderOptions[provider])
      ? { ...(nextProviderOptions[provider] as Record<string, unknown>) }
      : {};
    nextProviderOptions[provider] = mergeObjects(modelDefaults, nextSection);
  }
  if (!effectiveReasoningEffort) {
    return Object.keys(nextProviderOptions).length > 0 ? nextProviderOptions as AgentConfig["providerOptions"] : config.providerOptions;
  }
  if (!OPENAI_COMPATIBLE_PROVIDER_NAMES.includes(provider as (typeof OPENAI_COMPATIBLE_PROVIDER_NAMES)[number])) {
    return Object.keys(nextProviderOptions).length > 0 ? nextProviderOptions as AgentConfig["providerOptions"] : config.providerOptions;
  }
  const nextSection = isPlainObject(nextProviderOptions[provider])
    ? { ...(nextProviderOptions[provider] as Record<string, unknown>) }
    : {};
  nextProviderOptions[provider] = mergeObjects(nextSection, { reasoningEffort: effectiveReasoningEffort });
  return nextProviderOptions as AgentConfig["providerOptions"];
}

export function routeAgentConfig(
  parentConfig: AgentConfig,
  opts: {
    role: AgentRoleDefinition;
    model?: string;
    reasoningEffort?: AgentReasoningEffort;
    connectedProviders?: readonly ProviderName[];
  },
): {
  config: AgentConfig;
  requestedModel?: string;
  effectiveProvider: ProviderName;
  effectiveModel: string;
  requestedReasoningEffort?: AgentReasoningEffort;
  effectiveReasoningEffort?: AgentReasoningEffort;
  fallbackLine?: string;
} {
  const requestedModel = opts.model?.trim() || undefined;
  const requestedReasoningEffort = opts.reasoningEffort;
  const connectedProviders = new Set(opts.connectedProviders ?? []);

  let effectiveProvider = parentConfig.provider;
  let effectiveModel = parentConfig.model;
  let fallbackLine: string | undefined;

  if (opts.role.modelPolicy?.fixedModel) {
    effectiveModel = normalizeModelIdForProvider(parentConfig.provider, opts.role.modelPolicy.fixedModel, "child role model");
  } else if (requestedModel) {
    const requestedTarget = parseChildModelRef(requestedModel, parentConfig.provider, "child model");
    if (requestedTarget.provider === parentConfig.provider) {
      if (
        requestedTarget.provider === "lmstudio"
        && requestedTarget.modelId !== parentConfig.model
        && connectedProviders.size > 0
        && !connectedProviders.has("lmstudio")
      ) {
        fallbackLine =
          `[agent] Requested child target ${requestedTarget.ref} could not be used because LM Studio is not connected; falling back to ${childModelRef(parentConfig.provider, parentConfig.model)}.`;
      } else {
        effectiveModel = requestedTarget.modelId;
      }
    } else {
      const allowedRefs = new Set(parentConfig.allowedChildModelRefs ?? []);
      const crossProviderEnabled = (parentConfig.childModelRoutingMode ?? "same-provider") === "cross-provider-allowlist";
      const connected = connectedProviders.has(requestedTarget.provider);
      if (crossProviderEnabled && allowedRefs.has(requestedTarget.ref) && connected) {
        effectiveProvider = requestedTarget.provider;
        effectiveModel = requestedTarget.modelId;
      } else {
        const reason = !crossProviderEnabled
          ? "cross-provider routing is disabled for this workspace"
          : !allowedRefs.has(requestedTarget.ref)
            ? "the requested child target is not in this workspace allowlist"
            : "the requested provider is not connected";
        fallbackLine =
          `[agent] Requested child target ${requestedTarget.ref} could not be used because ${reason}; falling back to ${childModelRef(parentConfig.provider, parentConfig.model)}.`;
      }
    }
  }

  const effectiveReasoningEffort =
    opts.role.modelPolicy?.fixedReasoningEffort
    ?? requestedReasoningEffort
    ?? (requestedModel || effectiveProvider !== parentConfig.provider || effectiveModel !== parentConfig.model
      ? modelDefaultReasoningEffort(effectiveProvider, effectiveModel)
      : undefined)
    ?? currentReasoningEffort(parentConfig);

  const resolvedEffectiveModel = getResolvedModelMetadataSync(effectiveProvider, effectiveModel, "child model");
  const normalizedChildRouting = normalizeChildRoutingConfig({
    provider: effectiveProvider,
    model: resolvedEffectiveModel.id,
    childModelRoutingMode: parentConfig.childModelRoutingMode,
    preferredChildModelRef: parentConfig.preferredChildModelRef,
    allowedChildModelRefs: parentConfig.allowedChildModelRefs,
    preferredChildModel: parentConfig.preferredChildModel,
    source: "child agent",
  });

  return {
    config: {
      ...parentConfig,
      provider: effectiveProvider,
      runtime: defaultRuntimeNameForProvider(effectiveProvider),
      model: resolvedEffectiveModel.id,
      preferredChildModel: normalizedChildRouting.preferredChildModel,
      childModelRoutingMode: normalizedChildRouting.childModelRoutingMode,
      preferredChildModelRef: normalizedChildRouting.preferredChildModelRef,
      allowedChildModelRefs: normalizedChildRouting.allowedChildModelRefs,
      knowledgeCutoff: resolvedEffectiveModel.knowledgeCutoff,
      providerOptions: applyReasoningEffort(
        { ...parentConfig, provider: effectiveProvider, model: resolvedEffectiveModel.id },
        effectiveProvider,
        effectiveReasoningEffort,
      ),
    },
    ...(requestedModel ? { requestedModel } : {}),
    effectiveProvider,
    effectiveModel: resolvedEffectiveModel.id,
    ...(requestedReasoningEffort ? { requestedReasoningEffort } : {}),
    ...(effectiveReasoningEffort ? { effectiveReasoningEffort } : {}),
    ...(fallbackLine ? { fallbackLine } : {}),
  };
}
