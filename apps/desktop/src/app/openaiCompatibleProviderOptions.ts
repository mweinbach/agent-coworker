import {
  CODEX_WEB_SEARCH_BACKEND_VALUES,
  CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES,
  CODEX_WEB_SEARCH_MODE_VALUES,
  getCodexWebSearchBackendFromProviderOptions,
  getLocalWebSearchProviderFromProviderOptions,
  getGoogleNativeWebSearchFromProviderOptions,
  getGoogleThinkingLevelFromProviderOptions,
  LOCAL_WEB_SEARCH_PROVIDER_VALUES,
  mergeEditableOpenAiCompatibleProviderOptions,
  OPENAI_COMPATIBLE_PROVIDER_NAMES,
  OPENAI_REASONING_EFFORT_VALUES,
  OPENAI_REASONING_SUMMARY_VALUES,
  OPENAI_TEXT_VERBOSITY_VALUES,
  pickEditableOpenAiCompatibleProviderOptions,
  type CodexCliProviderOptions as SharedCodexCliProviderOptions,
  type CodexWebSearchBackend,
  type CodexWebSearchContextSize,
  type CodexWebSearchLocation,
  type CodexWebSearchMode,
  type GoogleProviderOptions as SharedGoogleProviderOptions,
  type LocalWebSearchProvider,
  type OpenAiCompatibleProviderName as SharedOpenAiCompatibleProviderName,
  type OpenAiCompatibleProviderOptions as SharedOpenAiCompatibleProviderOptions,
  type OpenAiCompatibleProviderOptionsByProvider,
  type OpenAiReasoningEffort,
  type OpenAiReasoningSummary,
  type OpenAiTextVerbosity,
} from "../../../../src/shared/openaiCompatibleOptions";
import {
  GOOGLE_DYNAMIC_REASONING_EFFORT,
  normalizeGoogleThinkingLevelForModel,
  listGoogleReasoningEffortValuesForModel,
  googleReasoningEffortFromThinkingLevel,
  type GoogleReasoningEffort,
  type GoogleThinkingLevel,
} from "../../../../src/shared/googleThinking";

export const REASONING_EFFORT_VALUES = OPENAI_REASONING_EFFORT_VALUES;
export const REASONING_SUMMARY_VALUES = OPENAI_REASONING_SUMMARY_VALUES;
export const TEXT_VERBOSITY_VALUES = OPENAI_TEXT_VERBOSITY_VALUES;
export const WEB_SEARCH_BACKEND_VALUES = CODEX_WEB_SEARCH_BACKEND_VALUES;
export const WEB_SEARCH_MODE_VALUES = CODEX_WEB_SEARCH_MODE_VALUES;
export const WEB_SEARCH_CONTEXT_SIZE_VALUES = CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES;
export const LOCAL_WEB_SEARCH_PROVIDERS = LOCAL_WEB_SEARCH_PROVIDER_VALUES;
export const GOOGLE_DYNAMIC_REASONING_VALUE = GOOGLE_DYNAMIC_REASONING_EFFORT;
export const DEFAULT_CODEX_WEB_SEARCH_BACKEND: CodexWebSearchBackend = "native";
export const DEFAULT_CODEX_WEB_SEARCH_MODE: CodexWebSearchMode = "live";
export const DEFAULT_LOCAL_WEB_SEARCH_PROVIDER: LocalWebSearchProvider = "exa";

export type OpenAICompatibleProviderName = SharedOpenAiCompatibleProviderName;
export type ReasoningEffortValue = OpenAiReasoningEffort;
export type ReasoningSummaryValue = OpenAiReasoningSummary;
export type TextVerbosityValue = OpenAiTextVerbosity;
export type WebSearchBackendValue = CodexWebSearchBackend;
export type LocalWebSearchProviderValue = LocalWebSearchProvider;
export type WebSearchModeValue = CodexWebSearchMode;
export type WebSearchContextSizeValue = CodexWebSearchContextSize;
export type WebSearchLocationValue = CodexWebSearchLocation;
export type GoogleReasoningEffortValue = GoogleReasoningEffort;
export type GoogleThinkingLevelValue = GoogleThinkingLevel;

export type OpenAICompatibleProviderOptions = SharedOpenAiCompatibleProviderOptions;
export type CodexCliProviderOptions = SharedCodexCliProviderOptions;
export type GoogleProviderOptions = SharedGoogleProviderOptions;
export type WorkspaceProviderOptions = OpenAiCompatibleProviderOptionsByProvider;

export const DEFAULT_WORKSPACE_PROVIDER_OPTIONS: {
  openai: Required<OpenAICompatibleProviderOptions>;
  "codex-cli": Required<OpenAICompatibleProviderOptions>;
} = {
  openai: {
    reasoningEffort: "high",
    reasoningSummary: "detailed",
    textVerbosity: "medium",
  },
  "codex-cli": {
    reasoningEffort: "high",
    reasoningSummary: "detailed",
    textVerbosity: "medium",
  },
};

