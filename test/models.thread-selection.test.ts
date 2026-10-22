import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  buildThreadReasoningOptionsPatch,
  parseThreadModelSelection,
} from "../src/models/threadReasoningOptions";

const homes: string[] = [];

function isolatedHome(): string {
  const home = path.join(import.meta.dir, `.thread-selection-${crypto.randomUUID()}`);
  homes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("parseThreadModelSelection", () => {
  test("blank input does not select a provider or model", () => {
    const home = isolatedHome();
    expect(parseThreadModelSelection(undefined, "openai", { home })).toEqual({});
    expect(parseThreadModelSelection("   ", "google", { home })).toEqual({});
  });

  test("a bare catalog id stays on the caller provider and a provider prefix switches", () => {
    const home = isolatedHome();
    expect(parseThreadModelSelection("  gpt-5.5  ", "openai", { home })).toEqual({
      model: "gpt-5.5",
    });
    expect(
      parseThreadModelSelection(" google:gemini-3.1-pro-preview ", "openai", { home }),
    ).toEqual({
      provider: "google",
      model: "gemini-3.1-pro-preview",
    });
    expect(parseThreadModelSelection("lmstudio:local-model", "openai", { home })).toEqual({
      provider: "lmstudio",
      model: "local-model",
    });
  });

  test("rejects an empty model id and a catalog id that belongs to another provider", () => {
    const home = isolatedHome();
    expect(() => parseThreadModelSelection("openai:", "openai", { home })).toThrow(
      'Unsupported thread model "openai:". Expected provider:modelId.',
    );
    expect(() => parseThreadModelSelection("gpt-5.5", "google", { home })).toThrow(
      'Unsupported thread model "gpt-5.5" for provider google.',
    );
    expect(() => parseThreadModelSelection("google:gpt-5.5", "google", { home })).toThrow(
      'Unsupported thread model "gpt-5.5" for provider google.',
    );
  });

  test("an unknown provider token is not an explicit provider switch", () => {
    const home = isolatedHome();
    expect(parseThreadModelSelection("not-a-provider:custom-model", "openai", { home })).toEqual({
      model: "not-a-provider:custom-model",
    });
  });
});

describe("buildThreadReasoningOptionsPatch", () => {
  test("blank thinking does not patch, including providers that cannot take reasoning overrides", () => {
    const home = isolatedHome();
    expect(
      buildThreadReasoningOptionsPatch({
        provider: "anthropic",
        model: "unused",
        thinking: " \n ",
        home,
      }),
    ).toBeUndefined();
  });

  test("rejects reasoning overrides for providers that have no thinking control", () => {
    const home = isolatedHome();
    expect(() =>
      buildThreadReasoningOptionsPatch({
        provider: "anthropic",
        model: "unused",
        thinking: "high",
        home,
      }),
    ).toThrow("Reasoning/thinking overrides are not supported for provider anthropic");
  });

  test("rejects a syntactically invalid effort before consulting the model catalog", () => {
    const home = isolatedHome();
    expect(() =>
      buildThreadReasoningOptionsPatch({
        provider: "openai",
        model: "gpt-5.5",
        thinking: "turbo",
        home,
      }),
    ).toThrow("Unsupported reasoning effort for openai: turbo");
  });

  test("merges a Google thinking level without dropping sibling Google settings", () => {
    const home = isolatedHome();
    const current = {
      google: {
        nativeWebSearch: true,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingLevel: "low" as const },
      },
      openai: { reasoningEffort: "low" as const },
    };
    expect(
      buildThreadReasoningOptionsPatch({
        provider: "google",
        model: "gemini-3.1-pro-preview",
        thinking: "  high  ",
        current,
        home,
      }),
    ).toEqual({
      google: {
        nativeWebSearch: true,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingLevel: "high" },
      },
    });
    expect(current.google.thinkingConfig.thinkingLevel).toBe("low");
    expect(current.openai.reasoningEffort).toBe("low");
  });

  test("rejects the dynamic sentinel and a differently cased thinking level", () => {
    const home = isolatedHome();
    expect(() =>
      buildThreadReasoningOptionsPatch({
        provider: "google",
        model: "gemini-3.1-pro-preview",
        thinking: "dynamic",
        home,
      }),
    ).toThrow("Unsupported Google thinking level: dynamic");
    expect(() =>
      buildThreadReasoningOptionsPatch({
        provider: "google",
        model: "gemini-3.1-pro-preview",
        thinking: "HIGH",
        home,
      }),
    ).toThrow("Unsupported Google thinking level: HIGH");
  });
});
