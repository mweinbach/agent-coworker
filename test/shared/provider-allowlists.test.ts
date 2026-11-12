import { describe, expect, test } from "bun:test";
import {
  resolveCustomModelProviderName,
  supportsCustomModelIds,
} from "../../src/shared/customModels";
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
] as const satisfies readonly ProviderName[];

describe("custom model provider allowlist", () => {
  test("custom model allowlist resolves supported providers and fails closed on others", () => {
    for (const p of CUSTOM_MODEL_PROVIDERS) {
      expect(resolveCustomModelProviderName(p)).toBe(p);
      expect(supportsCustomModelIds(p)).toBe(true);
    }
    for (const bad of [
      "codex-cli",
      "lmstudio",
      "chatgpt",
      null,
      12,
      { provider: "openai" },
      " OpenAI ",
      "OPENAI",
    ]) {
      expect(resolveCustomModelProviderName(bad)).toBeNull();
      expect(supportsCustomModelIds(bad)).toBe(false);
    }
  });
});
