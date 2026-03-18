export const OPENAI_COMPATIBLE_PROVIDER_NAMES = ["openai", "codex-cli"] as const;
export type OpenAiCompatibleProviderName = (typeof OPENAI_COMPATIBLE_PROVIDER_NAMES)[number];

// "none" and "xhigh" are client-side sentinel values used to represent "disable reasoning"
// and "maximum effort" respectively. They are mapped to API-specific parameters before
// being sent to the provider and are not passed to the OpenAI API verbatim.
export const OPENAI_REASONING_EFFORT_VALUES = ["none", "low", "medium", "high", "xhigh"] as const;
export type OpenAiReasoningEffort = (typeof OPENAI_REASONING_EFFORT_VALUES)[number];

export const OPENAI_REASONING_SUMMARY_VALUES = ["auto", "concise", "detailed"] as const;
export type OpenAiReasoningSummary = (typeof OPENAI_REASONING_SUMMARY_VALUES)[number];

export const OPENAI_TEXT_VERBOSITY_VALUES = ["low", "medium", "high"] as const;
export type OpenAiTextVerbosity = (typeof OPENAI_TEXT_VERBOSITY_VALUES)[number];

export const CODEX_WEB_SEARCH_MODE_VALUES = ["disabled", "cached", "live"] as const;
export type CodexWebSearchMode = (typeof CODEX_WEB_SEARCH_MODE_VALUES)[number];

export const CODEX_WEB_SEARCH_BACKEND_VALUES = ["native", "exa"] as const;
export type CodexWebSearchBackend = (typeof CODEX_WEB_SEARCH_BACKEND_VALUES)[number];

export const CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES = ["low", "medium", "high"] as const;
export type CodexWebSearchContextSize = (typeof CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES)[number];

export type CodexWebSearchLocation = {
  country?: string;
  region?: string;
  city?: string;
  timezone?: string;
};

export type CodexWebSearchOptions = {
  contextSize?: CodexWebSearchContextSize;
  allowedDomains?: string[];
  location?: CodexWebSearchLocation;
};

export type OpenAiCompatibleProviderOptions = {
  reasoningEffort?: OpenAiReasoningEffort;
  reasoningSummary?: OpenAiReasoningSummary;
  textVerbosity?: OpenAiTextVerbosity;
};

export type OpenAiProviderOptions = OpenAiCompatibleProviderOptions;

export type CodexCliProviderOptions = OpenAiCompatibleProviderOptions & {
  webSearchBackend?: CodexWebSearchBackend;
  webSearchMode?: CodexWebSearchMode;
  webSearch?: CodexWebSearchOptions;
};

export type OpenAiCompatibleProviderOptionsByProvider = Partial<
  {
    openai: OpenAiProviderOptions;
    "codex-cli": CodexCliProviderOptions;
  }
>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOpenAiCompatibleProviderName(value: unknown): value is OpenAiCompatibleProviderName {
  return typeof value === "string" && (OPENAI_COMPATIBLE_PROVIDER_NAMES as readonly string[]).includes(value);
}

export function isOpenAiReasoningEffort(value: unknown): value is OpenAiReasoningEffort {
  return typeof value === "string" && (OPENAI_REASONING_EFFORT_VALUES as readonly string[]).includes(value);
}

export function isOpenAiReasoningSummary(value: unknown): value is OpenAiReasoningSummary {
  return typeof value === "string" && (OPENAI_REASONING_SUMMARY_VALUES as readonly string[]).includes(value);
}

export function isOpenAiTextVerbosity(value: unknown): value is OpenAiTextVerbosity {
  return typeof value === "string" && (OPENAI_TEXT_VERBOSITY_VALUES as readonly string[]).includes(value);
}

export function isCodexWebSearchMode(value: unknown): value is CodexWebSearchMode {
  return typeof value === "string" && (CODEX_WEB_SEARCH_MODE_VALUES as readonly string[]).includes(value);
}

export function isCodexWebSearchBackend(value: unknown): value is CodexWebSearchBackend {
  return typeof value === "string" && (CODEX_WEB_SEARCH_BACKEND_VALUES as readonly string[]).includes(value);
}

export function isCodexWebSearchContextSize(value: unknown): value is CodexWebSearchContextSize {
  return typeof value === "string" && (CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES as readonly string[]).includes(value);
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

function pickOpenAiCompatibleProviderOptionsSection(value: unknown): OpenAiCompatibleProviderOptions | undefined {
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
  if (isCodexWebSearchMode(value.webSearchMode)) {
    next.webSearchMode = value.webSearchMode;
  }
  const webSearch = pickCodexWebSearchOptions(value.webSearch);
  if (webSearch) {
    next.webSearch = webSearch;
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

export function mergeEditableOpenAiCompatibleProviderOptions(
  base: unknown,
  patch: OpenAiCompatibleProviderOptionsByProvider | undefined,
): Record<string, unknown> | undefined {
  const current = isPlainObject(base) ? { ...base } : {};
  if (!patch) {
    return Object.keys(current).length > 0 ? current : undefined;
  }

  for (const provider of OPENAI_COMPATIBLE_PROVIDER_NAMES) {
    const sectionPatch = patch[provider];
    if (!sectionPatch) continue;
    const cleanedPatch = provider === "codex-cli"
      ? pickCodexCliProviderOptionsSection(sectionPatch)
      : pickOpenAiCompatibleProviderOptionsSection(sectionPatch);
    if (!cleanedPatch) continue;

    const currentSection = isPlainObject(current[provider]) ? { ...current[provider] } : {};
    if (provider === "codex-cli") {
      const codexPatch = cleanedPatch as CodexCliProviderOptions;
      const currentWebSearch = isPlainObject(currentSection.webSearch) ? { ...currentSection.webSearch } : {};
      const patchWebSearch = isPlainObject(codexPatch.webSearch) ? { ...codexPatch.webSearch } : {};
      const currentLocation = isPlainObject(currentWebSearch.location) ? { ...currentWebSearch.location } : {};
      const patchHasLocation = "location" in patchWebSearch;
      const patchLocation = isPlainObject(patchWebSearch.location) ? { ...patchWebSearch.location } : {};

      let resolvedLocation: Record<string, unknown> | undefined;
      if (patchHasLocation) {
        // Explicit patch: empty = clear, non-empty = merge
        resolvedLocation = Object.keys(patchLocation).length > 0
          ? { ...currentLocation, ...patchLocation }
          : undefined;
      } else if (Object.keys(currentLocation).length > 0) {
        resolvedLocation = currentLocation;
      }

      const { location: _dropped, ...patchWebSearchRest } = patchWebSearch as Record<string, unknown>;
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
        ...(
          Object.keys(nextWebSearch).length > 0
            ? { webSearch: nextWebSearch }
            : {}
        ),
      };
      continue;
    }

    current[provider] = {
      ...currentSection,
      ...cleanedPatch,
    };
  }

  return Object.keys(current).length > 0 ? current : undefined;
}
