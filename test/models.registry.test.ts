import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MODEL_REGISTRY_ENTRIES,
  defaultSupportedModel,
  listSupportedModels,
  getSupportedModel,
  assertSupportedModel,
  supportsImageInput,
  providerOptionsDefaultsForModel,
} from "../src/models/registry";
import { listMissingChildAgentModelInfo } from "../src/models/childAgentModelInfo";
import { isUserFacingProviderEnabled } from "../src/providers/catalog";
import type { ProviderName } from "../src/types";

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

describe("model registry invariants", () => {
  test("every provider has a default supported model", () => {
    for (const provider of ["google", "openai", "anthropic", "baseten", "together", "nvidia", "opencode-go", "opencode-zen", "openai-proxy", "codex-cli"] as ProviderName[]) {
      const models = listSupportedModels(provider);
      expect(models.length).toBeGreaterThan(0);
      expect(defaultSupportedModel(provider).provider).toBe(provider);
    }
  });

  test("every model entry has display metadata and a prompt template that exists", () => {
    const root = repoRoot();
    for (const model of MODEL_REGISTRY_ENTRIES) {
      expect(model.displayName.length).toBeGreaterThan(0);
      expect(model.knowledgeCutoff.length).toBeGreaterThan(0);
      expect(
        fs.existsSync(path.join(root, "prompts", model.promptTemplate)),
        `${model.provider}:${model.id} -> prompts/${model.promptTemplate}`,
      ).toBe(true);
    }
  });

  test("each provider has exactly one default model", () => {
    const seenDefaults = new Map<ProviderName, number>();
    for (const model of MODEL_REGISTRY_ENTRIES) {
      if (!model.isDefault) continue;
      seenDefaults.set(model.provider, (seenDefaults.get(model.provider) ?? 0) + 1);
    }

    for (const provider of ["google", "openai", "anthropic", "baseten", "together", "nvidia", "opencode-go", "opencode-zen", "openai-proxy", "codex-cli"] as ProviderName[]) {
      expect(seenDefaults.get(provider)).toBe(1);
    }
  });
});

describe("model registry helpers", () => {
  test("assertSupportedModel throws for unknown model", () => {
    expect(() => assertSupportedModel("openai", "missing-model")).toThrow(/Unsupported model/);
  });

  test("getSupportedModel returns null for unknown models", () => {
    expect(getSupportedModel("openai", "missing-model")).toBeNull();
  });

  test("supportsImageInput is false when the model is unknown", () => {
    expect(supportsImageInput("google", "missing-model")).toBe(false);
  });

  test("providerOptionsDefaultsForModel returns an empty object for unknown models", () => {
    expect(providerOptionsDefaultsForModel("anthropic", "missing-model")).toEqual({});
  });

  test("every user-facing model has child-agent guidance metadata", () => {
    const userFacingProviders = (
      ["google", "openai", "anthropic", "baseten", "together", "nvidia", "opencode-go", "opencode-zen", "openai-proxy", "codex-cli"] as ProviderName[]
    ).filter((provider) => isUserFacingProviderEnabled(provider));
    expect(listMissingChildAgentModelInfo(userFacingProviders)).toEqual([]);
  });
});
