import { normalizeChildRoutingConfig, parseChildModelRef } from "../../models/childModelRouting";
import {
  getResolvedModelMetadataSync,
  normalizeModelIdForProvider,
  reconcileReasoningProviderOptions,
} from "../../models/metadata";
import type { AgentReasoningEffort } from "../../shared/agents";
import {
  isOpenAiReasoningEffort,
  OPENAI_COMPATIBLE_PROVIDER_NAMES,
} from "../../shared/openaiCompatibleOptions";
import { type AgentConfig, defaultRuntimeNameForProvider, type ProviderName } from "../../types";
import { resolveAuthHomeDir } from "../../utils/authHome";

import type { AgentRoleDefinition } from "./roles";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeObjects(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...base,
    ...patch,
  };
}

function currentReasoningEffort(config: AgentConfig): AgentReasoningEffort | undefined {
  if (
    !OPENAI_COMPATIBLE_PROVIDER_NAMES.includes(
      config.provider as (typeof OPENAI_COMPATIBLE_PROVIDER_NAMES)[number],
    )
  ) {
    return undefined;
  }
  const section =
    isPlainObject(config.providerOptions) && isPlainObject(config.providerOptions[config.provider])
      ? (config.providerOptions[config.provider] as Record<string, unknown>)
      : undefined;
  return isOpenAiReasoningEffort(section?.reasoningEffort) ? section.reasoningEffort : undefined;
}

function modelDefaultReasoningEffort(
  provider: ProviderName,
  model: string,
  home?: string,
): AgentReasoningEffort | undefined {
  const defaults = getResolvedModelMetadataSync(
    provider,
    model,
    "child model",
    home ? { home } : {},
  ).providerOptionsDefaults;
  const section = isPlainObject(defaults) ? defaults : {};
  return isOpenAiReasoningEffort(section.reasoningEffort) ? section.reasoningEffort : undefined;
}

