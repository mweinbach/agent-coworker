import type {
  CodexCliProviderOptions,
  CodexWebSearchBackend,
  CodexWebSearchMode,
  GoogleProviderOptions,
  LocalWebSearchProvider,
  OpenAiCompatibleProviderOptions,
} from "../../../../src/shared/openaiCompatibleOptions";
import {
  CODEX_WEB_SEARCH_BACKEND_VALUES,
  CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES,
  CODEX_WEB_SEARCH_MODE_VALUES,
  type EDITABLE_PROVIDER_OPTIONS_PROVIDER_NAMES,
  LOCAL_WEB_SEARCH_PROVIDER_VALUES,
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

export function isCodexWebSearchMode(value: unknown): value is CodexWebSearchMode {
  return (
    typeof value === "string" && (CODEX_WEB_SEARCH_MODE_VALUES as readonly string[]).includes(value)
  );
}

export function isCodexWebSearchBackend(value: unknown): value is CodexWebSearchBackend {
  return (
    typeof value === "string" &&
    (CODEX_WEB_SEARCH_BACKEND_VALUES as readonly string[]).includes(value)
  );
}

export function isLocalWebSearchProvider(value: unknown): value is LocalWebSearchProvider {
  return (
    typeof value === "string" &&
    (LOCAL_WEB_SEARCH_PROVIDER_VALUES as readonly string[]).includes(value)
  );
}

export function isCodexWebSearchContextSize(value: unknown): value is CodexWebSearchContextSize {
  return (
    typeof value === "string" &&
    (CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES as readonly string[]).includes(value)
  );
}
