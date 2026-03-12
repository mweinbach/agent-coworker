import { describe, expect, test } from "bun:test";

import {
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
        reasoningSummary: "concise",
        textVerbosity: "low",
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
        reasoningSummary: "concise",
        textVerbosity: "low",
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
        reasoningSummary: "detailed",
      },
    });
  });

  test("mergeEditableOpenAiCompatibleProviderOptions returns undefined when patch and base are empty", () => {
    expect(mergeEditableOpenAiCompatibleProviderOptions({}, undefined)).toBeUndefined();
  });
});
