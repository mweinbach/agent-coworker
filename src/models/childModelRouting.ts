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
    const modelId = normalizeModelIdForProvider(defaultProvider, trimmed, source);
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
    const modelId = normalizeModelIdForProvider(defaultProvider, trimmed, source);
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

  const modelId = normalizeModelIdForProvider(providerRaw, modelRaw, source);
  return {
    provider: providerRaw,
    modelId,
    ref: childModelRef(providerRaw, modelId),
    explicitProvider: true,
  };
}

export function normalizeAllowedChildModelRefs(
  refs: readonly string[] | undefined,
  defaultProvider: ProviderName,
  source = "allowed child model",
): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of refs ?? []) {
    const parsed = parseChildModelRef(raw, defaultProvider, source);
    if (seen.has(parsed.ref)) continue;
    seen.add(parsed.ref);
    normalized.push(parsed.ref);
  }
  return normalized;
}

export function legacyPreferredChildModelForProvider(
  provider: ProviderName,
  currentModel: string,
  preferredChildModelRef?: string,
): string {
  if (!preferredChildModelRef) return currentModel;
  try {
    const parsed = parseChildModelRef(
      preferredChildModelRef,
      provider,
      "preferred child model ref",
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
): string {
  const trimmed = preferredChildModel?.trim();
  if (!trimmed) {
    return currentModel;
  }
  try {
    return normalizeModelIdForProvider(provider, trimmed, "preferred child model");
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
}): {
  childModelRoutingMode: ChildModelRoutingMode;
  preferredChildModel: string;
  preferredChildModelRef: string;
  allowedChildModelRefs: string[];
} {
  const source = opts.source ?? "child model routing";
  const mode = isChildModelRoutingMode(opts.childModelRoutingMode)
    ? opts.childModelRoutingMode
    : "same-provider";
  const fallbackModelId = normalizeModelIdForProvider(opts.provider, opts.model, "model");
  const fallbackRef = childModelRef(opts.provider, fallbackModelId);
  const allowedChildModelRefs = normalizeAllowedChildModelRefs(
    opts.allowedChildModelRefs ?? undefined,
    opts.provider,
    `${source} allowlist entry`,
  );
  const preferredChildModel = normalizeLegacyPreferredChildModel(
    opts.provider,
    fallbackModelId,
    opts.preferredChildModel,
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
      ).ref;
    }
    const parsedPreferred = parseChildModelRef(
      preferredRef,
      opts.provider,
      `${source} preferred child target`,
    );
    preferredRef = parsedPreferred.provider === opts.provider ? parsedPreferred.ref : fallbackRef;
  }

  return {
    childModelRoutingMode: mode,
    preferredChildModel:
      mode === "cross-provider-allowlist"
        ? typeof opts.preferredChildModel === "string" && opts.preferredChildModel.trim()
          ? preferredChildModel
          : legacyPreferredChildModelForProvider(opts.provider, opts.model, preferredRef)
        : legacyPreferredChildModelForProvider(opts.provider, opts.model, preferredRef),
    preferredChildModelRef: preferredRef,
    allowedChildModelRefs,
  };
}
