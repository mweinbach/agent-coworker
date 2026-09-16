import { describe, expect, test } from "bun:test";

import {
  resolveCustomModelProviderName,
  supportsCustomModelIds,
} from "../../src/shared/customModels";
import {
  resolveModelPreferenceProviderName,
  supportsModelPreferences,
} from "../../src/shared/modelPreferences";
import type { ProviderName } from "../../src/types";

const CUSTOM_MODEL_PROVIDERS = [
  "google",
  "openai",
  "anthropic",
  "bedrock",
  "baseten",
  "together",
  "fireworks",
  "firepass",
  "nvidia",
  "minimax",
  "opencode-go",
  "opencode-zen",
  "antigravity",
] as const satisfies readonly ProviderName[];

describe("custom model provider allowlist", () => {
  test("resolves each supported provider and rejects everything else", () => {
    for (const provider of CUSTOM_MODEL_PROVIDERS) {
      expect(resolveCustomModelProviderName(provider)).toBe(provider);
      expect(supportsCustomModelIds(provider)).toBe(true);
    }

    expect(resolveCustomModelProviderName("codex-cli")).toBeNull();
    expect(resolveCustomModelProviderName("lmstudio")).toBeNull();
    expect(resolveCustomModelProviderName("chatgpt")).toBeNull();
    expect(supportsCustomModelIds("codex-cli")).toBe(false);
    expect(supportsCustomModelIds("lmstudio")).toBe(false);
  });

  test("fails closed for non-strings and untrimmed names", () => {
    expect(resolveCustomModelProviderName(null)).toBeNull();
    expect(resolveCustomModelProviderName(12)).toBeNull();
    expect(resolveCustomModelProviderName({ provider: "openai" })).toBeNull();
    expect(resolveCustomModelProviderName(" OpenAI ")).toBeNull();
    expect(resolveCustomModelProviderName("OPENAI")).toBeNull();
  });
});

describe("model preference provider allowlist", () => {
  test("includes every custom-model provider plus codex-cli", () => {
    for (const provider of CUSTOM_MODEL_PROVIDERS) {
      expect(resolveModelPreferenceProviderName(provider)).toBe(provider);
      expect(supportsModelPreferences(provider)).toBe(true);
    }

    expect(resolveModelPreferenceProviderName("codex-cli")).toBe("codex-cli");
    expect(supportsModelPreferences("codex-cli")).toBe(true);
    expect(supportsCustomModelIds("codex-cli")).toBe(false);
  });

  test("rejects local/unknown providers and non-strings", () => {
    expect(resolveModelPreferenceProviderName("lmstudio")).toBeNull();
    expect(resolveModelPreferenceProviderName("chatgpt")).toBeNull();
    expect(supportsModelPreferences("lmstudio")).toBe(false);
    expect(resolveModelPreferenceProviderName(undefined)).toBeNull();
    expect(resolveModelPreferenceProviderName(" openai ")).toBeNull();
  });
});
