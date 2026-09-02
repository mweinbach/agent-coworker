import { describe, expect, test } from "bun:test";
import {
  defaultModelForProvider,
  getProviderKeyCandidates,
  PROVIDER_MODEL_CATALOG,
} from "../../src/providers";
import { PROVIDER_NAMES } from "../../src/types";

describe("provider catalog and credential candidates", () => {
  test.each(PROVIDER_NAMES)("%s retains its catalog default", (provider) => {
    expect(defaultModelForProvider(provider)).toBe(PROVIDER_MODEL_CATALOG[provider].defaultModel);
  });

  test.each([
    ["anthropic", ["anthropic"]],
    ["bedrock", ["bedrock"]],
    ["baseten", ["baseten"]],
    ["together", ["together"]],
    ["fireworks", ["fireworks"]],
    ["firepass", ["firepass"]],
    ["nvidia", ["nvidia"]],
    ["lmstudio", ["lmstudio"]],
    ["minimax", ["minimax"]],
    ["opencode-go", ["opencode-go"]],
    ["opencode-zen", ["opencode-zen"]],
    ["codex-cli", []],
    ["google", ["google"]],
    ["openai", ["openai"]],
    ["antigravity", ["antigravity", "google"]],
  ] as const)("%s retains credential candidate order", (provider, candidates) => {
    expect(getProviderKeyCandidates(provider)).toEqual(candidates);
  });
});
