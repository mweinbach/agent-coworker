import { describe, expect, test } from "bun:test";

import {
  getCodexWebSearchBackendFromProviderOptions,
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

  test("mergeEditableOpenAiCompatibleProviderOptions deep-merges promptCaching preserving ttl", () => {
    const base = {
      "aws-bedrock-proxy": {
        reasoningEffort: "high",
        promptCaching: { enabled: true, ttl: "5m" },
      },
    };
    const patch = {
      "aws-bedrock-proxy": {
        promptCaching: { enabled: false },
      },
    };

    const merged = mergeEditableOpenAiCompatibleProviderOptions(base, patch as any);

    expect(merged).toEqual({
      "aws-bedrock-proxy": {
        reasoningEffort: "high",
        promptCaching: { enabled: false, ttl: "5m" },
      },
    });
  });

  test("mergeEditableOpenAiCompatibleProviderOptions deep-merges promptCaching preserving enabled", () => {
    const base = {
      "aws-bedrock-proxy": {
        promptCaching: { enabled: true, ttl: "5m" },
      },
    };
    const patch = {
      "aws-bedrock-proxy": {
        promptCaching: { ttl: "1h" },
      },
    };

    const merged = mergeEditableOpenAiCompatibleProviderOptions(base, patch as any);

    expect(merged).toEqual({
      "aws-bedrock-proxy": {
        promptCaching: { enabled: true, ttl: "1h" },
      },
    });
  });
});
