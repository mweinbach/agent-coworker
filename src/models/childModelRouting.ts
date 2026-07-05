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
      } catch {
        preferredRef = fallbackRef;
      }
    }
    if (allowedChildModelRefs.length > 0) {
      const firstAllowedRef = allowedChildModelRefs[0];
      if (firstAllowedRef) {
        preferredRef = allowedChildModelRefs.includes(preferredRef)
          ? preferredRef
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
      preferredRef = parseChildModelRef(
        rawPreferredTarget,
        opts.provider,
        `${source} preferred child target`,
        homeOpts,
      ).ref;
    }
    const parsedPreferred = parseChildModelRef(
      preferredRef,
      opts.provider,
      `${source} preferred child target`,
      homeOpts,
    );
    preferredRef = parsedPreferred.provider === opts.provider ? parsedPreferred.ref : fallbackRef;
  }

  return {
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
