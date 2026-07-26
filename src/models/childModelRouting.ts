import {
  type ChildModelRoutingMode,
  isChildModelRoutingMode,
  isProviderName,
  type ProviderName,
} from "../types";
import { normalizeModelIdForProvider } from "./metadata";

export type ParsedChildModelRef = {
  provider: ProviderName;
  modelId: string;
  ref: string;
  explicitProvider: boolean;
};

export function childModelRef(provider: ProviderName, modelId: string): string {
  return `${provider}:${modelId}`;
}

export function parseChildModelRef(
  raw: string,
  defaultProvider?: ProviderName,
  source = "child model",
  opts: { home?: string } = {},
): ParsedChildModelRef {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${source} is required`);
  }

  const colonIndex = trimmed.indexOf(":");
  if (colonIndex === -1) {
    if (!defaultProvider) {
      throw new Error(`Unsupported ${source} "${trimmed}". Expected provider:modelId.`);
    }
    const modelId = normalizeModelIdForProvider(defaultProvider, trimmed, source, opts);
    return {
      provider: defaultProvider,
      modelId,
      ref: childModelRef(defaultProvider, modelId),
      explicitProvider: false,
    };
  }

  const providerRaw = trimmed.slice(0, colonIndex).trim();
  const modelRaw = trimmed.slice(colonIndex + 1).trim();
  if (!isProviderName(providerRaw)) {
    if (!defaultProvider) {
      throw new Error(`Unsupported ${source} "${trimmed}". Expected provider:modelId.`);
    }
    const modelId = normalizeModelIdForProvider(defaultProvider, trimmed, source, opts);
    return {
      provider: defaultProvider,
      modelId,
      ref: childModelRef(defaultProvider, modelId),
      explicitProvider: false,
    };
  }
  if (!modelRaw) {
    throw new Error(`Unsupported ${source} "${trimmed}". Expected provider:modelId.`);
  }

  const modelId = normalizeModelIdForProvider(providerRaw, modelRaw, source, opts);
  return {
    provider: providerRaw,
    modelId,
    ref: childModelRef(providerRaw, modelId),
    explicitProvider: true,
  };
}

function normalizeAllowedChildModelRefs(
  refs: readonly string[] | undefined,
  defaultProvider: ProviderName,
  source = "allowed child model",
  opts: { home?: string } = {},
): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of refs ?? []) {
    const parsed = parseChildModelRef(raw, defaultProvider, source, opts);
    if (seen.has(parsed.ref)) continue;
    seen.add(parsed.ref);
    normalized.push(parsed.ref);
  }
  return normalized;
}

function legacyPreferredChildModelForProvider(
  provider: ProviderName,
  currentModel: string,
  preferredChildModelRef?: string,
  opts: { home?: string } = {},
): string {
  if (!preferredChildModelRef) return currentModel;
  try {
    const parsed = parseChildModelRef(
      preferredChildModelRef,
      provider,
      "preferred child model ref",
      opts,
    );
    return parsed.provider === provider ? parsed.modelId : currentModel;
  } catch {
    return currentModel;
  }
}

function normalizeLegacyPreferredChildModel(
  provider: ProviderName,
  currentModel: string,
  preferredChildModel?: string | null,
  opts: { home?: string } = {},
): string {
  const trimmed = preferredChildModel?.trim();
  if (!trimmed) {
    return currentModel;
  }
  try {
    return normalizeModelIdForProvider(provider, trimmed, "preferred child model", opts);
  } catch {
    return currentModel;
  }
}

/**
 * Reported when an explicitly configured preferred child target could not be
 * honoured and was replaced by a safe one.
 *
 * A stale target is normal, not exceptional: it is what a config carries the
 * moment the provider changes, the routing mode flips, or a model leaves a
 * provider's catalog. Every caller wants the surrounding config to keep
 * applying, so the reset is the return value rather than a thrown error — this
 * record is how a caller logs or surfaces it.
 */
export type ChildRoutingTargetReset = {
  /** The configured target that could not be honoured, verbatim. */
  requested: string;
  /** The ref it was reset to. */
  resetTo: string;
  /** Human-readable explanation, safe to log. */
  reason: string;
};

export function normalizeChildRoutingConfig(opts: {
  provider: ProviderName;
  model: string;
  childModelRoutingMode?: unknown;
  preferredChildModel?: string | null;
  preferredChildModelRef?: string | null;
  allowedChildModelRefs?: readonly string[] | null;
  source?: string;
  home?: string;
}): {
  childModelRoutingMode: ChildModelRoutingMode;
  preferredChildModel: string;
  preferredChildModelRef: string;
  allowedChildModelRefs: string[];
  preferredTargetReset?: ChildRoutingTargetReset;
} {
  const source = opts.source ?? "child model routing";
  // Custom cross-registry ids are validated against the custom-model store,
  // which lives under the session's auth home. Thread it through every nested
  // normalize/parse call so non-default homes accept configured ids.
  const homeOpts = opts.home ? { home: opts.home } : {};
  const mode = isChildModelRoutingMode(opts.childModelRoutingMode)
    ? opts.childModelRoutingMode
    : "same-provider";
  const fallbackModelId = normalizeModelIdForProvider(opts.provider, opts.model, "model", homeOpts);
  const fallbackRef = childModelRef(opts.provider, fallbackModelId);
  const allowedChildModelRefs = normalizeAllowedChildModelRefs(
    opts.allowedChildModelRefs ?? undefined,
    opts.provider,
    `${source} allowlist entry`,
    homeOpts,
  );
  const preferredChildModel = normalizeLegacyPreferredChildModel(
    opts.provider,
    fallbackModelId,
    opts.preferredChildModel,
    homeOpts,
  );

  let preferredRef = fallbackRef;
  let preferredTargetReset: ChildRoutingTargetReset | undefined;
  const resetPreferredTarget = (requested: string, resetTo: string, reason: string): string => {
    preferredTargetReset = { requested, resetTo, reason };
    return resetTo;
  };
  const rawPreferredRef =
    typeof opts.preferredChildModelRef === "string" && opts.preferredChildModelRef.trim()
      ? opts.preferredChildModelRef.trim()
      : undefined;

  if (mode === "cross-provider-allowlist") {
    if (rawPreferredRef) {
      try {
        preferredRef = parseChildModelRef(
          rawPreferredRef,
          opts.provider,
          `${source} preferred child target`,
          homeOpts,
        ).ref;
      } catch (err) {
        preferredRef = resetPreferredTarget(
          rawPreferredRef,
          fallbackRef,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    if (allowedChildModelRefs.length > 0) {
      const firstAllowedRef = allowedChildModelRefs[0];
      if (firstAllowedRef && !allowedChildModelRefs.includes(preferredRef)) {
        // Narrowing an unset preference to the first allowed entry is routine, so
        // only an explicitly configured target that the allowlist excludes counts
        // as a reset worth reporting.
        preferredRef =
          rawPreferredRef && !preferredTargetReset
            ? resetPreferredTarget(
                rawPreferredRef,
                firstAllowedRef,
                `${source} preferred child target "${rawPreferredRef}" is not in the subagent model allowlist.`,
              )
            : firstAllowedRef;
      }
    } else {
      preferredRef = fallbackRef;
    }
  } else {
    const rawPreferredTarget =
      rawPreferredRef ??
      (typeof opts.preferredChildModel === "string" && opts.preferredChildModel.trim()
        ? opts.preferredChildModel.trim()
        : undefined);
    if (rawPreferredTarget) {
      try {
        const parsed = parseChildModelRef(
          rawPreferredTarget,
          opts.provider,
          `${source} preferred child target`,
          homeOpts,
        );
        preferredRef =
          parsed.provider === opts.provider
            ? parsed.ref
            : resetPreferredTarget(
                rawPreferredTarget,
                fallbackRef,
                `${source} preferred child target "${rawPreferredTarget}" belongs to provider ${parsed.provider}, but subagents are pinned to the chat provider ${opts.provider}.`,
              );
      } catch (err) {
        // Reached whenever the target outlives the config it was valid for — a
        // provider switch, a routing-mode flip, or a model dropping out of the
        // catalog. Falling back to the parent model keeps the rest of the config
        // applying; the caller reports the reset.
        preferredRef = resetPreferredTarget(
          rawPreferredTarget,
          fallbackRef,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  return {
    ...(preferredTargetReset ? { preferredTargetReset } : {}),
    childModelRoutingMode: mode,
    preferredChildModel:
      mode === "cross-provider-allowlist"
        ? typeof opts.preferredChildModel === "string" && opts.preferredChildModel.trim()
          ? preferredChildModel
          : legacyPreferredChildModelForProvider(opts.provider, opts.model, preferredRef, homeOpts)
        : legacyPreferredChildModelForProvider(opts.provider, opts.model, preferredRef, homeOpts),
    preferredChildModelRef: preferredRef,
    allowedChildModelRefs,
  };
}
