import {
  GOOGLE_DYNAMIC_REASONING_EFFORT,
  type GoogleThinkingLevel,
  isGoogleThinkingLevel,
} from "./googleThinking";

const OPENAI_COMPATIBLE_PROVIDER_NAMES = ["openai", "codex-cli"] as const;
type OpenAiCompatibleProviderName = (typeof OPENAI_COMPATIBLE_PROVIDER_NAMES)[number];
const EDITABLE_PROVIDER_OPTIONS_PROVIDER_NAMES = [
  "openai",
  "codex-cli",
  "google",
  "anthropic",
  "bedrock",
  "lmstudio",
  "together",
  "fireworks",
  "firepass",
  "opencode-go",
  "opencode-zen",
  "claude-sdk",
  "antigravity-acp",
] as const;

// Canonical effort ladder shared by OpenAI-compatible providers and Codex.
// Not every provider accepts every value verbatim: "none" disables reasoning,
// "light" and "max" are only honored where a model advertises them, and each
// runtime downgrades unsupported values to the nearest level it can send.
export const OPENAI_REASONING_EFFORT_VALUES = [
  "none",
  "minimal",
  "light",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type OpenAiReasoningEffort = (typeof OPENAI_REASONING_EFFORT_VALUES)[number];

/**
 * Effort values every OpenAI-compatible model is assumed to accept when it
 * does not declare `supportedReasoningEfforts`. "light" and "max" are opt-in:
 * a model (or live discovery) must advertise them explicitly.
 */
export const DEFAULT_OPENAI_REASONING_EFFORT_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly OpenAiReasoningEffort[];

export const CATALOG_REASONING_EFFORT_VALUES = [
  "none",
  GOOGLE_DYNAMIC_REASONING_EFFORT,
  "minimal",
  "light",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type CatalogReasoningEffort = (typeof CATALOG_REASONING_EFFORT_VALUES)[number];

export const OPENAI_REASONING_SUMMARY_VALUES = ["auto", "concise", "detailed"] as const;
type OpenAiReasoningSummary = (typeof OPENAI_REASONING_SUMMARY_VALUES)[number];

export const OPENAI_TEXT_VERBOSITY_VALUES = ["low", "medium", "high"] as const;
type OpenAiTextVerbosity = (typeof OPENAI_TEXT_VERBOSITY_VALUES)[number];

export const CODEX_WEB_SEARCH_MODE_VALUES = ["disabled", "cached", "live"] as const;
type CodexWebSearchMode = (typeof CODEX_WEB_SEARCH_MODE_VALUES)[number];

export const LOCAL_WEB_SEARCH_PROVIDER_VALUES = ["exa", "parallel"] as const;
export type LocalWebSearchProvider = (typeof LOCAL_WEB_SEARCH_PROVIDER_VALUES)[number];

export const CODEX_WEB_SEARCH_BACKEND_VALUES = [
  "native",
  ...LOCAL_WEB_SEARCH_PROVIDER_VALUES,
] as const;
export type CodexWebSearchBackend = (typeof CODEX_WEB_SEARCH_BACKEND_VALUES)[number];

export const CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES = ["low", "medium", "high"] as const;
type CodexWebSearchContextSize = (typeof CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES)[number];

type CodexWebSearchLocation = {
  country?: string;
  region?: string;
  city?: string;
  timezone?: string;
};

type CodexWebSearchOptions = {
  contextSize?: CodexWebSearchContextSize;
  allowedDomains?: string[];
  location?: CodexWebSearchLocation;
};

type OpenAiCompatibleProviderOptions = {
  reasoningEffort?: OpenAiReasoningEffort;
  reasoningSummary?: OpenAiReasoningSummary;
  textVerbosity?: OpenAiTextVerbosity;
};

type OpenAiProviderOptions = OpenAiCompatibleProviderOptions;

type CodexCliProviderOptions = OpenAiCompatibleProviderOptions & {
  webSearchBackend?: CodexWebSearchBackend;
  webSearchFallbackBackend?: LocalWebSearchProvider;
  webSearchMode?: CodexWebSearchMode;
  webSearch?: CodexWebSearchOptions;
};

type LmStudioProviderOptions = {
  baseUrl?: string;
  contextLength?: number;
  autoLoad?: boolean;
  reloadOnContextMismatch?: boolean;
  reasoningEffort?: OpenAiReasoningEffort;
};

type AnthropicThinkingOptions = {
  type?: "adaptive" | "enabled" | "disabled";
  budgetTokens?: number;
};

type AnthropicProviderOptions = {
  effort?: OpenAiReasoningEffort;
  reasoningEffort?: OpenAiReasoningEffort;
  thinking?: AnthropicThinkingOptions;
};

type ReasoningEffortProviderOptions = {
  reasoningEffort?: OpenAiReasoningEffort;
  effort?: OpenAiReasoningEffort;
};

type GoogleThinkingConfig = {
  thinkingLevel?: GoogleThinkingLevel;
};

type GoogleProviderOptions = {
  nativeWebSearch?: boolean;
  thinkingConfig?: GoogleThinkingConfig;
  responseFormat?: unknown;
  responseMimeType?: string;
};

export type OpenAiCompatibleProviderOptionsByProvider = Partial<{
  openai: OpenAiProviderOptions;
  "codex-cli": CodexCliProviderOptions;
  google: GoogleProviderOptions;
  anthropic: AnthropicProviderOptions;
  bedrock: ReasoningEffortProviderOptions;
  lmstudio: LmStudioProviderOptions;
  together: ReasoningEffortProviderOptions;
  fireworks: ReasoningEffortProviderOptions;
  firepass: ReasoningEffortProviderOptions;
  "opencode-go": ReasoningEffortProviderOptions;
  "opencode-zen": ReasoningEffortProviderOptions;
  "claude-sdk": ReasoningEffortProviderOptions;
  "antigravity-acp": ReasoningEffortProviderOptions;
}>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpenAiCompatibleProviderName(value: unknown): value is OpenAiCompatibleProviderName {
  return (
    typeof value === "string" &&
    (OPENAI_COMPATIBLE_PROVIDER_NAMES as readonly string[]).includes(value)
  );
}

export function isOpenAiReasoningEffort(value: unknown): value is OpenAiReasoningEffort {
  return (
    typeof value === "string" &&
    (OPENAI_REASONING_EFFORT_VALUES as readonly string[]).includes(value)
  );
}

function isCatalogReasoningEffort(value: unknown): value is CatalogReasoningEffort {
  return (
    typeof value === "string" &&
    (CATALOG_REASONING_EFFORT_VALUES as readonly string[]).includes(value)
  );
}

function isOpenAiReasoningSummary(value: unknown): value is OpenAiReasoningSummary {
  return (
    typeof value === "string" &&
    (OPENAI_REASONING_SUMMARY_VALUES as readonly string[]).includes(value)
  );
}

function isOpenAiTextVerbosity(value: unknown): value is OpenAiTextVerbosity {
  return (
    typeof value === "string" && (OPENAI_TEXT_VERBOSITY_VALUES as readonly string[]).includes(value)
  );
}

function isCodexWebSearchMode(value: unknown): value is CodexWebSearchMode {
  return (
    typeof value === "string" && (CODEX_WEB_SEARCH_MODE_VALUES as readonly string[]).includes(value)
  );
}

function isCodexWebSearchBackend(value: unknown): value is CodexWebSearchBackend {
  return (
    typeof value === "string" &&
    (CODEX_WEB_SEARCH_BACKEND_VALUES as readonly string[]).includes(value)
  );
}

function isLocalWebSearchProvider(value: unknown): value is LocalWebSearchProvider {
  return (
    typeof value === "string" &&
    (LOCAL_WEB_SEARCH_PROVIDER_VALUES as readonly string[]).includes(value)
  );
}

function isCodexWebSearchContextSize(value: unknown): value is CodexWebSearchContextSize {
  return (
    typeof value === "string" &&
    (CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES as readonly string[]).includes(value)
  );
}

function pickTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function pickStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const next = value
    .map((entry) => pickTrimmedString(entry))
    .filter((entry): entry is string => !!entry);
  return next;
}

function pickPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : undefined;
  }
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) return undefined;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : undefined;
}

function pickBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return undefined;
}

function pickCodexWebSearchLocation(value: unknown): CodexWebSearchLocation | undefined {
  if (!isPlainObject(value)) return undefined;

  const next: CodexWebSearchLocation = {};
  const country = pickTrimmedString(value.country);
  if (country) next.country = country;
  const region = pickTrimmedString(value.region);
  if (region) next.region = region;
  const city = pickTrimmedString(value.city);
  if (city) next.city = city;
  const timezone = pickTrimmedString(value.timezone);
  if (timezone) next.timezone = timezone;

  return next;
}

function pickCodexWebSearchOptions(value: unknown): CodexWebSearchOptions | undefined {
  if (!isPlainObject(value)) return undefined;

  const next: CodexWebSearchOptions = {};
  if (isCodexWebSearchContextSize(value.contextSize)) {
    next.contextSize = value.contextSize;
  }
  const allowedDomains = pickStringArray(value.allowedDomains);
  if (allowedDomains) {
    next.allowedDomains = allowedDomains;
  }
  const location = pickCodexWebSearchLocation(value.location);
  if (location) {
    next.location = location;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function pickOpenAiCompatibleProviderOptionsSection(
  value: unknown,
): OpenAiCompatibleProviderOptions | undefined {
  if (!isPlainObject(value)) return undefined;

  const next: OpenAiCompatibleProviderOptions = {};
  if (isOpenAiReasoningEffort(value.reasoningEffort)) {
    next.reasoningEffort = value.reasoningEffort;
  }
  if (isOpenAiReasoningSummary(value.reasoningSummary)) {
    next.reasoningSummary = value.reasoningSummary;
  }
  if (isOpenAiTextVerbosity(value.textVerbosity)) {
    next.textVerbosity = value.textVerbosity;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function pickCodexCliProviderOptionsSection(value: unknown): CodexCliProviderOptions | undefined {
  if (!isPlainObject(value)) return undefined;

  const next: CodexCliProviderOptions = {
    ...(pickOpenAiCompatibleProviderOptionsSection(value) ?? {}),
  };
  if (isCodexWebSearchBackend(value.webSearchBackend)) {
    next.webSearchBackend = value.webSearchBackend;
  }
  if (isLocalWebSearchProvider(value.webSearchFallbackBackend)) {
    next.webSearchFallbackBackend = value.webSearchFallbackBackend;
  }
  if (isCodexWebSearchMode(value.webSearchMode)) {
    next.webSearchMode = value.webSearchMode;
  }
  const webSearch = pickCodexWebSearchOptions(value.webSearch);
  if (webSearch) {
    next.webSearch = webSearch;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function pickLmStudioProviderOptionsSection(value: unknown): LmStudioProviderOptions | undefined {
  if (!isPlainObject(value)) return undefined;

  const next: LmStudioProviderOptions = {};
  const baseUrl = pickTrimmedString(value.baseUrl);
  if (baseUrl) {
    next.baseUrl = baseUrl;
  }
  const contextLength = pickPositiveInteger(value.contextLength);
  if (contextLength !== undefined) {
    next.contextLength = contextLength;
  }
  const autoLoad = pickBoolean(value.autoLoad);
  if (autoLoad !== undefined) {
    next.autoLoad = autoLoad;
  }
  const reloadOnContextMismatch = pickBoolean(value.reloadOnContextMismatch);
  if (reloadOnContextMismatch !== undefined) {
    next.reloadOnContextMismatch = reloadOnContextMismatch;
  }
  if (isOpenAiReasoningEffort(value.reasoningEffort)) {
    next.reasoningEffort = value.reasoningEffort;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function pickAnthropicProviderOptionsSection(value: unknown): AnthropicProviderOptions | undefined {
  if (!isPlainObject(value)) return undefined;
  const next: AnthropicProviderOptions = {};
  if (isOpenAiReasoningEffort(value.effort)) {
    next.effort = value.effort;
  }
  if (isOpenAiReasoningEffort(value.reasoningEffort)) {
    next.reasoningEffort = value.reasoningEffort;
  }
  if (isPlainObject(value.thinking)) {
    const t: AnthropicThinkingOptions = {};
    if (
      value.thinking.type === "adaptive" ||
      value.thinking.type === "enabled" ||
      value.thinking.type === "disabled"
    ) {
      t.type = value.thinking.type;
    }
    const budget = pickPositiveInteger(value.thinking.budgetTokens);
    if (budget !== undefined) {
      t.budgetTokens = budget;
    }
    if (Object.keys(t).length > 0) {
      next.thinking = t;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function pickReasoningEffortProviderOptionsSection(
  value: unknown,
): ReasoningEffortProviderOptions | undefined {
  if (!isPlainObject(value)) return undefined;
  const next: ReasoningEffortProviderOptions = {};
  if (isOpenAiReasoningEffort(value.reasoningEffort)) {
    next.reasoningEffort = value.reasoningEffort;
  }
  if (isOpenAiReasoningEffort(value.effort)) {
    next.effort = value.effort;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function pickGoogleThinkingConfig(value: unknown): GoogleThinkingConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  if (
    typeof value.thinkingLevel === "string" &&
    value.thinkingLevel.trim().toLowerCase() === GOOGLE_DYNAMIC_REASONING_EFFORT
  ) {
    return {};
  }

  const next: GoogleThinkingConfig = {};
  if (isGoogleThinkingLevel(value.thinkingLevel)) {
    next.thinkingLevel = value.thinkingLevel;
  }

  if (Object.keys(next).length > 0) {
    return next;
  }

  return Object.keys(value).length === 0 ? {} : undefined;
}

function pickGoogleProviderOptionsSection(value: unknown): GoogleProviderOptions | undefined {
  if (!isPlainObject(value)) return undefined;

  const next: GoogleProviderOptions = {};
  const nativeWebSearch = pickBoolean(value.nativeWebSearch);
  if (nativeWebSearch !== undefined) {
    next.nativeWebSearch = nativeWebSearch;
  }
  const thinkingConfig = pickGoogleThinkingConfig(value.thinkingConfig);
  if (thinkingConfig) {
    next.thinkingConfig = thinkingConfig;
  }
  if (value.responseFormat !== undefined) {
    next.responseFormat = value.responseFormat;
  }
  const responseMimeType = pickTrimmedString(value.responseMimeType);
  if (responseMimeType) {
    next.responseMimeType = responseMimeType;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

export function pickEditableOpenAiCompatibleProviderOptions(
  providerOptions: unknown,
): OpenAiCompatibleProviderOptionsByProvider | undefined {
  if (!isPlainObject(providerOptions)) return undefined;

  const out: OpenAiCompatibleProviderOptionsByProvider = {};
  const openai = pickOpenAiCompatibleProviderOptionsSection(providerOptions.openai);
  if (openai) {
    out.openai = openai;
  }
  const codex = pickCodexCliProviderOptionsSection(providerOptions["codex-cli"]);
  if (codex) {
    out["codex-cli"] = codex;
  }
  const google = pickGoogleProviderOptionsSection(providerOptions.google);
  if (google) {
    out.google = google;
  }
  const anthropic = pickAnthropicProviderOptionsSection(providerOptions.anthropic);
  if (anthropic) {
    out.anthropic = anthropic;
  }
  const lmstudio = pickLmStudioProviderOptionsSection(providerOptions.lmstudio);
  if (lmstudio) {
    out.lmstudio = lmstudio;
  }
  for (const provider of [
    "bedrock",
    "together",
    "fireworks",
    "firepass",
    "opencode-go",
    "opencode-zen",
    "claude-sdk",
    "antigravity-acp",
  ] as const) {
    const picked = pickReasoningEffortProviderOptionsSection(providerOptions[provider]);
    if (picked) {
      out[provider] = picked;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export function getCodexWebSearchBackendFromProviderOptions(
  providerOptions: unknown,
  fallback: CodexWebSearchBackend = "native",
): CodexWebSearchBackend {
  if (!isPlainObject(providerOptions)) return fallback;
  const codex = pickCodexCliProviderOptionsSection(providerOptions["codex-cli"]);
  return codex?.webSearchBackend ?? fallback;
}

export function getLocalWebSearchProviderFromProviderOptions(
  providerOptions: unknown,
  fallback: LocalWebSearchProvider = "exa",
): LocalWebSearchProvider {
  if (!isPlainObject(providerOptions)) return fallback;
  const codex = pickCodexCliProviderOptionsSection(providerOptions["codex-cli"]);
  const backend = codex?.webSearchBackend ?? "native";
  if (backend === "exa" || backend === "parallel") return backend;
  return codex?.webSearchFallbackBackend ?? fallback;
}

export function getGoogleNativeWebSearchFromProviderOptions(
  providerOptions: unknown,
  fallback = false,
): boolean {
  if (providerOptions == null) return true;
  if (!isPlainObject(providerOptions)) return fallback;

  const rawGoogle = isPlainObject(providerOptions.google) ? providerOptions.google : undefined;
  const explicit = rawGoogle ? pickBoolean(rawGoogle.nativeWebSearch) : undefined;
  if (explicit !== undefined) {
    return explicit;
  }

  return getCodexWebSearchBackendFromProviderOptions(providerOptions, "native") === "native";
}

export function getGoogleThinkingLevelFromProviderOptions(
  providerOptions: unknown,
): GoogleThinkingLevel | undefined {
  if (!isPlainObject(providerOptions)) return undefined;
  const google = pickGoogleProviderOptionsSection(providerOptions.google);
  return google?.thinkingConfig?.thinkingLevel;
}

export function mergeEditableOpenAiCompatibleProviderOptions(
  base: unknown,
  patch: OpenAiCompatibleProviderOptionsByProvider | undefined,
): Record<string, unknown> | undefined {
  const current = isPlainObject(base) ? { ...base } : {};
  if (!patch) {
    return Object.keys(current).length > 0 ? current : undefined;
  }

  for (const provider of EDITABLE_PROVIDER_OPTIONS_PROVIDER_NAMES) {
    const sectionPatch = patch[provider];
    if (!sectionPatch) continue;
    const cleanedPatch =
      provider === "codex-cli"
        ? pickCodexCliProviderOptionsSection(sectionPatch)
        : provider === "openai"
          ? pickOpenAiCompatibleProviderOptionsSection(sectionPatch)
          : provider === "google"
            ? pickGoogleProviderOptionsSection(sectionPatch)
            : provider === "anthropic"
              ? pickAnthropicProviderOptionsSection(sectionPatch)
              : provider === "lmstudio"
                ? pickLmStudioProviderOptionsSection(sectionPatch)
                : pickReasoningEffortProviderOptionsSection(sectionPatch);
    if (!cleanedPatch) continue;

    const currentSection = isPlainObject(current[provider]) ? { ...current[provider] } : {};
    if (provider === "codex-cli") {
      const codexPatch = cleanedPatch as CodexCliProviderOptions;
      const currentWebSearch = isPlainObject(currentSection.webSearch)
        ? { ...currentSection.webSearch }
        : {};
      const patchWebSearch = isPlainObject(codexPatch.webSearch) ? { ...codexPatch.webSearch } : {};
      const currentLocation = isPlainObject(currentWebSearch.location)
        ? { ...currentWebSearch.location }
        : {};
      const patchHasLocation = "location" in patchWebSearch;
      const patchLocation = isPlainObject(patchWebSearch.location)
        ? { ...patchWebSearch.location }
        : {};

      let resolvedLocation: Record<string, unknown> | undefined;
      if (patchHasLocation) {
        // Explicit patch: empty = clear, non-empty = merge
        resolvedLocation =
          Object.keys(patchLocation).length > 0
            ? { ...currentLocation, ...patchLocation }
            : undefined;
      } else if (Object.keys(currentLocation).length > 0) {
        resolvedLocation = currentLocation;
      }

      const { location: _dropped, ...patchWebSearchRest } = patchWebSearch as Record<
        string,
        unknown
      >;
      const nextWebSearch = {
        ...currentWebSearch,
        ...patchWebSearchRest,
        ...(resolvedLocation ? { location: resolvedLocation } : {}),
      };
      // When patch explicitly cleared location, remove stale key from merge
      if (patchHasLocation && !resolvedLocation) {
        delete (nextWebSearch as Record<string, unknown>).location;
      }
      current[provider] = {
        ...currentSection,
        ...codexPatch,
        ...(Object.keys(nextWebSearch).length > 0 ? { webSearch: nextWebSearch } : {}),
      };
      continue;
    }

    if (provider === "google") {
      const googlePatch = cleanedPatch as GoogleProviderOptions;
      const rawPatch = isPlainObject(sectionPatch) ? sectionPatch : {};
      const patchHasThinkingConfig = Object.hasOwn(rawPatch, "thinkingConfig");
      const currentThinkingConfig = isPlainObject(currentSection.thinkingConfig)
        ? { ...currentSection.thinkingConfig }
        : {};
      const patchThinkingConfig = isPlainObject(googlePatch.thinkingConfig)
        ? { ...googlePatch.thinkingConfig }
        : {};

      const nextGoogle = {
        ...currentSection,
        ...googlePatch,
      } as Record<string, unknown>;

      if (patchHasThinkingConfig) {
        const nextThinkingConfig = { ...currentThinkingConfig };
        if ("thinkingLevel" in patchThinkingConfig) {
          const level = patchThinkingConfig.thinkingLevel;
          if (typeof level === "string" && level.trim().length > 0) {
            nextThinkingConfig.thinkingLevel = level;
          } else {
            delete nextThinkingConfig.thinkingLevel;
          }
        } else {
          delete nextThinkingConfig.thinkingLevel;
        }

        nextGoogle.thinkingConfig =
          Object.keys(nextThinkingConfig).length > 0 ? nextThinkingConfig : {};
      }

      current[provider] = nextGoogle;
      continue;
    }

    current[provider] = {
      ...currentSection,
      ...cleanedPatch,
    };
  }

  return Object.keys(current).length > 0 ? current : undefined;
}
