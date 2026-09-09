import type {
  CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES,
  CodexCliProviderOptions,
  EDITABLE_PROVIDER_OPTIONS_PROVIDER_NAMES,
  GoogleProviderOptions,
  OpenAiCompatibleProviderOptions,
} from "../../../../src/shared/openaiCompatibleOptions";

export * from "../../../../src/shared/openaiCompatibleOptions";

export type EditableProviderOptionsProviderName =
  (typeof EDITABLE_PROVIDER_OPTIONS_PROVIDER_NAMES)[number];
export type CodexWebSearchContextSize = (typeof CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES)[number];
export type CodexWebSearchLocation = NonNullable<CodexCliProviderOptions["webSearch"]>["location"];
export type CodexWebSearchOptions = NonNullable<CodexCliProviderOptions["webSearch"]>;
export type OpenAiProviderOptions = OpenAiCompatibleProviderOptions;
export type LmStudioProviderOptions = NonNullable<
  import("../../../../src/shared/openaiCompatibleOptions").OpenAiCompatibleProviderOptionsByProvider["lmstudio"]
>;
export type GoogleThinkingConfig = NonNullable<GoogleProviderOptions["thinkingConfig"]>;
