import { describe, expect, test } from "bun:test";

import {
  getCodexWebSearchBackendFromProviderOptions,
  getLocalWebSearchProviderFromProviderOptions,
  getGoogleNativeWebSearchFromProviderOptions,
  getGoogleThinkingLevelFromProviderOptions,
  mergeEditableOpenAiCompatibleProviderOptions,
  pickEditableOpenAiCompatibleProviderOptions,
} from "../../src/shared/openaiCompatibleOptions";

describe("OpenAI compatible provider option helpers", () => {
  test("pickEditableOpenAiCompatibleProviderOptions selects editable provider option fields", () => {
    const input = {
      openai: {
        reasoningEffort: "high",
        reasoningSummary: "detailed",
        textVerbosity: "medium",
        unsupported: true,
      },
      "codex-cli": {
        webSearchBackend: "native",
        webSearchFallbackBackend: "parallel",
        reasoningSummary: "concise",
        textVerbosity: "low",
        webSearchMode: "live",
        webSearch: {
          contextSize: "high",
          allowedDomains: [" openai.com ", "", "https://example.com/docs"],
          location: {
            country: " US ",
            city: " New York ",
            timezone: "America/New_York",
            blank: "",
          },
          unsupported: true,
        },
      },
      google: {
        nativeWebSearch: true,
        thinkingConfig: { thinkingLevel: "low" },
      },
      invalid: "value",
    };

    const picked = pickEditableOpenAiCompatibleProviderOptions(input);

    expect(picked).toEqual({
      openai: {
        reasoningEffort: "high",
        reasoningSummary: "detailed",
        textVerbosity: "medium",
      },
      "codex-cli": {
        webSearchBackend: "native",
        webSearchFallbackBackend: "parallel",
        reasoningSummary: "concise",
        textVerbosity: "low",
        webSearchMode: "live",
        webSearch: {
          contextSize: "high",
          allowedDomains: ["openai.com", "https://example.com/docs"],
          location: {
            country: "US",
            city: "New York",
            timezone: "America/New_York",
          },
        },
      },
      google: {
        nativeWebSearch: true,
        thinkingConfig: {
          thinkingLevel: "low",
        },
      },
    });
  });

  test("pickEditableOpenAiCompatibleProviderOptions returns undefined when no valid fields", () => {
    const picked = pickEditableOpenAiCompatibleProviderOptions({ random: true });
    expect(picked).toBeUndefined();
  });

  test("mergeEditableOpenAiCompatibleProviderOptions merges patch while preserving unrelated keys", () => {
    const base = {
      openai: {
        reasoningSummary: "auto",
      },
      google: {
        thinkingConfig: { includeThoughts: true },
      },
    };
    const patch = {
      openai: {
        textVerbosity: "high",
      },
      "codex-cli": {
        webSearchBackend: "exa",
        webSearchFallbackBackend: "parallel",
        reasoningSummary: "detailed",
      },
    };

    const merged = mergeEditableOpenAiCompatibleProviderOptions(base, patch);

    expect(merged).toEqual({
      openai: {
        reasoningSummary: "auto",
        textVerbosity: "high",
      },
      google: {
        thinkingConfig: { includeThoughts: true },
      },
      "codex-cli": {
        webSearchBackend: "exa",
        webSearchFallbackBackend: "parallel",
        reasoningSummary: "detailed",
      },
    });
  });

  test("mergeEditableOpenAiCompatibleProviderOptions returns undefined when patch and base are empty", () => {
    expect(mergeEditableOpenAiCompatibleProviderOptions({}, undefined)).toBeUndefined();
  });

  test("mergeEditableOpenAiCompatibleProviderOptions deep-merges codex web search fields", () => {
    const merged = mergeEditableOpenAiCompatibleProviderOptions(
      {
        "codex-cli": {
          webSearchBackend: "exa",
          reasoningSummary: "auto",
          webSearchMode: "cached",
          webSearch: {
            allowedDomains: ["openai.com"],
            location: {
              country: "US",
              region: "CA",
            },
          },
        },
      },
      {
        "codex-cli": {
          webSearchBackend: "native",
          webSearchMode: "live",
          webSearch: {
            contextSize: "high",
            location: {
              city: "San Francisco",
              timezone: "America/Los_Angeles",
            },
          },
        },
      },
    );

    expect(merged).toEqual({
      "codex-cli": {
        webSearchBackend: "native",
        reasoningSummary: "auto",
        webSearchMode: "live",
        webSearch: {
          contextSize: "high",
          allowedDomains: ["openai.com"],
          location: {
            country: "US",
            region: "CA",
            city: "San Francisco",
            timezone: "America/Los_Angeles",
          },
        },
      },
    });
  });

  test("getCodexWebSearchBackendFromProviderOptions defaults codex sessions to native", () => {
    expect(getCodexWebSearchBackendFromProviderOptions(undefined)).toBe("native");
    expect(getCodexWebSearchBackendFromProviderOptions({
      "codex-cli": {
        webSearchBackend: "exa",
      },
    })).toBe("exa");
  });

  test("getLocalWebSearchProviderFromProviderOptions resolves explicit and fallback local providers", () => {
    expect(getLocalWebSearchProviderFromProviderOptions(undefined)).toBe("exa");
    expect(getLocalWebSearchProviderFromProviderOptions({
      "codex-cli": {
        webSearchBackend: "parallel",
      },
    })).toBe("parallel");
    expect(getLocalWebSearchProviderFromProviderOptions({
      "codex-cli": {
        webSearchBackend: "native",
        webSearchFallbackBackend: "parallel",
      },
    })).toBe("parallel");
  });

  test("google provider option getters read editable Gemini tool toggles", () => {
    const providerOptions = {
      google: {
        nativeWebSearch: true,
        thinkingConfig: { thinkingLevel: "medium" },
      },
    };

    expect(getGoogleNativeWebSearchFromProviderOptions(providerOptions)).toBe(true);
    expect(getGoogleThinkingLevelFromProviderOptions(providerOptions)).toBe("medium");
  });

  test("google native web search defaults to shared native backend when unset", () => {
    expect(getGoogleNativeWebSearchFromProviderOptions({
      "codex-cli": {
        webSearchBackend: "native",
      },
    })).toBe(true);
    expect(getGoogleNativeWebSearchFromProviderOptions({
      "codex-cli": {
        webSearchBackend: "parallel",
      },
    })).toBe(false);
  });

  test("mergeEditableOpenAiCompatibleProviderOptions preserves explicit empty Gemini thinkingConfig clears", () => {
    const merged = mergeEditableOpenAiCompatibleProviderOptions(
      {
        google: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: "low",
          },
          nativeWebSearch: true,
        },
      },
      {
        google: {
          thinkingConfig: {},
        },
      },
    );

    expect(merged).toEqual({
      google: {
        thinkingConfig: {
          includeThoughts: true,
        },
        nativeWebSearch: true,
      },
    });
  });
});
