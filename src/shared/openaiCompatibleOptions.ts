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

export type OpenAiCompatibleProviderOptions = {
  reasoningEffort?: OpenAiReasoningEffort;
  reasoningSummary?: OpenAiReasoningSummary;
  textVerbosity?: OpenAiTextVerbosity;
};

export type OpenAiCompatibleProviderOptionsByProvider = Partial<
  Record<OpenAiCompatibleProviderName, OpenAiCompatibleProviderOptions>
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

export function pickEditableOpenAiCompatibleProviderOptions(
  providerOptions: unknown,
): OpenAiCompatibleProviderOptionsByProvider | undefined {
  if (!isPlainObject(providerOptions)) return undefined;

  const out: OpenAiCompatibleProviderOptionsByProvider = {};
  for (const provider of OPENAI_COMPATIBLE_PROVIDER_NAMES) {
    const section = providerOptions[provider];
    if (!isPlainObject(section)) continue;

    const next: OpenAiCompatibleProviderOptions = {};
    if (isOpenAiReasoningEffort(section.reasoningEffort)) {
      next.reasoningEffort = section.reasoningEffort;
    }
    if (isOpenAiReasoningSummary(section.reasoningSummary)) {
      next.reasoningSummary = section.reasoningSummary;
    }
    if (isOpenAiTextVerbosity(section.textVerbosity)) {
      next.textVerbosity = section.textVerbosity;
    }
    if (Object.keys(next).length > 0) {
      out[provider] = next;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
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

    const currentSection = isPlainObject(current[provider]) ? { ...current[provider] } : {};
    current[provider] = {
      ...currentSection,
      ...sectionPatch,
    };
  }

  return Object.keys(current).length > 0 ? current : undefined;
}