function cloneLocation(location?: CodexWebSearchLocation): CodexWebSearchLocation | undefined {
  if (!location) return undefined;
  return {
    ...(location.country ? { country: location.country } : {}),
    ...(location.region ? { region: location.region } : {}),
    ...(location.city ? { city: location.city } : {}),
    ...(location.timezone ? { timezone: location.timezone } : {}),
  };
}

export function normalizeWorkspaceProviderOptions(value: unknown): WorkspaceProviderOptions | undefined {
  return pickEditableOpenAiCompatibleProviderOptions(value) as WorkspaceProviderOptions | undefined;
}

export function mergeWorkspaceProviderOptions(
  base?: WorkspaceProviderOptions,
  patch?: WorkspaceProviderOptions,
): WorkspaceProviderOptions | undefined {
  const merged = mergeEditableOpenAiCompatibleProviderOptions(base, patch);
  return normalizeWorkspaceProviderOptions(merged);
}

export function getWorkspaceReasoningEffort(
  options: WorkspaceProviderOptions | undefined,
  provider: OpenAICompatibleProviderName,
): ReasoningEffortValue {
  return options?.[provider]?.reasoningEffort ?? DEFAULT_WORKSPACE_PROVIDER_OPTIONS[provider].reasoningEffort;
}

export function getWorkspaceTextVerbosity(
  options: WorkspaceProviderOptions | undefined,
  provider: OpenAICompatibleProviderName,
): TextVerbosityValue {
  return options?.[provider]?.textVerbosity ?? DEFAULT_WORKSPACE_PROVIDER_OPTIONS[provider].textVerbosity;
}

export function getWorkspaceReasoningSummary(
  options: WorkspaceProviderOptions | undefined,
  provider: OpenAICompatibleProviderName,
): ReasoningSummaryValue {
  return options?.[provider]?.reasoningSummary ?? DEFAULT_WORKSPACE_PROVIDER_OPTIONS[provider].reasoningSummary;
}

export function getWorkspaceWebSearchMode(
  options: WorkspaceProviderOptions | undefined,
  fallback: WebSearchModeValue = DEFAULT_CODEX_WEB_SEARCH_MODE,
): WebSearchModeValue {
  return options?.["codex-cli"]?.webSearchMode ?? fallback;
}

export function getWorkspaceWebSearchBackend(
  options: WorkspaceProviderOptions | undefined,
  fallback: WebSearchBackendValue = DEFAULT_CODEX_WEB_SEARCH_BACKEND,
): WebSearchBackendValue {
  return getCodexWebSearchBackendFromProviderOptions(options, fallback);
}

export function getWorkspaceLocalWebSearchProvider(
  options: WorkspaceProviderOptions | undefined,
  fallback: LocalWebSearchProviderValue = DEFAULT_LOCAL_WEB_SEARCH_PROVIDER,
): LocalWebSearchProviderValue {
  return getLocalWebSearchProviderFromProviderOptions(options, fallback);
}

export function getWorkspaceWebSearchContextSize(
  options: WorkspaceProviderOptions | undefined,
  fallback: WebSearchContextSizeValue = "medium",
): WebSearchContextSizeValue {
  return options?.["codex-cli"]?.webSearch?.contextSize ?? fallback;
}

export function getWorkspaceWebSearchAllowedDomains(
  options: WorkspaceProviderOptions | undefined,
): string[] {
  return [...(options?.["codex-cli"]?.webSearch?.allowedDomains ?? [])];
}

export function getWorkspaceWebSearchLocation(
  options: WorkspaceProviderOptions | undefined,
): CodexWebSearchLocation {
  return cloneLocation(options?.["codex-cli"]?.webSearch?.location) ?? {};
}

export function hasWorkspaceWebSearchLocation(options: WorkspaceProviderOptions | undefined): boolean {
  return Object.keys(getWorkspaceWebSearchLocation(options)).length > 0;
}

export function getWorkspaceGoogleNativeWebSearchEnabled(
  options: WorkspaceProviderOptions | undefined,
  fallback = false,
): boolean {
  return getGoogleNativeWebSearchFromProviderOptions(options, fallback);
}

export function getWorkspaceGoogleReasoningEffort(
  options: WorkspaceProviderOptions | undefined,
  modelId?: string,
): GoogleReasoningEffortValue {
  const rawLevel = getGoogleThinkingLevelFromProviderOptions(options);
  const normalizedLevel = modelId ? normalizeGoogleThinkingLevelForModel(modelId, rawLevel) : rawLevel;
  return googleReasoningEffortFromThinkingLevel(normalizedLevel);
}

export function getGoogleReasoningEffortValuesForModel(
  modelId: string,
): readonly GoogleReasoningEffortValue[] {
  return listGoogleReasoningEffortValuesForModel(modelId);
}

export function listWorkspaceProviderOptionProviders(): readonly OpenAICompatibleProviderName[] {
  return OPENAI_COMPATIBLE_PROVIDER_NAMES;
}