function applyReasoningEffort(
  config: AgentConfig,
  provider: ProviderName,
  effectiveReasoningEffort: AgentReasoningEffort | undefined,
  home?: string,
): AgentConfig["providerOptions"] {
  const nextProviderOptions = isPlainObject(config.providerOptions)
    ? { ...config.providerOptions }
    : {};
  const modelDefaults = getResolvedModelMetadataSync(
    provider,
    config.model,
    "child model",
    home ? { home } : {},
  ).providerOptionsDefaults;
  if (Object.keys(modelDefaults).length > 0) {
    const nextSection = isPlainObject(nextProviderOptions[provider])
      ? { ...(nextProviderOptions[provider] as Record<string, unknown>) }
      : {};
    nextProviderOptions[provider] = mergeObjects(modelDefaults, nextSection);
  }
  if (!effectiveReasoningEffort) {
    return Object.keys(nextProviderOptions).length > 0
      ? (nextProviderOptions as AgentConfig["providerOptions"])
      : config.providerOptions;
  }
  if (
    !OPENAI_COMPATIBLE_PROVIDER_NAMES.includes(
      provider as (typeof OPENAI_COMPATIBLE_PROVIDER_NAMES)[number],
    )
  ) {
    return Object.keys(nextProviderOptions).length > 0
      ? (nextProviderOptions as AgentConfig["providerOptions"])
      : config.providerOptions;
  }
  const nextSection = isPlainObject(nextProviderOptions[provider])
    ? { ...(nextProviderOptions[provider] as Record<string, unknown>) }
    : {};
  nextProviderOptions[provider] = mergeObjects(nextSection, {
    reasoningEffort: effectiveReasoningEffort,
  });
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
} {
  const requestedModel = opts.model?.trim() || undefined;
  const requestedReasoningEffort = opts.reasoningEffort;
  const connectedProviders = new Set(opts.connectedProviders ?? []);
  // Custom cross-registry ids are validated against the custom-model store under
  // the session's auth home; resolve it once and thread it through every sync
  // model-id normalize/resolve call below.
  const home = resolveAuthHomeDir(parentConfig);

  let effectiveProvider = parentConfig.provider;
  let effectiveModel = parentConfig.model;

  if (opts.role.modelPolicy?.fixedModel) {
    effectiveModel = normalizeModelIdForProvider(
      parentConfig.provider,
      opts.role.modelPolicy.fixedModel,
      "child role model",
      { home },
    );
  } else if (requestedModel) {
    const requestedTarget = parseChildModelRef(
      requestedModel,
      parentConfig.provider,
      "child model",
      {
        home,
      },
    );
    if (requestedTarget.provider === parentConfig.provider) {
      if (
        requestedTarget.provider === "lmstudio" &&
        requestedTarget.modelId !== parentConfig.model &&
        connectedProviders.size > 0 &&
        !connectedProviders.has("lmstudio")
      ) {
        throw new Error(
          `Requested child target ${requestedTarget.ref} could not be used because LM Studio is not connected. No child was started.`,
        );
      } else {
        effectiveModel = requestedTarget.modelId;
      }
    } else {
      const allowedRefs = new Set(parentConfig.allowedChildModelRefs ?? []);
      const crossProviderEnabled =
        (parentConfig.childModelRoutingMode ?? "same-provider") === "cross-provider-allowlist";
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
        throw new Error(
          `Requested child target ${requestedTarget.ref} could not be used because ${reason}. No child was started; choose an allowed connected target or update workspace subagent model routing.`,
        );
      }
    }
  }

  const childModelChanged =
    Boolean(requestedModel) ||
    effectiveProvider !== parentConfig.provider ||
    effectiveModel !== parentConfig.model;
  const effectiveReasoningEffort =
    opts.role.modelPolicy?.fixedReasoningEffort ??
    requestedReasoningEffort ??
    // When the child model differs from the parent, use the child's own default
    // effort — which is `undefined` for a non-reasoning model (e.g. a custom
    // gpt-4o). Do NOT fall through to the parent's effort in that case, or the
    // runtime would send a reasoning payload the child model rejects. Only an
    // unchanged child model inherits the parent's current effort.
    (childModelChanged
      ? modelDefaultReasoningEffort(effectiveProvider, effectiveModel, home)
      : currentReasoningEffort(parentConfig));

  const resolvedEffectiveModel = getResolvedModelMetadataSync(
    effectiveProvider,
    effectiveModel,
    "child model",
    { home },
  );
  const normalizedChildRouting = normalizeChildRoutingConfig({
    provider: effectiveProvider,
    model: resolvedEffectiveModel.id,
    childModelRoutingMode: parentConfig.childModelRoutingMode,
    preferredChildModelRef: parentConfig.preferredChildModelRef,
    allowedChildModelRefs: parentConfig.allowedChildModelRefs,
    preferredChildModel: parentConfig.preferredChildModel,
    source: "child agent",
    home,
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
      // `applyReasoningEffort` starts from a copy of the parent's providerOptions,
      // so routing a reasoning parent (e.g. GPT-5 carrying reasoningEffort/
      // reasoningSummary) to a non-reasoning child (e.g. a custom/discovered
      // gpt-4o) would leave those stale keys behind and make the child's first
      // Responses request send a reasoning payload it rejects. Reconcile against
      // the child model's own resolved defaults to drop keys it does not declare.
      providerOptions: reconcileReasoningProviderOptions(
        applyReasoningEffort(
          { ...parentConfig, provider: effectiveProvider, model: resolvedEffectiveModel.id },
          effectiveProvider,
          effectiveReasoningEffort,
          home,
        ),
        effectiveProvider,
        resolvedEffectiveModel.providerOptionsDefaults,
      ) as AgentConfig["providerOptions"],
    },
    ...(requestedModel ? { requestedModel } : {}),
    effectiveProvider,
    effectiveModel: resolvedEffectiveModel.id,
    ...(requestedReasoningEffort ? { requestedReasoningEffort } : {}),
    ...(effectiveReasoningEffort ? { effectiveReasoningEffort } : {}),
  };
}
