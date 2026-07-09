import { describe, expect, test } from "bun:test";

import {
  buildThreadReasoningOptionsPatch,
  parseThreadModelSelection,
} from "../src/models/threadReasoningOptions";

describe("parseThreadModelSelection", () => {
  test("returns no override for empty input", () => {
    expect(parseThreadModelSelection(undefined, "openai")).toEqual({});
    expect(parseThreadModelSelection("   ", "google")).toEqual({});
  });

  test("keeps bare model ids on the current provider", () => {
    expect(parseThreadModelSelection(" gpt-5.2 ", "openai")).toEqual({
      model: "gpt-5.2",
    });
  });

  test("returns explicit provider overrides for provider-qualified models", () => {
    expect(parseThreadModelSelection("google:gemini-3.1-pro-preview", "openai")).toEqual({
      provider: "google",
      model: "gemini-3.1-pro-preview",
    });
  });

  test("treats unknown provider prefixes as part of the model id for the default provider", () => {
    expect(parseThreadModelSelection("amazon.nova-lite-v1:0", "bedrock")).toEqual({
      model: "amazon.nova-lite-v1:0",
    });
  });
});

describe("buildThreadReasoningOptionsPatch", () => {
  test("returns no patch for empty thinking input", () => {
    expect(
      buildThreadReasoningOptionsPatch({
        provider: "openai",
        model: "gpt-5.2",
        thinking: "   ",
      }),
    ).toBeUndefined();
  });

  test("sets OpenAI reasoning effort without dropping sibling options", () => {
    expect(
      buildThreadReasoningOptionsPatch({
        provider: "openai",
        model: "gpt-5.2",
        thinking: "high",
        current: {
          openai: {
            reasoningSummary: "detailed",
            textVerbosity: "low",
          },
        },
      }),
    ).toEqual({
      openai: {
        reasoningEffort: "high",
        reasoningSummary: "detailed",
        textVerbosity: "low",
      },
    });
  });

  test("sets Codex reasoning effort without dropping web search options", () => {
    expect(
      buildThreadReasoningOptionsPatch({
        provider: "codex-cli",
        model: "gpt-5.3-codex-spark",
        thinking: "xhigh",
        current: {
          "codex-cli": {
            webSearchBackend: "exa",
            webSearchMode: "cached",
          },
        },
      }),
    ).toEqual({
      "codex-cli": {
        reasoningEffort: "xhigh",
        webSearchBackend: "exa",
        webSearchMode: "cached",
      },
    });
  });

  test("sets Google thinking level without dropping sibling options", () => {
    expect(
      buildThreadReasoningOptionsPatch({
        provider: "google",
        model: "gemini-3.1-pro-preview",
        thinking: "medium",
        current: {
          google: {
            nativeWebSearch: true,
            responseMimeType: "application/json",
            thinkingConfig: {
              thinkingLevel: "low",
            },
          },
        },
      }),
    ).toEqual({
      google: {
        nativeWebSearch: true,
        responseMimeType: "application/json",
        thinkingConfig: {
          thinkingLevel: "medium",
        },
      },
    });
  });

  test("rejects unsupported reasoning values before thread creation continues", () => {
    expect(() =>
      buildThreadReasoningOptionsPatch({
        provider: "openai",
        model: "gpt-5.2",
        thinking: "dynamic",
      }),
    ).toThrow("Unsupported reasoning effort for openai: dynamic");

    expect(() =>
      buildThreadReasoningOptionsPatch({
        provider: "google",
        model: "gemini-3.1-pro-preview",
        thinking: "dynamic",
      }),
    ).toThrow("Unsupported Google thinking level: dynamic");
  });

  test("rejects providers that do not support thinking overrides", () => {
    expect(() =>
      buildThreadReasoningOptionsPatch({
        provider: "lmstudio",
        model: "local-model",
        thinking: "high",
      }),
    ).toThrow("Reasoning/thinking overrides are not supported for provider lmstudio");
  });
});
