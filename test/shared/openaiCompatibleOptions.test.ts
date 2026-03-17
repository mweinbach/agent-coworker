import { describe, expect, test } from "bun:test";

import {
  getCodexWebSearchBackendFromProviderOptions,
  mergeEditableOpenAiCompatibleProviderOptions,
  pickEditableOpenAiCompatibleProviderOptions,
} from "../../src/shared/openaiCompatibleOptions";

describe("OpenAI compatible provider option helpers", () => {
  test("pickEditableOpenAiCompatibleProviderOptions selects only valid openai/codex fields", () => {
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
        thinkingConfig: { includeThoughts: true },
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
});
